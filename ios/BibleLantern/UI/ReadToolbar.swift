import SwiftUI

/// The native Read toolbar (ios-brief §1): the reference opens the book picker; chapter steps; the translation
/// menu; search; Explore (arcs, graph, map, art); share. While a dialog in the page has the screen it waits.
struct ReadToolbar: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let p = model.page
        HStack(spacing: 2) {
            Button { model.showPicker = true } label: {
                HStack(spacing: 4) {
                    Text(p.chapterLabel).font(.headline).lineLimit(1).minimumScaleFactor(0.8)
                    Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 6)
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Choose book and chapter, now \(p.chapterLabel)")
            Spacer(minLength: 2)
            toolButton("chevron.left", "Previous chapter", disabled: p.b == 1 && p.c == 1) { model.web.step(-1) }
            toolButton("chevron.right", "Next chapter", disabled: p.b == 66 && p.c == 22) { model.web.step(1) }
            TranslationMenu()
            toolButton("magnifyingglass", "Search") { model.showSearch = true }
            toolButton("sparkles", "Explore: arcs, graph, map and art") { model.showExplore = true }
            toolButton("square.and.arrow.up", "Share") { model.share() }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .padding(.horizontal, 8)
        .frame(height: 44)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .disabled(p.anyOverlay)
        .opacity(p.anyOverlay ? 0.5 : 1)
    }

    private func toolButton(_ symbol: String, _ label: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .frame(width: 34, height: 36)
                .contentShape(Rectangle())
        }
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
        .accessibilityLabel(label)
    }
}

/// The primary translation and the parallel one, as the page's two selects offer them (an owner's licensed ESV or
/// NLT stays out for everyone else; a translation that opens another website is left to the page).
struct TranslationMenu: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let list = model.web.translations
        let cur = model.page.tr
        let usable = list.filter { ($0.kind == "bundled" || $0.kind == "api") && !$0.disabled }
        Menu {
            Section("Translation") {
                ForEach(usable) { t in
                    Button { model.web.setTranslation(t.id) } label: {
                        if t.id == cur { Label(t.abbr, systemImage: "checkmark") } else { Text(t.abbr) }
                    }
                }
            }
            Section("Parallel") {
                Button { model.web.setTranslation("", parallel: true) } label: {
                    if model.page.tr2.isEmpty { Label("None", systemImage: "checkmark") } else { Text("None") }
                }
                ForEach(usable.filter { $0.id != cur }) { t in
                    Button { model.web.setTranslation(t.id, parallel: true) } label: {
                        if t.id == model.page.tr2 { Label(t.abbr, systemImage: "checkmark") } else { Text(t.abbr) }
                    }
                }
            }
        } label: {
            Text(abbr(cur, in: list))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(Color.secondary.opacity(0.15), in: Capsule())
                .padding(.horizontal, 2)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Translation, now \(abbr(cur, in: list))")
    }

    private func abbr(_ id: String, in list: [Translation]) -> String {
        list.first { $0.id == id }?.abbr ?? id.uppercased()
    }
}
