import SwiftUI

/// Home · Read · Study · Library · Profile (ios-brief §1): one bar in place of the phone's two-row top bar.
struct TabBar: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppModel.Tab.allCases) { t in
                let on = model.tab == t
                Button { model.select(t) } label: {
                    VStack(spacing: 3) {
                        Image(systemName: t.symbol)
                            .symbolVariant(on ? .fill : .none)
                            .font(.system(size: 22))
                            .frame(height: 26)
                        Text(t.title).font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 7)
                    .padding(.bottom, 3)
                    .foregroundStyle(on ? Color.accentColor : Color.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}
