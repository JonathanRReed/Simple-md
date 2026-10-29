import Cocoa
import QuickLookUI
import os

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    static let renderQueue = DispatchQueue(label: "com.jonathanreed.simplemd.preview.render")
    private static let renderer = Result { try StaticRenderer(bundle: Bundle(for: PreviewProvider.self)) }
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.quicklook", category: "preview")

    func providePreview(for request: QLFilePreviewRequest,
                        completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void) {
        let started = ProcessInfo.processInfo.systemUptime
        let name = request.fileURL.lastPathComponent
        logger.notice("Preview preparing file=\(name, privacy: .public) pid=\(getpid())")
        Self.renderQueue.async { [logger] in
            do {
                let source = try PreviewSource.read(request.fileURL)
                let dark = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark"
                let html = try Self.renderer.get().html(source: source, filePath: request.fileURL.path, dark: dark)
                let data = Data(html.utf8)
                let reply = QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 800, height: 600)) { reply in
                    reply.stringEncoding = .utf8
                    return data
                }
                let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
                logger.notice("Preview ready file=\(name, privacy: .public) read_bytes=\(source.bytesRead) truncated=\(source.truncated) invalid_utf8=\(source.invalidUtf8) html_bytes=\(data.count) elapsed_ms=\(elapsed)")
                handler(reply, nil)
            } catch {
                logger.error("Preview failed file=\(name, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
                handler(nil, error)
            }
        }
    }
}
