import SwiftUI

/// The Read tab's glass toolbar (ios-brief §6): Back (once the page has a chapter to go back to) and the reference
/// leading (it opens the book picker); translation, search, Explore and share trailing. Until the bridge is ready, and
/// while a dialog in the page has the screen, the items wait; a page without the bridge keeps its own top bar instead.
struct ReadChrome: ViewModifier {
    @EnvironmentObject var model: AppModel

    func body(content: Content) -> some View {
        let p = model.page
        let off = !model.web.ready || p.anyOverlay // on the items only: the page under them stays live
        content.toolbar {
            if p.canBack {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.web.back() } label: { Image(systemName: "chevron.backward") }
                        .accessibilityLabel("Back to the previous chapter")
                        .disabled(off)
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { model.showPicker = true } label: {
                    HStack(spacing: 4) {
                        Text(p.chapterLabel).font(.headline).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    }
                }
                .accessibilityLabel("Choose book and chapter, now \(p.chapterLabel)")
                .disabled(off)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Group {
                    TranslationMenu()
                    Button { model.showSearch = true } label: { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel("Search")
                    Button { model.showExplore = true } label: { Image(systemName: "sparkles") }
                        .accessibilityLabel("Explore: arcs, graph, map and art")
                    Button { model.share() } label: { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("Share")
                }
                .disabled(off)
            }
        }
        .toolbarVisibility(model.web.bare ? .hidden : .automatic, for: .navigationBar)
    }
}

/// ‹ John 3 › above the tab bar: the chapter steps where the thumb is; the reference opens the picker.
struct ChapterStepper: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let p = model.page
        HStack(spacing: 0) {
            Button { model.web.step(-1) } label: {
                Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .disabled(p.b == 1 && p.c == 1)
            .accessibilityLabel("Previous chapter")
            Button { model.showPicker = true } label: {
                Text(p.chapterLabel).font(.subheadline.weight(.semibold)).lineLimit(1).frame(maxWidth: .infinity).contentShape(Rectangle())
            }
            .accessibilityLabel("Choose book and chapter, now \(p.chapterLabel)")
            Button { model.web.step(1) } label: {
                Image(systemName: "chevron.right").font(.body.weight(.semibold)).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .disabled(p.b == 66 && p.c == 22)
            .accessibilityLabel("Next chapter")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .disabled(!model.web.ready || p.anyOverlay)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge) // a bar's cap, as the system's own bars have: the page carries the large sizes
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
            Text(abbr(cur, in: list)).font(.caption.weight(.semibold))
        }
        .accessibilityLabel("Translation, now \(abbr(cur, in: list))")
    }

    private func abbr(_ id: String, in list: [Translation]) -> String {
        list.first { $0.id == id }?.abbr ?? id.uppercased()
    }
}
