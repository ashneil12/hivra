import Foundation
import Testing

@testable import HivraMacCore

/// The route grammar and navigation shared with the dashboard. The cases live in
/// apps/shared/native-contract so the web suite (native-route-grammar.test.ts)
/// asserts the exact same results.
@Suite("Shared native workspace contract")
struct HivraNativeContractTests {
    struct RouteGrammarFixture: Decodable {
        struct Case: Decodable {
            struct Shell: Decodable {
                let resource: String?
                let destination: String?
            }

            let family: String
            let input: String
            let expect: String?
            let shell: Shell?
        }

        let contract: String
        let version: Int
        let cases: [Case]
    }

    struct NavigationFixture: Decodable {
        struct Item: Decodable, Equatable {
            let label: String
            let href: String
        }

        let contract: String
        let version: Int
        let items: [Item]
    }

    static func fixture<Fixture: Decodable>(_ name: String) throws -> Fixture {
        // Tests/HivraMacTests/<file> → apps/shared/native-contract/<name>
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("shared/native-contract/\(name)"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    @Test("normalizes every shared route case exactly as the dashboard does")
    func routeGrammar() throws {
        let fixture: RouteGrammarFixture = try Self.fixture("route-grammar.v1.json")
        #expect(fixture.contract == "hivra.native-workspace.route-grammar")
        #expect(fixture.version == HivraWorkspaceRoute.grammarVersion)
        #expect(fixture.cases.count > 100)
        for testCase in fixture.cases {
            let label = Comment(rawValue: "\(testCase.family): \(testCase.input.debugDescription)")
            let normalized = HivraWorkspaceRoute.normalizedPath(testCase.input)
            #expect(normalized == testCase.expect, label)
            guard let normalized else { continue }
            // Canonical routes are fixed points, so either side may normalize again.
            #expect(HivraWorkspaceRoute.normalizedPath(normalized) == normalized, label)
            if let shell = testCase.shell {
                #expect(HivraWorkspaceRoute.resourceUID(for: testCase.input) == shell.resource, label)
                #expect(HivraWorkspacePolicy.destination(for: testCase.input)?.rawValue == shell.destination, label)
            }
        }
    }

    @Test("names the primary destinations exactly as the dashboard does")
    func primaryNavigation() throws {
        let fixture: NavigationFixture = try Self.fixture("primary-navigation.v1.json")
        #expect(fixture.contract == "hivra.native-workspace.primary-navigation")
        let native = HivraWorkspaceDestination.primaryNavigation
        #expect(native.map { NavigationFixture.Item(label: $0.label, href: $0.path) } == fixture.items)
    }
}
