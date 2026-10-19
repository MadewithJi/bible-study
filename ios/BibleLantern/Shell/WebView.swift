import SwiftUI
import WebKit

/// The one web view, placed by RootView; it is never recreated.
struct WebView: UIViewRepresentable {
    let controller: WebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
