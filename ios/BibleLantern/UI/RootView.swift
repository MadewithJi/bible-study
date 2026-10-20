import SwiftUI

/// The page inside the system's glass chrome (ios-brief §6): a `TabView` draws the floating tab bar, the Read tab
/// wears a glass toolbar and a chapter stepper above the tab bar, Profile is native. The page runs edge to edge
/// beneath the bars; app-shell mode keeps its own layout below them through the safe-area insets.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        TabView(selection: model.tabSelection) {
            Tab(value: AppModel.Tab.home) { pane(.home) } label: { Label("Home", systemImage: "house") }
            Tab(value: AppModel.Tab.read) {
                NavigationStack {
                    pane(.read)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbarBackground(.hidden, for: .navigationBar)
                        .modifier(ReadChrome())
                }
            } label: { Label("Read", systemImage: "book") }
            Tab(value: AppModel.Tab.study) { pane(.study) } label: { Label("Study", systemImage: "highlighter") }
            Tab(value: AppModel.Tab.library) { pane(.library) } label: { Label("Library", systemImage: "books.vertical") }
            Tab(value: AppModel.Tab.profile) { ProfileView() } label: { Label("Profile", systemImage: "person.crop.circle") }
        }
        .modifier(ChapterStepperAccessory())
        .overlay { if !model.web.ready { LoadingView() } }
        .preferredColorScheme(model.colorScheme)
        .sheet(isPresented: $model.showPicker) { BookPicker().environmentObject(model) }
        .sheet(isPresented: $model.showSearch) { SearchSheet().environmentObject(model) }
        .sheet(isPresented: $model.showExplore) { ExploreSheet().environmentObject(model) }
        .sheet(isPresented: Binding(get: { model.shareItems != nil }, set: { if !$0 { model.shareItems = nil } })) {
            ShareSheet(items: model.shareItems ?? [])
        }
        .onOpenURL { model.handle($0) }
        .onChange(of: dynamicType) { _, size in model.applyDynamicType(size) }
    }

    /// The web view, edge to edge, in the tab that is selected; the page's own colour fills the edges meanwhile.
    private func pane(_ tab: AppModel.Tab) -> some View {
        WebPane(controller: model.web, active: model.tab == tab)
            .ignoresSafeArea()
            .background(pageBackground.ignoresSafeArea())
    }

    /// The site's page colours (light #f5f3ee, dark black), so the edges match the page before it paints.
    private var pageBackground: Color {
        model.page.dark || model.page.home ? Color.black : Color(red: 245 / 255, green: 243 / 255, blue: 238 / 255)
    }
}

/// The chapter stepper above the tab bar while reading (iOS 26.1): ‹ John 3 ›, the reference opening the picker.
private struct ChapterStepperAccessory: ViewModifier {
    @EnvironmentObject var model: AppModel
    func body(content: Content) -> some View {
        if #available(iOS 26.1, *) {
            content.tabViewBottomAccessory(isEnabled: model.tab == .read) { ChapterStepper() }
        } else {
            content
        }
    }
}

/// While the page loads, or when it could not: the name, a spinner, and a Retry.
struct LoadingView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Text("Bible Lantern").font(.title2.weight(.semibold))
            if let failed = model.web.failed {
                Text("Can’t reach biblelantern.com right now.").foregroundStyle(.secondary)
                Text(failed).font(.footnote).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                Button("Try again") { model.web.load() }.buttonStyle(.glassProminent)
            } else {
                ProgressView()
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
