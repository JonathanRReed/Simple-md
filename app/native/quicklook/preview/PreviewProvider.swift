import Cocoa
import QuickLookUI
import os

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    private static let processStarted = ProcessInfo.processInfo.systemUptime
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.quicklook", category: "preview")

    override init() {
        super.init()
        logger.notice("Provider initialized pid=\(getpid()) uptime=\(Self.processStarted)")
    }

    func providePreview(for request: QLFilePreviewRequest,
                        completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void) {
        let started = ProcessInfo.processInfo.systemUptime
        let name = request.fileURL.lastPathComponent
        logger.notice("Preview preparing file=\(name, privacy: .private) pid=\(getpid())")
        DispatchQueue.global(qos: .userInitiated).async { [logger] in
            do {
                let dequeued = ProcessInfo.processInfo.systemUptime
                let source = try PreviewSource.read(request.fileURL)
                let read = ProcessInfo.processInfo.systemUptime
                let html = StaticRenderer.preview(source: source, filePath: request.fileURL.path, bundle: Bundle(for: PreviewProvider.self))
                let data = Data(html.utf8)
                let reply = QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 800, height: 600)) { reply in
                    reply.stringEncoding = .utf8
                    return data
                }
                let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
                logger.notice("Preview stages file=\(name, privacy: .private) queue_ms=\((dequeued-started)*1000) file_read_ms=\((read-dequeued)*1000)")
                logger.notice("Preview ready file=\(name, privacy: .private) read_bytes=\(source.bytesRead) truncated=\(source.truncated) invalid_utf8=\(source.invalidUtf8) html_bytes=\(data.count) elapsed_ms=\(elapsed)")
                handler(reply, nil)
            } catch {
                logger.error("Preview failed file=\(name, privacy: .private) error=\(error.localizedDescription, privacy: .private)")
                handler(nil, error)
            }
        }
    }
}
