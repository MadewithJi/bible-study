import SwiftUI
import Combine
import UIKit

/// The app's own state: the tab, the sheets, and how the page's reports move the tab (ios-brief §1).
@MainActor
final class AppModel: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable {
        case home, read, study, library, profile
        var id: String { rawValue }
        var title: String {
            switch self {
            case .home: return "Home"
            case .read: return "Read"
            case .study: return "Study"
            case .library: return "Library"
            case .profile: return "Profile"
            }
        }
        var symbol: String {
            switch self {
            case .home: return "house"
            case .read: return "book"
            case .study: return "highlighter"
            case .library: return "books.vertical"
            case .profile: return "person.crop.circle"
            }
        }
    }

    @Published var tab: Tab = .home
    @Published var showPicker = false
    @Published var showSearch = false
    @Published var showExplore = false
    @Published var shareItems: [Any]? = nil
    /// Something the reader should hear about that the page cannot show where they are looking: an export that did
    /// not reach a file, a sign-out the page refused (its toast sits under the native Profile tab).
    struct Notice { var title: String; var message: String }
    @Published var notice: Notice? = nil
    /// "Use the system text size": Dynamic Type sets the reading size (ios-brief §1); off keeps the page's own setting.
    @Published var followDynamicType: Bool = UserDefaults.standard.bool(forKey: "bl.followDynamicType") {
        didSet {
            UserDefaults.standard.set(followDynamicType, forKey: "bl.followDynamicType")
            if followDynamicType && !oldValue { applyDynamicType() }
        }
    }
    /// The system text size (RootView passes it in at launch and on every change).
    var systemSize: DynamicTypeSize = .large {
        didSet { if systemSize != oldValue { applyDynamicType() } }
    }

    let web = WebController()
    private var bag = Set<AnyCancellable>()
    private let haptic = UISelectionFeedbackGenerator()
    /// The tab the reader just chose (or a link opened), until the page's reports agree with it.
    private var wanted: Tab? = nil
    private var wantedExpiry: Task<Void, Never>? = nil

    init() {
        web.openExternal = { url in
            UIApplication.shared.open(url, options: [:]) { ok in
                if !ok { bridgeLog.warning("nothing could open \(url.absoluteString, privacy: .public)") }
            }
        }
        web.onReady = { [weak self] in self?.pageReady() }
        web.onDownload = { [weak self] url in self?.shareItems = [url] } // the share sheet offers Save to Files
        web.onDownloadFailed = { [weak self] message in self?.notice = Notice(title: "The file wasn’t saved", message: message) }
        web.onSignOut = { [weak self] ok, note in if !ok { self?.notice = Notice(title: "Still signed in", message: note) } }
        // the web controller's changes (the page's state, ready, the lists) redraw the views that watch the model
        web.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        web.$page.removeDuplicates().sink { [weak self] p in self?.follow(p) }.store(in: &bag)
        // a page without the bridge hides the tab bar: Profile would be a dead end, so the page shows instead
        web.$bare.removeDuplicates().sink { [weak self] bare in if bare, self?.tab == .profile { self?.tab = .home } }.store(in: &bag)
    }

    /// A link that leaves the site (privacy, Bible Gateway): Safari.
    func open(_ url: URL) { UIApplication.shared.open(url) }

    var page: PageState { web.page }
    var colorScheme: ColorScheme? {
        switch page.theme {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }

    /// The tab bar's selection: a tap moves the page to that tab (Profile is native and leaves the page where it is);
    /// the page's own navigation sets `tab` directly (follow) and the bar follows.
    var tabSelection: Binding<Tab> { Binding(get: { self.tab }, set: { self.select($0) }) }

    func select(_ t: Tab) {
        guard t != tab else { return }
        haptic.selectionChanged()
        tab = t
        switch t {
        case .home, .read, .study, .library: expect(t); web.open(t.rawValue)
        case .profile: wanted = nil
        }
    }

    /// Something in the page itself that must show the page (the Profile dialog, Settings): the content tab first.
    func openInPage(_ route: String) {
        if tab == .profile { let t: Tab = page.home ? .home : .read; tab = t; expect(t) }
        web.open(route)
    }

    /// The page's own navigation moves the tab: a Home link, the Library closing, a verse opened from a study. Right
    /// after the reader chose a tab, a report that disagrees is one the page sent on its way there (the Library still
    /// fading out, Home's hash change in flight) and waits for one that agrees.
    private func follow(_ p: PageState) {
        guard tab != .profile else { return }
        if let w = wanted {
            guard agrees(p, w) else { bridgeLog.info("a report on the way to \(w.rawValue, privacy: .public): the tab waits"); return }
            wanted = nil; wantedExpiry?.cancel(); wantedExpiry = nil
        }
        if p.libraryOpen { if tab != .study && tab != .library { tab = .library } }
        else { tab = p.home ? .home : .read }
    }

    private func agrees(_ p: PageState, _ t: Tab) -> Bool {
        switch t {
        case .study, .library: return p.libraryOpen
        case .home: return p.home && !p.libraryOpen
        case .read, .profile: return !p.home && !p.libraryOpen
        }
    }

    /// Wait for the page to reach `t`: a second after the request has reached the page (at once if it is ready, else at
    /// `ready`, which replays it), the page's last report decides again, so a request that did nothing cannot hold the tab.
    private func expect(_ t: Tab) {
        wanted = t
        wantedExpiry?.cancel(); wantedExpiry = nil
        if web.ready { armExpiry() }
    }

    private func armExpiry() {
        wantedExpiry?.cancel()
        wantedExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled, self.wanted != nil else { return }
            self.wanted = nil
            if self.web.ready { self.follow(self.page) }
        }
    }

    /// The page said `ready` (launch, Try again, a reload): a request waiting for it has gone in now, and the system
    /// text size applies again if the reader follows it.
    private func pageReady() {
        if wanted != nil { armExpiry() }
        applyDynamicType()
    }

    /// A universal link (biblelantern.com/#43/3/16) or the app's scheme (biblelantern://43/3/16).
    func handle(_ url: URL) {
        var route = ""
        if url.scheme?.lowercased() == "biblelantern" {
            route = ((url.host ?? "") + url.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else if let f = url.fragment, !f.isEmpty {
            route = f
        }
        if route.isEmpty || route == "home" { tab = .home; expect(.home); web.openLater("home"); return }
        tab = .read
        expect(.read)
        web.openLater(route)
    }

    func share() {
        Task {
            guard let s = await web.shareText(), let url = URL(string: s.url) else { return }
            let line = s.text.isEmpty ? s.title : "\(s.title) — \(s.text)"
            shareItems = [line, url]
        }
    }

    /// Dynamic Type → the page's reading size (12–32px), only when the reader asked for it. The default size gives the
    /// page's own phone default (19px).
    func applyDynamicType() {
        guard followDynamicType else { return }
        let px: Int
        switch systemSize {
        case .xSmall: px = 15
        case .small: px = 16
        case .medium: px = 17
        case .large: px = 19
        case .xLarge: px = 21
        case .xxLarge: px = 23
        case .xxxLarge: px = 25
        case .accessibility1: px = 27
        case .accessibility2: px = 29
        default: px = 32
        }
        web.setFontSize(px)
    }
}
