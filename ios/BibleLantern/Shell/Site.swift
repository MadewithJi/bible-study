import Foundation

/// The live site the app wraps (ios-brief §0). Every fix to the site reaches the app at once.
enum Site {
    static let production = URL(string: "https://www.biblelantern.com/")!
    /// Debug builds can point at a local serve.py instead (a test of the bridge before it is deployed):
    /// `xcrun simctl spawn <udid> defaults write com.biblelantern.app bl.site http://localhost:8861`; delete the key to go back.
    static var base: URL {
        #if DEBUG
        if let s = UserDefaults.standard.string(forKey: "bl.site"), let u = URL(string: s), let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != nil { return u }
        #endif
        return production
    }
    /// http(s) navigations inside these hosts stay in the app; any other site (Bible Gateway, YouTube), and mail, phone
    /// or message links, open outside (WebController.stays).
    static var hosts: Set<String> {
        var h: Set<String> = ["www.biblelantern.com", "biblelantern.com"]
        if let o = base.host?.lowercased() { h.insert(o) }
        return h
    }
    /// `?app=ios` is the shell flag index.html reads before the first paint; the user agent carries it too (WebController).
    static var start: URL { URL(string: "?app=ios#home", relativeTo: base)!.absoluteURL }
    static let privacy = URL(string: "https://www.biblelantern.com/privacy")!
    static let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    static let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    /// Appended to WebKit's own user agent (`applicationNameForUserAgent`): "… Mobile/15E148 BibleLantern/iOS/1.0".
    static let userAgentName = "Mobile/15E148 BibleLantern/iOS/\(version)"
}
