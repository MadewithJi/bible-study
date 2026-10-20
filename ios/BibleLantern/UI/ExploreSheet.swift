import SwiftUI

/// The visualisations in one place (ios-brief §1): Arcs · Graph · Map · Art, and the original-language interlinear.
struct ExploreSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private struct Item: Identifiable { let name, title, detail, symbol: String; var id: String { name } }
    private let items = [
        Item(name: "arcs", title: "Arcs", detail: "Cross-references drawn as arcs over the chapter", symbol: "point.topleft.down.to.point.bottomright.curvepath"),
        Item(name: "graph", title: "Graph", detail: "The chapter’s links as a web of passages", symbol: "circle.hexagongrid"),
        Item(name: "map", title: "Map", detail: "The places this chapter names", symbol: "map"),
        Item(name: "art", title: "Art", detail: "Doré’s engravings for this chapter", symbol: "photo.artframe"),
    ]

    var body: some View {
        let open = model.page.panel
        NavigationStack {
            List {
                Section("Beside the chapter") {
                    ForEach(items) { it in
                        Button { model.web.panel(it.name); dismiss() } label: {
                            HStack(spacing: 14) {
                                Image(systemName: it.symbol).font(.title3).frame(width: 28).foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(it.title).foregroundStyle(.primary)
                                    Text(it.detail).font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if open == it.name { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if !open.isEmpty {
                        Button("Close the \(items.first { $0.name == open }?.title.lowercased() ?? "panel")") { model.web.panel(""); dismiss() }
                    }
                }
                Section {
                    Toggle("Original language under each verse", isOn: Binding(get: { model.page.orig }, set: { model.web.setOrig($0) }))
                } footer: {
                    Text("Hebrew and Greek with Strong’s numbers, under every verse.")
                }
            }
            .navigationTitle("Explore")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
