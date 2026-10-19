import SwiftUI

/// Search as the top bar's field does: a reference, words, a Strong’s number or a topic; the results open in the
/// page's study sheet.
struct SearchSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Search verses, words, G26, topics", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .onSubmit(go)
                Text("Try “John 3:16”, “living water”, “G26” or “grace”.").font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Search", action: go).disabled(trimmed.isEmpty) }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func go() {
        guard !trimmed.isEmpty else { return }
        model.web.search(trimmed)
        dismiss()
    }
}
