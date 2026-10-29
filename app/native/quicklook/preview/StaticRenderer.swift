import Foundation
import JavaScriptCore

// Access this instance only on PreviewProvider.renderQueue. No native callbacks or network APIs.
final class StaticRenderer {
    private let context: JSContext
    private let render: JSValue

    init(bundle: Bundle) throws {
        guard let context = JSContext(),
              let url = bundle.url(forResource: "render-core", withExtension: "js") else {
            throw CocoaError(.fileNoSuchFile)
        }
        self.context = context
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
        if context.exception != nil { throw CocoaError(.coderInvalidValue) }
        guard let render = context.objectForKeyedSubscript("renderStaticHtml"),
              !render.isUndefined, !render.isNull else { throw CocoaError(.coderInvalidValue) }
        self.render = render
    }

    func html(source: PreviewSource, filePath: String, dark: Bool) throws -> String {
        context.exception = nil
        let options: [String: Any] = ["appearance": dark ? "dark" : "light",
                                     "truncated": source.truncated, "invalidUtf8": source.invalidUtf8]
        guard let value = render.call(withArguments: [source.text, filePath, options]),
              context.exception == nil, value.isString, let html = value.toString(), !html.isEmpty else {
            throw CocoaError(.coderInvalidValue)
        }
        return html
    }
}
