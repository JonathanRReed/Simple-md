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
        var prefix = data
        if truncated, !data.isEmpty {
            var lead = data.count - 1
            while lead > max(0, data.count - 4), data[lead] & 0xc0 == 0x80 { lead -= 1 }
            let byte = data[lead]
            let length = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1
            if data.count - lead < length { prefix = data.prefix(lead) }
        }
        return PreviewSource(text: String(decoding: prefix, as: UTF8.self), bytesRead: data.count,
                      truncated: truncated, invalidUtf8: String(data: prefix, encoding: .utf8) == nil)
    }
}
