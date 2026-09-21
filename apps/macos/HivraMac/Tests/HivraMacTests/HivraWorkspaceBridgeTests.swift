import Foundation
import Testing

@testable import HivraMacCore

@Suite("Native workspace display contract")
struct HivraWorkspaceBridgeTests {
    private func resource(source: String = "hivra", id: String = "same-id") -> [String: Any] {
        ["uid": "\(source == "hermes" ? "h" : "x")-\(id)", "id": id, "source": source,
         "kind": source == "hermes" ? "agent" : "computer", "name": "My resource", "description": "Ubuntu",
         "status": "running", "href": source == "hermes" ? "/dashboard/instances/\(id)" : "/dashboard/agent/\(id)?tab=desktop"]
    }

    private func workspace(_ resources: [[String: Any]] = []) -> [String: Any] {
        ["version": 1, "kind": "workspace", "ownerKey": "owner-1", "resources": resources,
         "loading": false, "errors": ["hermes": NSNull(), "hivra": NSNull()]]
    }

    private func surfaces() -> [String: Any] {
        ["version": 1, "kind": "surfaces", "pathname": "/dashboard/agent/same-id", "active": "desktop",
         "surfaces": [["id": "desktop", "label": "Desktop"], ["id": "manage", "label": "Manage"]]]
    }

    @Test("accepts the JSON bridge representation and keeps equal IDs from different sources distinct")
    func acceptsSourceQualifiedInventory() throws {
        let data = try JSONSerialization.data(withJSONObject: workspace([resource(), resource(source: "hermes")]))
        let body = try JSONSerialization.jsonObject(with: data)
        guard case .workspace(let snapshot) = try #require(HivraWorkspaceBridgeMessage.parse(body)) else {
            Issue.record("Expected a workspace snapshot"); return
        }
        #expect(snapshot.ownerKey == "owner-1")
        #expect(snapshot.resources.map(\.uid) == ["x-same-id", "h-same-id"])
        #expect(snapshot.resources.map(\.id) == ["same-id", "same-id"])
        #expect(snapshot.errors.isEmpty)
        #expect(!snapshot.loading)
    }

    @Test("keeps loading and partial failures visible without discarding available resources")
    func acceptsPartialInventory() throws {
        var body = workspace([resource(source: "hermes")])
        body["loading"] = true
        body["errors"] = ["hivra": "Resource source unavailable"]
        guard case .workspace(let snapshot) = try #require(HivraWorkspaceBridgeMessage.parse(body)) else { return }
        #expect(snapshot.loading)
        #expect(snapshot.resources.count == 1)
        #expect(snapshot.errors == [.hivra: "Resource source unavailable"])
    }

    @Test("accepts an explicit signed-out reset only when it carries no owner data")
    func resetsOwner() throws {
        var body = workspace()
        body["ownerKey"] = NSNull()
        guard case .workspace(let snapshot) = try #require(HivraWorkspaceBridgeMessage.parse(body)) else { return }
        #expect(snapshot.ownerKey == nil)
        for changes: [String: Any] in [
            ["resources": [resource()]], ["loading": true], ["errors": ["hermes": "Private owner failure"]],
            ["ownerKey": ""], ["ownerKey": String(repeating: "x", count: 257)],
        ] {
            #expect(HivraWorkspaceBridgeMessage.parse(body.merging(changes) { _, new in new }) == nil)
        }
    }

    @Test("rejects malformed versions, booleans, shapes and credential-bearing extensions")
    func rejectsMalformedMessages() {
        for changes: [String: Any] in [
            ["version": true], ["version": 2], ["version": "1"], ["version": 1.1],
            ["kind": "command"], ["loading": 1], ["loading": "false"], ["resources": [:]],
            ["errors": ["unknown": "failure"]], ["errors": ["hermes": true]],
            ["errors": ["hivra": String(repeating: "x", count: 513)]], ["token": "secret"],
        ] {
            #expect(HivraWorkspaceBridgeMessage.parse(workspace().merging(changes) { _, new in new }) == nil)
        }
        #expect(HivraWorkspaceBridgeMessage.parse([]) == nil)
        #expect(HivraWorkspaceBridgeMessage.parse(workspace(Array(repeating: resource(), count: 2_001))) == nil)
    }

    @Test("rejects duplicate identities, spoofed source paths and oversized resource metadata")
    func rejectsInvalidResources() {
        #expect(HivraWorkspaceBridgeMessage.parse(workspace([resource(), resource()])) == nil)
        for changes: [String: Any] in [
            ["uid": "h-same-id"], ["source": "other"], ["kind": "runtime"], ["id": "../escape"],
            ["href": "/dashboard/instances/same-id"], ["href": "/dashboard/agent/another-id"],
            ["href": "/dashboard/agent/same-id?token=secret"], ["href": "https://guest.invalid/dashboard"],
            ["name": ""], ["name": String(repeating: "x", count: 257)],
            ["description": String(repeating: "x", count: 513)], ["status": "running\nmalformed"],
            ["credentials": ["password": "secret"]],
        ] {
            #expect(HivraWorkspaceBridgeMessage.parse(workspace([resource().merging(changes) { _, new in new }])) == nil)
        }
        #expect(HivraWorkspaceBridgeMessage.parse(workspace([resource(source: "hermes").merging(["kind": "computer"]) { _, new in new }])) == nil)
    }

    @Test("accepts advertised surfaces and clearing, but rejects stale selections and unbounded payloads")
    func validatesSurfaces() throws {
        guard case .surfaces(let snapshot) = try #require(HivraWorkspaceBridgeMessage.parse(surfaces())) else { return }
        #expect(snapshot.active == "desktop")
        #expect(snapshot.surfaces.map(\.id) == ["desktop", "manage"])
        #expect(HivraWorkspaceBridgeMessage.parse(surfaces().merging(["active": "", "surfaces": []]) { _, new in new }) != nil)
        for changes: [String: Any] in [
            ["active": "terminal"], ["pathname": "/dashboard/agent/same-id?tab=desktop"],
            ["surfaces": [["id": "desktop", "label": "Desktop"], ["id": "desktop", "label": "Copy"]]],
            ["surfaces": [["id": "desktop", "label": "Desktop", "url": "https://guest.invalid"]]],
            ["surfaces": [["id": "desktop", "label": String(repeating: "x", count: 129)]]],
            ["surfaces": Array(repeating: ["id": "desktop", "label": "Desktop"], count: 33)],
        ] {
            #expect(HivraWorkspaceBridgeMessage.parse(surfaces().merging(changes) { _, new in new }) == nil)
        }
    }
}
