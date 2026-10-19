import SwiftUI

/// The native book and chapter picker (ios-brief §1): the books by testament, then a grid of chapters.
struct BookPicker: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var book: Book? = nil
    @State private var filter = ""

    var body: some View {
        NavigationStack {
            Group {
                if model.web.books.isEmpty { ProgressView("Loading the books…") } else { bookList }
            }
            .navigationTitle("Books")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $book) { b in
                ChapterGrid(book: b) { c in
                    UISelectionFeedbackGenerator().selectionChanged()
                    model.web.open("\(b.n)/\(c)")
                    dismiss()
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .searchable(text: $filter, prompt: "Book")
        }
        .onAppear { if let b = model.web.books.first(where: { $0.n == model.page.b }) { book = b } }
    }

    private var bookList: some View {
        List {
            ForEach(["OT", "NT"], id: \.self) { test in
                let books = model.web.books.filter { $0.test == test && (filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter)) }
                if !books.isEmpty {
                    Section(test == "OT" ? "Old Testament" : "New Testament") {
                        ForEach(books) { b in
                            Button { book = b } label: {
                                HStack {
                                    Text(b.name).foregroundStyle(.primary)
                                    Spacer()
                                    Text("\(b.chapters)").font(.footnote).foregroundStyle(.secondary)
                                    if b.n == model.page.b { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

struct ChapterGrid: View {
    @EnvironmentObject var model: AppModel
    let book: Book
    let pick: (Int) -> Void

    var body: some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
                ForEach(1...max(1, book.chapters), id: \.self) { c in
                    let on = book.n == model.page.b && c == model.page.c
                    Button { pick(c) } label: {
                        Text("\(c)")
                            .font(.body.weight(on ? .semibold : .regular))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(on ? Color.accentColor : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            .foregroundStyle(on ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(book.name) \(c)")
                }
            }
            .padding()
        }
        .navigationTitle(book.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
