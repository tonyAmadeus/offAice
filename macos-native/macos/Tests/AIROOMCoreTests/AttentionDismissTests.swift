import XCTest
@testable import AIROOMCore

final class AttentionDismissTests: XCTestCase {
    private func item(_ id: String, _ title: String) -> AttentionItem {
        AttentionItem(id: id, kind: .decision, title: title, detail: "d", target: .settings)
    }

    func testIgnoredItemsStayHiddenUntilTheyChange() {
        let a = item("a", "Claude 提議了 1 條記憶"), b = item("b", "專案等你驗收")
        let dismissed = AttentionBuilder.dismissing(a, among: [a, b], dismissed: [:])
        XCTAssertEqual(AttentionBuilder.visible([a, b], dismissed: dismissed).map(\.id), ["b"])
        let changed = item("a", "Claude 提議了 2 條記憶")
        XCTAssertEqual(AttentionBuilder.visible([changed, b], dismissed: dismissed).map(\.id), ["a", "b"],
                       "a new version of an ignored item shows again")
    }

    func testRecordsOfGoneItemsAreDropped() {
        let a = item("a", "x"), b = item("b", "y")
        var dismissed = AttentionBuilder.dismissing(a, among: [a, b], dismissed: [:])
        dismissed = AttentionBuilder.dismissing(b, among: [b], dismissed: dismissed)
        XCTAssertEqual(dismissed, ["b": b.fingerprint], "a is gone, so its record goes too")
        XCTAssertEqual(AttentionBuilder.dismissing(a, among: [b], dismissed: dismissed), ["b": b.fingerprint],
                       "an item that no longer exists can't be ignored")
    }

    func testOldStateDecodesWithoutDismissals() throws {
        var state = SavedState()
        state.attentionDismissals = ["a": "decision|x|d"]
        let data = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(SavedState.self, from: data).attentionDismissals, ["a": "decision|x|d"])
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "attentionDismissals")
        let old = try JSONDecoder().decode(SavedState.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(old.attentionDismissals, [:])
    }
}
