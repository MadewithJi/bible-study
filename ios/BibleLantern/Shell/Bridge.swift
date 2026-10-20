import Foundation

/// What the page reports (shell.js `snapshot()`), as one `state` message per change and once as `ready`. (The page's
/// `failed` message carries only its text; WebController reads that one itself.)
struct PageState: Codable, Equatable {
    var home = true
    var b = 43
    var c = 3
    var v = 0
    var label = "John 3"
    var chapterLabel = "John 3"
    var panel = ""
    var overlays: [String] = []
    var drawer = false
    var tr = "kjv"
    var tr2 = ""
    var orig = false
    var theme = "auto"
    var dark = false
    var font = 20
    var signedIn = false
    var name = ""
    var email = ""
    var hosted = true
    var lost = false
    var url = ""
    /// The page's history has a chapter to go back to (its Back, `BL.back()`).
    var canBack = false

    var libraryOpen: Bool { overlays.contains("library") }
    var anyOverlay: Bool { !overlays.isEmpty }

    /// A message body from the page: any key may be missing (an older page), so each falls back to its default.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func get<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T { (try? c.decodeIfPresent(T.self, forKey: key)) ?? nil ?? fallback }
        home = get(.home, home); b = get(.b, b); self.c = get(.c, self.c); v = get(.v, v)
        label = get(.label, label); chapterLabel = get(.chapterLabel, chapterLabel)
        panel = get(.panel, panel); overlays = get(.overlays, overlays); drawer = get(.drawer, drawer)
        tr = get(.tr, tr); tr2 = get(.tr2, tr2); orig = get(.orig, orig)
        theme = get(.theme, theme); dark = get(.dark, dark); font = get(.font, font)
        signedIn = get(.signedIn, signedIn); name = get(.name, name); email = get(.email, email)
        hosted = get(.hosted, hosted); lost = get(.lost, lost); url = get(.url, url)
        canBack = get(.canBack, canBack)
    }
    init() {}
}

/// A book for the native picker (shell.js `BL.books()`).
struct Book: Codable, Identifiable, Hashable {
    var n: Int
    var name: String
    var short: String
    var test: String   // "OT" | "NT"
    var chapters: Int
    var id: Int { n }
}

/// A translation for the native menu (shell.js `BL.translations()`).
struct Translation: Codable, Identifiable, Hashable {
    var id: String
    var abbr: String
    var name: String
    var kind: String   // "bundled" | "api" | "external"
    var disabled: Bool
}

/// What the share sheet gets (shell.js `BL.share()`).
struct ShareText: Codable {
    var title: String
    var text: String
    var url: String
}

/// A JSON string literal for a value passed into the page.
func jsString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}
