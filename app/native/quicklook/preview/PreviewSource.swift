import Foundation

struct PreviewSource {
    static let byteLimit = 4 * 1024 * 1024
    let text: String
    let bytesRead: Int
    let truncated: Bool
    let invalidUtf8: Bool

    static func read(_ url: URL) throws -> PreviewSource {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        guard try file.seekToEnd() > UInt64(byteLimit) else {
            try file.seek(toOffset: 0)
            return decode(try file.read(upToCount: byteLimit) ?? Data(), truncated: false)
        }
        try file.seek(toOffset: 0)
        return decode(try file.read(upToCount: byteLimit) ?? Data(), truncated: true)
    }

    private static func decode(_ data: Data, truncated: Bool) -> PreviewSource {
        PreviewSource(text: String(decoding: data, as: UTF8.self), bytesRead: data.count,
                      truncated: truncated, invalidUtf8: String(data: data, encoding: .utf8) == nil)
    }
}
