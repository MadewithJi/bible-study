import SwiftUI

/// The page inside the system's glass chrome (ios-brief §6): a `TabView` draws the floating tab bar, the Read tab
/// wears a glass toolbar and a chapter stepper above the tab bar, Profile is native. The page runs edge to edge
/// beneath the bars; app-shell mode keeps its own layout below them through the safe-area insets. A page without the
/// bridge shows as it is, below the status bar, with its own top bar and no native chrome.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.colorScheme) private var scheme

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
        .accessibilityHidden(model.web.loading) // the launch view is all VoiceOver reads meanwhile
        .overlay { if model.web.loading { LoadingView() } }
        .preferredColorScheme(model.colorScheme)
        .sheet(isPresented: $model.showPicker) { BookPicker().environmentObject(model) }
        .sheet(isPresented: $model.showSearch) { SearchSheet().environmentObject(model) }
        .sheet(isPresented: $model.showExplore) { ExploreSheet().environmentObject(model) }
        .sheet(isPresented: Binding(get: { model.shareItems != nil }, set: { if !$0 { model.shareItems = nil } })) {
            ShareSheet(items: model.shareItems ?? [])
        }
        .alert(model.notice?.title ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } }), presenting: model.notice) { _ in
            Button("OK", role: .cancel) {}
        } message: { n in
            Text(n.message)
        }
        .onOpenURL { model.handle($0) }
        .onChange(of: dynamicType, initial: true) { _, size in model.systemSize = size }
    }

    /// The web view, edge to edge, in the tab that is selected; the page's own colour fills the edges meanwhile. A
    /// page without the bridge keeps below the status bar (its top bar knows nothing of it) and the tab bar steps aside.
    /// When the page cannot be used, the error and its Try again take the pane and the tab bar stays.
    private func pane(_ tab: AppModel.Tab) -> some View {
        WebPane(controller: model.web, active: model.tab == tab)
            .ignoresSafeArea(.all, edges: model.web.bare ? .bottom : .all)
            .background(pageBackground.ignoresSafeArea())
            .accessibilityHidden(model.web.failed != nil)
            .overlay { if model.web.failed != nil { LoadingView() } }
            .toolbarVisibility(model.web.bare ? .hidden : .automatic, for: .tabBar)
    }

    /// The site's page colours (light #f5f3ee, dark black), so the edges match the page before it paints. A page
    /// without the bridge reports nothing, so its colours follow the system's.
    private var pageBackground: Color {
        let dark = model.web.bare ? scheme == .dark : model.page.dark || model.page.home
        return dark ? Color.black : Color(red: 245 / 255, green: 243 / 255, blue: 238 / 255)
    }
}

/// The chapter stepper above the tab bar while reading (iOS 26.1): ‹ John 3 ›, the reference opening the picker.
private struct ChapterStepperAccessory: ViewModifier {
    @EnvironmentObject var model: AppModel
    func body(content: Content) -> some View {
        if #available(iOS 26.1, *) {
            content.tabViewBottomAccessory(isEnabled: model.tab == .read && !model.web.bare) { ChapterStepper() }
        } else {
            content
        }
    }
}

/// While the page loads (over the whole app), or when it cannot be used (in the pane, the tab bar kept): the name, a
/// spinner, or what went wrong and Try again, which loads the page again where the reader was.
struct LoadingView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Text("Bible Lantern").font(.title2.weight(.semibold))
            if let failed = model.web.failed {
                Text(failed.title).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Text(failed.detail).font(.footnote).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                Button("Try again") { model.web.load() }.buttonStyle(.glassProminent)
            } else {
                ProgressView()
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
    }
}
