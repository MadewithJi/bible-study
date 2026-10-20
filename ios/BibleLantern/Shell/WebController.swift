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
    /// Why the page cannot be used, for the native error view and its Try again.
    struct Failure: Equatable {
        var title: String
        var detail: String
    }

    @Published private(set) var page = PageState()
    /// The page's bridge said `ready`: `BL.*` calls run at once (before that they wait, and `ready` replays them).
    @Published private(set) var ready = false
    @Published private(set) var failed: Failure? = nil
    /// The page has no app-shell mode (the site before the bridge is deployed): it shows as it is, with its own top
    /// bar, and the native tab bar and Read chrome step aside. A late `ready` brings them back.
    @Published private(set) var bare = false
    @Published private(set) var books: [Book] = []
    @Published private(set) var translations: [Translation] = []

    /// Neither ready, nor shown as it is, nor failed: the launch view covers the app.
    var loading: Bool { !ready && !bare && failed == nil }

    let webView: WKWebView
    private var pending: [(key: String?, js: String)] = []
    private var lastRoute: String? = nil
    private var readyWait: Task<Void, Never>? = nil
    private var reloadOnForeground = false
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var bag = Set<AnyCancellable>()
    /// Links that leave the site (Bible Gateway, YouTube, mail, a phone number): the shell opens them outside the app.
    var openExternal: ((URL) -> Void)?
    /// The page said `ready` (at launch, after Try again, after a reload): the shell re-applies what it owns.
    var onReady: (() -> Void)?
    /// An export the page made (notes, a study, a profile) is in a file: the shell offers it to the share sheet.
    var onDownload: ((URL) -> Void)?
    var onDownloadFailed: ((String) -> Void)?
    /// A sign-out ended (shell.js `signout`): whether it went through, else the page's own words for why not.
    var onSignOut: ((Bool, String) -> Void)?

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
        // off: WebKit's own history is only Home ↔ reader (chapter moves replace the entry), so a swipe would jump past
        // the chapters read; the toolbar's Back follows the page's history instead, and the tab bar has Home
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never // the page insets itself from env(safe-area-inset-*) (ios-brief §6)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #if DEBUG
        webView.isInspectable = true
        #endif
        try? FileManager.default.removeItem(at: Self.exports) // last session's exports, long since shared or saved
        NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)
            .sink { [weak self] _ in self?.foreground() }.store(in: &bag)
        load()
    }

    /// Load the page where the reader was: the last place the page reported (its `#b/c/v` hash, on the site), else
    /// Home. Try again and the content process's restart come here, so the chapter and verse come back (the study
    /// sheet does not on a phone: the page opens it from a verse in the URL only in the side layout).
    func load(at url: URL? = nil) {
        failed = nil
        ready = false
        bare = false
        reloadOnForeground = false
        readyWait?.cancel()
        let target = url ?? resumeURL
        // the same document at another hash would only scroll (WebKit's fragment navigation: no load, no `didFinish`),
        // so the page reloads itself there and boots afresh; a dead or foreign page cannot, and loads it plainly
        if let current = webView.url, sameDocument(current, target) {
            let js = "(function(){ history.replaceState(null, '', \(jsString(target.absoluteString))); location.reload(); return true; })()"
            webView.evaluateJavaScript(js) { [weak self] _, error in
                if error != nil { self?.webView.load(URLRequest(url: target, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30)) }
            }
            return
        }
        webView.load(URLRequest(url: target, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    /// Whether two URLs name one document (all but the hash, as WebKit compares them: `https://host?q` is `https://host/?q`).
    private func sameDocument(_ a: URL, _ b: URL) -> Bool {
        func stem(_ u: URL) -> String? {
            guard var c = URLComponents(url: u, resolvingAgainstBaseURL: true) else { return nil }
            c.fragment = nil
            c.scheme = c.scheme?.lowercased(); c.host = c.host?.lowercased()
            if c.path.isEmpty { c.path = "/" }
            return c.string
        }
        guard let x = stem(a) else { return false }
        return x == stem(b)
    }

    private var resumeURL: URL {
        if let u = URL(string: page.url), ["http", "https"].contains(u.scheme?.lowercased() ?? ""),
           let h = u.host?.lowercased(), Site.hosts.contains(h) { return u }
        return Site.start
    }

    /// The load finished. A page without app-shell mode shows as it is at once (index.html sets html.app-shell before
    /// the first paint, so waiting cannot change it). An app-shell page has 15 s to say `ready`: boot waits up to
    /// BOOT_CAP (6 s) for the server before it loads shell.js. Past that the class decides again: none, the page
    /// shows as it is; there, the bridge failed and the native error offers Try again. Calls keep waiting either way,
    /// and a late `ready` replays them and clears both states.
    private func loadFinished() {
        bridgeLog.info("load finished: \(self.webView.url?.absoluteString ?? "", privacy: .public) ready=\(self.ready)")
        guard !ready, failed == nil else { return }
        readyWait?.cancel()
        readyWait = Task { [weak self] in
            if let self, await self.appShell() == false, !Task.isCancelled, !self.ready { self.goBare(); return }
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled, !self.ready, !self.bare, self.failed == nil else { return }
            let shell = await self.appShell()
            guard !Task.isCancelled, !self.ready, self.failed == nil else { return }
            if shell == false { self.goBare(); return }
            bridgeLog.warning("the page never reported ready")
            self.fail(Failure(title: "The page didn’t finish starting.", detail: "It loaded but didn’t connect to the app."))
        }
    }

    /// Whether the page is in app-shell mode (nil: it did not answer).
    private func appShell() async -> Bool? {
        await withCheckedContinuation { cont in
            webView.evaluateJavaScript("document.documentElement.classList.contains('app-shell')") { value, _ in cont.resume(returning: value as? Bool) }
        }
    }

    private func goBare() {
        bridgeLog.warning("the page has no app-shell mode (a site without the bridge): showing it as it is")
        bare = true
    }

    private func fail(_ f: Failure) {
        readyWait?.cancel()
        bare = false
        failed = f
    }

    private func foreground() {
        if reloadOnForeground { load() }
    }

    // MARK: - requests to the page (every one is a plain `BL.*` call; before `ready` they wait)

    /// Run a statement in the page once it is ready. While it waits, a newer call of the same kind replaces the older
    /// (only the last tab, size or translation chosen matters); nothing else is dropped.
    func call(_ js: String, key: String? = nil) {
        guard ready else {
            if let key { pending.removeAll { $0.key == key } }
            pending.append((key, js))
            return
        }
        webView.evaluateJavaScript("(function(){ try { return window.BL ? (\(js)) : null; } catch (e) { return String(e); } })()") { _, error in
            if let error { bridgeLog.error("call failed: \(js, privacy: .public): \(error.localizedDescription, privacy: .public)") }
        }
    }
    /// Ask the page for a JSON value.
    private func ask<T: Decodable & Sendable>(_ js: String, as type: T.Type) async -> T? {
        guard ready else { return nil }
        let wrapped = "(function(){ try { return JSON.stringify(\(js)) || ''; } catch (e) { return ''; } })()"
        return await withCheckedContinuation { cont in
            webView.evaluateJavaScript(wrapped) { value, _ in
                guard let s = value as? String, let data = s.data(using: .utf8), !s.isEmpty else { cont.resume(returning: nil); return }
                cont.resume(returning: try? JSONDecoder().decode(T.self, from: data))
            }
        }
    }

    func open(_ route: String) { call("BL.open(\(jsString(route)))", key: "open") }
    func panel(_ name: String) { call("BL.panel(\(jsString(name)))", key: "panel") }
    func search(_ query: String) { call("BL.search(\(jsString(query)))", key: "search") }
    func step(_ dir: Int) { call("BL.step(\(dir < 0 ? -1 : 1))") }
    func stepVerse(_ dir: Int) { call("BL.stepVerse(\(dir < 0 ? -1 : 1))") }
    /// The page's own Back: the chapter read before this one (`canBack` says when there is one).
    func back() { call("BL.back ? BL.back() : false") }
    func setTranslation(_ id: String, parallel: Bool = false) { call("BL.setTranslation(\(jsString(id)), \(jsString(parallel ? "tr2" : "tr")))", key: parallel ? "tr2" : "tr") }
    func setFontSize(_ px: Int) { call("BL.setFontSize(\(max(12, min(32, px))))", key: "font") }
    func setTheme(_ theme: String) { call("BL.setTheme(\(jsString(theme)))", key: "theme") }
    func setOrig(_ on: Bool) { call("BL.setOrig(\(on ? "true" : "false"))", key: "orig") }
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
        switch type {
        case "ready", "state", "signout": break
        case "failed":
            // main.js's boot() stopped (shell.js may never have loaded): the body is only the message
            let message = (dict["message"] as? String) ?? ""
            bridgeLog.error("the page did not start: \(message, privacy: .public)")
            fail(Failure(title: "The page didn’t finish starting.", detail: "It stopped while it was loading.")) // its words are a developer’s: the log has them
            return
        default:
            bridgeLog.error("unknown message: \(type, privacy: .public)")
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { bridgeLog.error("message is not JSON: \(type, privacy: .public)"); return }
        let state: PageState
        do { state = try JSONDecoder().decode(PageState.self, from: data) }
        catch { bridgeLog.error("message \(type, privacy: .public) did not decode: \(String(describing: error), privacy: .public)"); return }
        bridgeLog.info("\(type, privacy: .public): \(state.label, privacy: .public) home=\(state.home) overlays=\(state.overlays.joined(separator: ","), privacy: .public)")
        page = state
        if type == "ready" {
            readyWait?.cancel()
            ready = true
            bare = false
            failed = nil
            let queued = pending; pending = []
            queued.forEach { call($0.js) }
            Task { await refreshLists() }
            if let route = lastRoute { lastRoute = nil; open(route) }
            onReady?()
        }
        if type == "signout" { onSignOut?((dict["ok"] as? Bool) ?? true, (dict["note"] as? String) ?? "") }
        if translations.isEmpty, type == "state" { Task { await refreshLists() } }
    }

    /// A universal link or the custom scheme, before or after the page is ready. Before, a chapter link loads the
    /// page there, so the first paint is the chapter rather than Home (and a page without the bridge lands there too).
    func openLater(_ route: String) {
        if ready { open(route); return }
        if route.range(of: #"^\d+/\d+(/\d+)?$"#, options: .regularExpression) != nil,
           let u = URL(string: "?app=ios#\(route)", relativeTo: Site.base)?.absoluteURL {
            lastRoute = nil
            load(at: u)
            return
        }
        lastRoute = route
    }

    /// The temporary folder exports are written to before the share sheet takes them.
    private static var exports: URL { FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true) }
}

// MARK: - navigation policy (ios-brief §1: the site stays in the app, other sites open outside)

extension WebController: WKNavigationDelegate, WKUIDelegate {
    /// Only http(s) on the site's hosts stays in the web view (and the page's own about:, blob:, data:, javascript:);
    /// any other site, and mailto:, tel:, sms:, facetime:, itms-apps:, go to Safari, Mail, Phone, Messages, the App Store.
    private func stays(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        switch scheme {
        case "about", "blob", "data", "javascript": return true
        case "http", "https": return url.host.map { Site.hosts.contains($0.lowercased()) } ?? false
        default: return false
        }
    }

    // WebKit calls its delegates on the main thread: assumeIsolated keeps the decisions synchronous
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            guard let url = action.request.url else { decisionHandler(.allow); return }
            let main = action.targetFrame?.isMainFrame ?? true
            // an export (a link with `download`, a blob or data URL): a file for the share sheet, never the page replaced by it
            let scheme = url.scheme?.lowercased() ?? ""
            if action.shouldPerformDownload || (main && (scheme == "blob" || scheme == "data")) { decisionHandler(.download); return }
            // frames inside the page (Cloudflare Turnstile, a video) load as they are
            if !main { decisionHandler(.allow); return }
            if stays(url) { decisionHandler(.allow); return }
            // nothing is on screen yet, so no reader chose this: the site sent the app away (a redirect off its hosts),
            // and the error says so before the cancel's own failure arrives
            if loading {
                bridgeLog.error("the site sent the app to \(url.absoluteString, privacy: .public)")
                fail(Failure(title: "Can’t reach biblelantern.com right now.", detail: "The site sent the app to another address. Try again in a moment."))
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
            openExternal?(url)
        }
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        MainActor.assumeIsolated {
            guard response.isForMainFrame else { decisionHandler(.allow); return }
            // a file the web view cannot show: an export, not a failed load; while nothing is on screen it is the site
            // answering the app's own load with a file instead of the page
            if !response.canShowMIMEType {
                if loading {
                    bridgeLog.error("the site answered with a file: \(response.response.mimeType ?? "", privacy: .public)")
                    fail(Failure(title: "Can’t reach biblelantern.com right now.", detail: "The site sent a file instead of the page. Try again in a moment."))
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.download)
                return
            }
            // the site's own error page (a 404, a 503 while it redeploys) is not the app: the native error and Try again
            if !ready, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                bridgeLog.error("the site answered \(http.statusCode) for \(http.url?.absoluteString ?? "", privacy: .public)")
                fail(Failure(title: "biblelantern.com answered with an error.", detail: "Error \(http.statusCode). The site may be updating: try again in a moment."))
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }

    nonisolated func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { MainActor.assumeIsolated { download.delegate = self } }
    nonisolated func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { MainActor.assumeIsolated { download.delegate = self } }

    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target="_blank" (a translation that opens another website, a video on YouTube): outside the app
        MainActor.assumeIsolated { if let url = action.request.url { openExternal?(url) } }
        return nil
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { MainActor.assumeIsolated { documentChanged() } }
    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { MainActor.assumeIsolated { loadFinished() } }
    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { MainActor.assumeIsolated { note(error) } }
    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { MainActor.assumeIsolated { note(error) } }
    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { MainActor.assumeIsolated { processEnded() } }

    /// A new document in the main frame (a load, or the page's own reload): the old bridge went with the old one, so
    /// calls wait for the new `ready`.
    private func documentChanged() {
        if ready { bridgeLog.info("a new document: waiting for its ready") }
        ready = false
        bare = false
        readyWait?.cancel()
    }

    /// The content process died (iOS ends it under memory pressure, often in the background): the page again where
    /// the reader was, at once or when the app comes back to the front. Waiting calls and a link stay queued.
    private func processEnded() {
        bridgeLog.warning("the web content process ended")
        if UIApplication.shared.applicationState == .background {
            ready = false
            readyWait?.cancel()
            reloadOnForeground = true
        } else {
            load()
        }
    }

    private func note(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return } // a cancelled external link, a load replaced by another
        // "frame load interrupted": the app's own policy stopped the load (an export, or an error page, a redirect or a
        // file it turned away, each of which has said why); while nothing is on screen it is a load that went nowhere
        if e.domain == "WebKitErrorDomain" && e.code == 102 {
            guard loading else { return }
            bridgeLog.error("the load was interrupted: \(self.webView.url?.absoluteString ?? "", privacy: .public)")
            fail(Failure(title: "Can’t reach biblelantern.com right now.", detail: "The page didn’t load. Try again in a moment."))
            return
        }
        guard !ready, failed == nil else { return }
        fail(Failure(title: "Can’t reach biblelantern.com right now.", detail: e.localizedDescription))
    }
}

// MARK: - exports (the page's notes, study and profile downloads): a file in a temporary folder, then the share sheet

extension WebController: WKDownloadDelegate {
    nonisolated func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        MainActor.assumeIsolated {
            // a folder per export, so the page's own file name survives into Files and two exports never collide
            let dir = Self.exports.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
            catch { bridgeLog.error("no folder for an export: \(error.localizedDescription, privacy: .public)"); completionHandler(nil); return }
            let name = (suggestedFilename as NSString).lastPathComponent
            let url = dir.appendingPathComponent(name.isEmpty ? "Bible Lantern export" : name)
            downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
    }

    nonisolated func downloadDidFinish(_ download: WKDownload) {
        MainActor.assumeIsolated {
            guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            bridgeLog.info("export saved: \(url.lastPathComponent, privacy: .public)")
            onDownload?(url)
        }
    }

    nonisolated func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        MainActor.assumeIsolated {
            downloads.removeValue(forKey: ObjectIdentifier(download))
            bridgeLog.error("export failed: \(error.localizedDescription, privacy: .public)")
            onDownloadFailed?(error.localizedDescription)
        }
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
