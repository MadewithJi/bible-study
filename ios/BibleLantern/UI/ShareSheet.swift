import SwiftUI
import UIKit

/// The system share sheet for a verse or chapter ("John 3:16 — … biblelantern.com/#43/3/16").
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
