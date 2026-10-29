import Foundation
import JavaScriptCore

// This spike has no DOM, fetch, native callbacks, or author-provided JavaScript.
final class ParserRenderer {
    private let context: JSContext

    init(bundleURL: URL) throws {
        guard let context = JSContext() else { throw CocoaError(.coderInvalidValue) }
        self.context = context
        let script = try String(contentsOf: bundleURL, encoding: .utf8)
        context.evaluateScript(script, withSourceURL: bundleURL)
        try checkException()
    }

    func render(_ source: String) throws -> String {
        context.exception = nil
        guard let function = context.objectForKeyedSubscript("renderMarkdown"),
              let value = function.call(withArguments: [source]) else {
            throw CocoaError(.coderInvalidValue)
        }
        try checkException()
        guard value.isString, let html = value.toString(), !html.isEmpty else {
            throw CocoaError(.coderInvalidValue)
        }
        return html
    }

    private func checkException() throws {
        if let exception = context.exception {
            throw NSError(domain: "SimpleMDParser", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: exception.toString() ?? "JavaScript exception"])
        }
    }
}
