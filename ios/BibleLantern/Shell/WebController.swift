import WebKit
import Combine
import UIKit
import OSLog

let bridgeLog = Logger(subsystem: "com.biblelantern.app", category: "bridge")

/// Owns the one web view the whole app shows, speaks to the page through `window.BL` (shell.js) and hears the
/// page's `state` messages. The web view is created once and kept for the life of the app: the site's session cookie
/// lives in the default (persistent) data store, so a sign-in sticks between launches (ios-brief §1).
@MainActor
final class WebController: NSObject, ObservableObject {
    @Published private(set) var page = PageState()
    @Published private(set) var ready = false
    @Published private(set) var failed: String? = nil
    /// The page loaded but never said `ready` (a site without the bridge): it shows as it is, with its own top bar.
    @Published private(set) var degraded = false
    @Published private(set) var books: [Book] = []
    @Published private(set) var translations: [Translation] = []

    let webView: WKWebView
    private var pending: [String] = []
    private var lastRoute: String? = nil
    private var readyTimer: Timer? = nil
    /// Links that leave the site (Bible Gateway, Buy Me a Coffee, mail): the shell opens them outside the app.
    var openExternal: ((URL) -> Void)?

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.applicationNameForUserAgent = Site.userAgentName
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.preferredContentMode = .mobile
        let ucc = WKUserContentController()
        cfg.userContentController = ucc
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        ucc.add(MessageRelay(self), name: "bl")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #if DEBUG
        webView.isInspectable = true
        #endif
        load()
    }

    func load() {
        failed = nil
        ready = false
        degraded = false
        readyTimer?.invalidate()
        webView.load(URLRequest(url: Site.start, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    /// The load finished: the bridge has a few seconds to say `ready`, else the page shows as it is.
    private func loadFinished() {
        bridgeLog.info("load finished: \(self.webView.url?.absoluteString ?? "", privacy: .public) ready=\(self.ready)")
        guard !ready else { return }
        readyTimer?.invalidate()
        readyTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.ready else { return }
                bridgeLog.warning("the page never reported ready; showing it without the shell bridge")
                self.degraded = true
                self.ready = true
                self.pending = []
            }
        }
    }

    // MARK: - requests to the page (every one is a plain `BL.*` call; before `ready` they wait)

    /// Run a statement in the page once it is ready.
    func call(_ js: String) {
        guard ready else { pending.append(js); return }
        webView.evaluateJavaScript("(function(){ try { return window.BL ? (\(js)) : null; } catch (e) { return String(e); } })()") { _, error in
            if let error { bridgeLog.error("call failed: \(js, privacy: .public): \(error.localizedDescription, privacy: .public)") }
        }
    }
    /// Ask the page for a JSON value.
    private func ask<T: Decodable>(_ js: String, as type: T.Type) async -> T? {
        guard ready else { return nil }
        let wrapped = "(function(){ try { return JSON.stringify(\(js)) || ''; } catch (e) { return ''; } })()"
        return await withCheckedContinuation { cont in
            webView.evaluateJavaScript(wrapped) { value, _ in
                guard let s = value as? String, let data = s.data(using: .utf8), !s.isEmpty else { cont.resume(returning: nil); return }
                cont.resume(returning: try? JSONDecoder().decode(T.self, from: data))
            }
        }
    }

    func open(_ route: String) { call("BL.open(\(jsString(route)))") }
    func panel(_ name: String) { call("BL.panel(\(jsString(name)))") }
    func search(_ query: String) { call("BL.search(\(jsString(query)))") }
    func step(_ dir: Int) { call("BL.step(\(dir < 0 ? -1 : 1))") }
    func stepVerse(_ dir: Int) { call("BL.stepVerse(\(dir < 0 ? -1 : 1))") }
    func setTranslation(_ id: String, parallel: Bool = false) { call("BL.setTranslation(\(jsString(id)), \(jsString(parallel ? "tr2" : "tr")))") }
    func setFontSize(_ px: Int) { call("BL.setFontSize(\(max(12, min(32, px))))") }
    func setTheme(_ theme: String) { call("BL.setTheme(\(jsString(theme)))") }
    func setOrig(_ on: Bool) { call("BL.setOrig(\(on ? "true" : "false"))") }
    func closeOverlays() { call("BL.closeOverlays()") }
    func signOut() { call("BL.signOut()") }
    func shareText() async -> ShareText? { await ask("BL.share()", as: ShareText.self) }

    private func refreshLists() async {
        if let b: [Book] = await ask("BL.books()", as: [Book].self), !b.isEmpty { books = b }
        if let t: [Translation] = await ask("BL.translations()", as: [Translation].self), !t.isEmpty { translations = t }
    }

    // MARK: - messages from the page

    fileprivate func receive(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { bridgeLog.error("message without a type: \(String(describing: body), privacy: .public)"); return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { bridgeLog.error("message is not JSON: \(type, privacy: .public)"); return }
        let state: PageState
        do { state = try JSONDecoder().decode(PageState.self, from: data) }
        catch { bridgeLog.error("message \(type, privacy: .public) did not decode: \(String(describing: error), privacy: .public)"); return }
        bridgeLog.info("\(type, privacy: .public): \(state.label, privacy: .public) home=\(state.home) overlays=\(state.overlays.joined(separator: ","), privacy: .public)")
        page = state
        if type == "ready" {
            readyTimer?.invalidate()
            ready = true
            degraded = false
            failed = nil
            let queued = pending; pending = []
            queued.forEach(call)
            Task { await refreshLists() }
            if let route = lastRoute { lastRoute = nil; open(route) }
        }
        if translations.isEmpty, type == "state" { Task { await refreshLists() } }
    }

    /// A universal link or the custom scheme, before or after the page is ready.
    func openLater(_ route: String) {
        if ready { open(route) } else { lastRoute = route }
    }
}

// MARK: - navigation policy (ios-brief §1: the site stays in the app, other sites open outside)

extension WebController: WKNavigationDelegate, WKUIDelegate {
    private func stays(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if ["about", "blob", "data", "javascript"].contains(scheme) { return true }
        guard let host = url.host?.lowercased() else { return true }
        return Site.hosts.contains(host)
    }

    // WebKit calls its delegates on the main thread: assumeIsolated keeps the decisions synchronous
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            guard let url = action.request.url else { decisionHandler(.allow); return }
            // frames inside the page (Cloudflare Turnstile, a video) load as they are
            if let frame = action.targetFrame, !frame.isMainFrame { decisionHandler(.allow); return }
            if stays(url) { decisionHandler(.allow); return }
            decisionHandler(.cancel)
            openExternal?(url)
        }
    }

    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank" (a translation that opens a website, the support link): outside the app
        MainActor.assumeIsolated { if let url = action.request.url { openExternal?(url) } }
        return nil
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { MainActor.assumeIsolated { loadFinished() } }
    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { MainActor.assumeIsolated { note(error) } }
    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { MainActor.assumeIsolated { note(error) } }
    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { MainActor.assumeIsolated { load() } }

    private func note(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return } // a cancelled external link
        if !ready { failed = e.localizedDescription }
    }
}

/// The script message handler, held weakly so the web view's content controller does not keep the controller alive.
private final class MessageRelay: NSObject, WKScriptMessageHandler {
    weak var controller: WebController?
    init(_ controller: WebController) { self.controller = controller }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        Task { @MainActor in self.controller?.receive(body) }
    }
}
