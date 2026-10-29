import Foundation
import JavaScriptCore
import ImageIO
import os

// Access only on PreviewProvider.renderQueue. JavaScript has no native callbacks or host APIs.
final class StaticRenderer {
    private let context: JSContext
    private let render: JSValue
    private let imageUrls: JSValue
    private let embedImages: JSValue
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.quicklook", category: "renderer")

    init(bundle: Bundle) throws {
        let started = ProcessInfo.processInfo.systemUptime
        guard let context = JSContext(),
              let url = bundle.url(forResource: "render-core", withExtension: "js") else {
            throw CocoaError(.fileNoSuchFile)
        }
        self.context = context
        let created = ProcessInfo.processInfo.systemUptime
        let code = try String(contentsOf: url, encoding: .utf8)
        let read = ProcessInfo.processInfo.systemUptime
        context.evaluateScript(code, withSourceURL: url)
        let evaluated = ProcessInfo.processInfo.systemUptime
        if let error = context.exception { throw Self.failure(error.toString()) }
        // JSC drains ECMAScript promise jobs when this outer call returns. The bundle
        // performs no asynchronous host I/O. A missing result fails the request.
        guard let render = context.evaluateScript("""
            (function(source, filePath, options) {
                const result = {};
                SimpleMDRenderCore.renderStaticHtml(source, filePath, options).then(
                    html => result.html = html, error => result.error = String(error));
                return result;
            })
            """),
              let core = context.objectForKeyedSubscript("SimpleMDRenderCore"),
              let imageUrls = core.forProperty("staticImageUrls"),
              let embedImages = core.forProperty("embedStaticImages"),
              !imageUrls.isUndefined, !embedImages.isUndefined else { throw Self.failure("Missing browser renderer") }
        self.render = render
        self.imageUrls = imageUrls
        self.embedImages = embedImages
        logger.notice("Renderer initialized context_ms=\((created-started)*1000) bundle_read_ms=\((read-created)*1000) bundle_eval_ms=\((evaluated-read)*1000) bundle_bytes=\(code.utf8.count)")
    }

    func html(source: PreviewSource, filePath: String) throws -> String {
        context.exception = nil
        let started = ProcessInfo.processInfo.systemUptime
        let options = ["truncated": source.truncated, "invalidUtf8": source.invalidUtf8]
        let result = render.call(withArguments: [source.text, filePath, options])
        func resultError() -> String? {
            let error = result?.forProperty("error")
            return error?.isString == true ? error?.toString() : nil
        }
        guard context.exception == nil, let value = result?.forProperty("html"), value.isString,
              let html = value.toString(), !html.isEmpty else {
            throw Self.failure(context.exception?.toString() ?? resultError() ?? "Static renderer promise did not produce HTML")
        }
        let rendered = ProcessInfo.processInfo.systemUptime
        let urls = imageUrls.call(withArguments: [html])?.toArray() as? [String] ?? []
        var resources: [String: String] = [:]
        var remainingBytes = 8 * 1024 * 1024
        // Limit both encoded bytes and decoded pixels. Never request a sandbox grant.
        for address in urls.prefix(32) {
            guard let url = URL(string: address), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { continue }
            do {
                let file = try FileHandle(forReadingFrom: url)
                defer { try? file.close() }
                let size = try file.seekToEnd()
                guard size <= UInt64(min(2 * 1024 * 1024, remainingBytes)) else { continue }
                try file.seek(toOffset: 0)
                let data = try file.read(upToCount: Int(size)) ?? Data()
                guard let image = CGImageSourceCreateWithData(data as CFData, nil),
                      let type = CGImageSourceGetType(image) as String?,
                      let mime = ["public.png": "image/png", "public.jpeg": "image/jpeg", "com.compuserve.gif": "image/gif", "org.webmproject.webp": "image/webp"][type],
                      let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 16_777_216 else { continue }
                remainingBytes -= data.count
                resources[address] = "data:\(mime);base64,\(data.base64EncodedString())"
            } catch { /* The preview grant often covers only the document, not its siblings. */ }
        }
        guard let embedded = embedImages.call(withArguments: [html, resources]), context.exception == nil,
              embedded.isString, let output = embedded.toString() else { throw Self.failure("Image assembly failed") }
        let completed = ProcessInfo.processInfo.systemUptime
        logger.notice("Renderer rendered render_ms=\((rendered-started)*1000) images_ms=\((completed-rendered)*1000) images_requested=\(urls.count) images_embedded=\(resources.count)")
        return output
    }

    private static func failure(_ message: String?) -> NSError {
        NSError(domain: "SimpleMDStaticRenderer", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message ?? "Invalid renderer output"])
    }
}
