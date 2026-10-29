import Cocoa
import QuickLookUI
import os

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.qlspike", category: "data")

    func providePreview(for request: QLFilePreviewRequest, completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void) {
        logger.notice("Data preparing \(request.fileURL.lastPathComponent, privacy: .public) pid=\(getpid())")
        let reply = QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 800, height: 600)) { reply in
            reply.stringEncoding = .utf8
            let bundle = Bundle(for: PreviewProvider.self)
            guard let resources = bundle.resourceURL else { throw CocoaError(.fileNoSuchFile) }
            let html: String
            if bundle.object(forInfoDictionaryKey: "SimpleMDStaticFixture") as? Bool == true {
                html = try String(contentsOf: resources.appendingPathComponent("StaticFixture.html"), encoding: .utf8)
            } else {
                let source = try String(contentsOf: request.fileURL, encoding: .utf8)
                let start = ProcessInfo.processInfo.systemUptime
                let renderer = try ParserRenderer(bundleURL: resources.appendingPathComponent("parser.js"))
                let loaded = ProcessInfo.processInfo.systemUptime
                let body = try renderer.render(source)
                let rendered = ProcessInfo.processInfo.systemUptime
                guard body.contains("<h1>"), body.contains("<pre") else { throw CocoaError(.coderInvalidValue) }
                self.logger.notice("Parser cold setup_ms=\((loaded-start)*1000) first_ms=\((rendered-loaded)*1000) total_ms=\((rendered-start)*1000) input_bytes=\(source.utf8.count) output_bytes=\(body.utf8.count)")
                // Spike measurements only. Production must render once and enforce file/time limits.
                for index in 1...5 {
                    let before = ProcessInfo.processInfo.systemUptime
                    let warm = try renderer.render(source)
                    let elapsed = (ProcessInfo.processInfo.systemUptime-before)*1000
                    guard warm == body else { throw CocoaError(.coderInvalidValue) }
                    self.logger.notice("Parser warm sample=\(index) render_ms=\(elapsed) output_bytes=\(warm.utf8.count) equal=true")
                }
                let css = try String(contentsOf: resources.appendingPathComponent("katex-inline.css"), encoding: .utf8)
                html = """
                <!doctype html><html><head><meta charset="utf-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
                <style>\(css)
                body{background:white;color:#222;font:18px system-ui;padding:32px}pre{white-space:pre-wrap}a{color:#0057aa}</style>
                </head><body>\(body)</body></html>
                """
            }
            self.logger.notice("Data ready bytes=\(html.utf8.count)")
            return Data(html.utf8)
        }
        handler(reply, nil)
    }
}
