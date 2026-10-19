import SwiftUI

/// The Profile tab (ios-brief §1): who is signed in, the reading settings, the page's Settings, support, sign out.
struct ProfileView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicType
    @State private var confirmSignOut = false

    var body: some View {
        let p = model.page
        NavigationStack {
            List {
                Section {
                    if p.signedIn {
                        Button { model.openInPage("profile") } label: {
                            HStack(spacing: 12) {
                                Text(initials(p.name)).font(.headline).frame(width: 40, height: 40)
                                    .background(Color.accentColor.opacity(0.15), in: Circle()).foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name.isEmpty ? "Your profile" : p.name).font(.headline).foregroundStyle(.primary)
                                    Text(p.lost ? "Signed out on the server. Sign in again." : p.email).font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                        }
                    } else {
                        Button { model.openInPage("profile") } label: { Label("Sign in or create a profile", systemImage: "person.crop.circle.badge.plus") }
                        Text("A profile keeps your notes, highlights, links and reading in one place, on every device.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Reading") {
                    Picker("Appearance", selection: Binding(get: { p.theme }, set: { model.web.setTheme($0) })) {
                        Text("Automatic").tag("auto")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    Stepper(value: Binding(get: { p.font }, set: { model.web.setFontSize($0) }), in: 12...32) {
                        HStack { Text("Text size"); Spacer(); Text("\(p.font) px").foregroundStyle(.secondary) }
                    }
                    .disabled(model.followDynamicType)
                    Toggle("Use the system text size", isOn: $model.followDynamicType)
                        .onChange(of: model.followDynamicType) { _, on in if on { model.applyDynamicType(dynamicType) } }
                    Toggle("Original language under each verse", isOn: Binding(get: { p.orig }, set: { model.web.setOrig($0) }))
                }
                Section("More") {
                    Button { model.openInPage("settings") } label: { Label("Settings", systemImage: "gearshape") }
                    Button { model.open(Site.donate) } label: { Label("Support Bible Lantern", systemImage: "heart") }
                    Button { model.open(Site.privacy) } label: { Label("Privacy", systemImage: "hand.raised") }
                }
                if p.signedIn {
                    Section { Button("Sign out", role: .destructive) { confirmSignOut = true } }
                }
                Section {
                    Text("Bible Lantern \(Site.version) (\(Site.build))").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Profile")
            .confirmationDialog("Sign out on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { model.web.signOut() }
            } message: {
                Text("Your notes, highlights and links stay in your profile.")
            }
        }
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2).compactMap { $0.first }
        return parts.isEmpty ? "?" : String(parts).uppercased()
    }
}
