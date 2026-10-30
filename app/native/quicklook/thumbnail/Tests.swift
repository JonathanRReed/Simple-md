import Foundation
import CoreGraphics
import ImageIO

@main
struct ThumbnailTests {
    static func main() throws {
        let mdx = ThumbnailCard.parse("""
        ---
        title: Hidden title
        ---
        import Thing from './thing.js'
        export const value = 42
        # **Visible** [heading](https://example.com)
        Opening *words* and an [example](https://example.com).
        ```swift
        # Not a heading
        let snake_case = "*literal*"
        ```
        ## Second heading
        """, filename: "fixture.MDX")
        precondition(mdx.title == "Visible heading")
        precondition(mdx.badge == "MDX")
        precondition(mdx.lines.map(\.text) == [
            "Opening words and an example.", "# Not a heading", "let snake_case = \"*literal*\"", "Second heading"
        ])
        precondition(mdx.lines.map(\.isCode) == [false, true, true, false])

        let plain = ThumbnailCard.parse("No heading, just **text**.", filename: "Notes.md")
        precondition(plain.title == "Notes.md" && plain.lines.first?.text == "No heading, just text.")
        precondition(ThumbnailCard.parse("* **Bullet**\n- [x] Done\n> Quote", filename: "a.md").lines.map(\.text)
                     == ["Bullet", "Done", "Quote"])
        precondition(ThumbnailCard.parse("", filename: "empty.md").lines.isEmpty)
        precondition(ThumbnailCard.parse("Title\n=====\nBody", filename: "a.md").title == "Title")
        precondition(ThumbnailCard.parse("\u{FEFF}---\r\nhide: me\r\n...\r\n# Hello\r\n", filename: "a.md").title == "Hello")
        precondition(ThumbnailCard.parse("~~~\n# Code\n~~~\n# Title", filename: "a.md").title == "Title")
        precondition(ThumbnailCard.parse("# " + String(repeating: "x", count: 300), filename: "a.md").title.count == 180)

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("large.md")
        try Data((String(repeating: "x", count: ThumbnailCard.byteLimit) + "\n# Must not read").utf8).write(to: url)
        let large = try ThumbnailCard.read(url)
        precondition(large.bytesRead == 65_536 && large.card.title == "large.md")
        precondition(large.card.lines.count == 1 && large.card.lines[0].text.count == 512)
        try Data([0x23, 0x20, 0xFF, 0xFE, 0x0A, 0x41]).write(to: url)
        let invalid = try ThumbnailCard.read(url)
        precondition(invalid.card.title == "\u{FFFD}\u{FFFD}" && invalid.card.lines[0].text == "A")
        precondition(ThumbnailCard.parse(String(repeating: "text\n", count: 100), filename: "a.md").lines.count == 24)
        print("PASS: headings, fallback, frontmatter, MDX, fences, invalid UTF-8, and read/layout bounds")
        for path in CommandLine.arguments.dropFirst() {
            let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
            let width = image.width
            let height = image.height
            var pixels = [UInt8](repeating: 0, count: width * height * 4)
            pixels.withUnsafeMutableBytes { bytes in
                let context = CGContext(data: bytes.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                for x in [width / 10, width * 9 / 10] {
                    for y in [height / 10, height * 9 / 10] {
                        precondition(bytes[(y * width + x) * 4 + 3] == 255,
                                     "Paper does not fill the requested canvas: \(path)")
                    }
                }
            }
            print("PASS: paper fills all four inset corners in \(path)")
        }
    }
}
