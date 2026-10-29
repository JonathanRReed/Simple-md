import Foundation
import QuickLookThumbnailing
import os

@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.quicklook", category: "thumbnail")

    override func provideThumbnail(for request: QLFileThumbnailRequest,
                                   _ handler: @escaping (QLThumbnailReply?, Error?) -> Void) {
        let started = ProcessInfo.processInfo.systemUptime
        do {
            let (card, bytesRead) = try ThumbnailCard.read(request.fileURL)
            let size = request.maximumSize
            let drawingScale = request.scale
            let name = request.fileURL.lastPathComponent
            logger.notice("Thumbnail preparing file=\(name, privacy: .public) bytes=\(bytesRead) size=\(size.width)x\(size.height) scale=\(request.scale)")
            let reply = QLThumbnailReply(contextSize: size) { [logger] context in
                context.saveGState()
                context.scaleBy(x: drawingScale, y: drawingScale)
                card.draw(in: context, size: size)
                context.restoreGState()
                let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
                logger.notice("Thumbnail drawn file=\(name, privacy: .public) elapsed_ms=\(elapsed)")
                return true
            }
            reply.extensionBadge = card.badge
            handler(reply, nil)
        } catch {
            logger.error("Thumbnail read failed: \(error.localizedDescription, privacy: .public)")
            handler(nil, error)
        }
    }
}
