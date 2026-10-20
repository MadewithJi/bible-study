import SwiftUI
import WebKit

/// A pane in each content tab that adopts the one web view while its tab is selected (ios-brief §6). The web view is
/// never recreated: it moves between the panes, so the page, its scroll position and its session carry across tabs.
struct WebPane: UIViewRepresentable {
    let controller: WebController
    let active: Bool

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        if active { adopt(container) }
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        if active { adopt(container) }
    }

    private func adopt(_ container: UIView) {
        let web = controller.webView
        guard web.superview !== container else { return }
        web.translatesAutoresizingMaskIntoConstraints = true
        web.frame = container.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(web)
    }
}
