import Foundation

/// The live site the app wraps (ios-brief §0). Every fix to the site reaches the app at once.
enum Site {
    static let base = URL(string: "https://www.biblelantern.com/")!
    /// Navigations inside these hosts stay in the app; anything else (Bible Gateway, Buy Me a Coffee, mail) opens outside.
    static let hosts: Set<String> = ["www.biblelantern.com", "biblelantern.com"]
    /// `?app=ios` is the shell flag index.html reads before the first paint; the user agent carries it too (WebController).
    static let start = URL(string: "https://www.biblelantern.com/?app=ios#home")!
    static let donate = URL(string: "https://www.biblelantern.com/donate")!
    static let privacy = URL(string: "https://www.biblelantern.com/privacy")!
    static let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    static let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    /// Appended to WebKit's own user agent (`applicationNameForUserAgent`): "… Mobile/15E148 BibleLantern/iOS/1.0".
    static let userAgentName = "Mobile/15E148 BibleLantern/iOS/\(version)"
}
