import SwiftUI

/// The page with the native chrome around it: the Read toolbar above, the tab bar below, Profile over it (ios-brief §1).
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        ZStack {
            WebView(controller: model.web)
            if model.tab == .profile {
                ProfileView()
                    .background(Color(uiColor: .systemBackground))
                    .transition(.opacity)
            }
            if !model.web.ready { LoadingView() }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.tab == .read { ReadToolbar() }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { TabBar() }
        .background(pageBackground.ignoresSafeArea())
        .preferredColorScheme(model.colorScheme)
        .animation(.easeInOut(duration: 0.18), value: model.tab)
        .sheet(isPresented: $model.showPicker) { BookPicker().environmentObject(model) }
        .sheet(isPresented: $model.showSearch) { SearchSheet().environmentObject(model) }
        .sheet(isPresented: $model.showExplore) { ExploreSheet().environmentObject(model) }
        .sheet(isPresented: Binding(get: { model.shareItems != nil }, set: { if !$0 { model.shareItems = nil } })) {
            ShareSheet(items: model.shareItems ?? [])
        }
        .onOpenURL { model.handle($0) }
        .onChange(of: dynamicType) { _, size in model.applyDynamicType(size) }
    }

    /// The site's own page colours, so the status bar and the edges match the page (light #f5f3ee, dark black).
    private var pageBackground: Color {
        model.page.dark ? Color.black : Color(red: 245 / 255, green: 243 / 255, blue: 238 / 255)
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
                Button("Try again") { model.web.load() }.buttonStyle(.borderedProminent)
            } else {
                ProgressView()
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
