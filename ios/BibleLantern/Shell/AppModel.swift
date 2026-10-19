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
    /// "Use the system text size": Dynamic Type sets the reading size (ios-brief §1); off keeps the page's own setting.
    @Published var followDynamicType: Bool = UserDefaults.standard.bool(forKey: "bl.followDynamicType") {
        didSet { UserDefaults.standard.set(followDynamicType, forKey: "bl.followDynamicType") }
    }

    let web = WebController()
    private var bag = Set<AnyCancellable>()
    private let haptic = UISelectionFeedbackGenerator()

    init() {
        web.openExternal = { url in UIApplication.shared.open(url) }
        // the web controller's changes (the page's state, ready, the lists) redraw the views that watch the model
        web.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        web.$page.removeDuplicates().sink { [weak self] p in self?.follow(p) }.store(in: &bag)
    }

    /// A link that leaves the site (support, privacy, Bible Gateway): Safari.
    func open(_ url: URL) { UIApplication.shared.open(url) }

    var page: PageState { web.page }
    var colorScheme: ColorScheme? {
        switch page.theme {
        case "dark": return .dark
        case "light": return .light
        default: return nil
        }
    }

    /// A tab tap: the page moves to it; Profile is native and leaves the page where it is.
    func select(_ t: Tab) {
        haptic.selectionChanged()
        if t == tab && t != .profile { web.closeOverlays(); if t == .home || t == .read { web.open(t.rawValue) }; return }
        tab = t
        switch t {
        case .home, .read, .study, .library: web.open(t.rawValue)
        case .profile: break
        }
    }

    /// Something in the page itself that must show the page (the Profile dialog, Settings): the content tab first.
    func openInPage(_ route: String) {
        if tab == .profile { tab = page.home ? .home : .read }
        web.open(route)
    }

    /// The page's own navigation moves the tab: a Home link, the Library closing, a verse opened from a study.
    private func follow(_ p: PageState) {
        guard tab != .profile else { return }
        if p.libraryOpen { if tab != .study && tab != .library { tab = .library } }
        else { tab = p.home ? .home : .read }
    }

    /// A universal link (biblelantern.com/#43/3/16) or the app's scheme (biblelantern://43/3/16).
    func handle(_ url: URL) {
        var route = ""
        if url.scheme?.lowercased() == "biblelantern" {
            route = ((url.host ?? "") + url.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else if let f = url.fragment, !f.isEmpty {
            route = f
        }
        if route.isEmpty || route == "home" { tab = .home; web.openLater("home"); return }
        tab = .read
        web.openLater(route)
    }

    func share() {
        Task {
            guard let s = await web.shareText(), let url = URL(string: s.url) else { return }
            let line = s.text.isEmpty ? s.title : "\(s.title) — \(s.text)"
            shareItems = [line, url]
        }
    }

    /// Dynamic Type → the page's reading size (12–32px), only when the reader asked for it.
    func applyDynamicType(_ size: DynamicTypeSize) {
        guard followDynamicType else { return }
        let px: Int
        switch size {
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
