import Foundation

@main
struct PreviewTests {
    static func main() throws {
        let bundlePath = CommandLine.arguments[1]
        guard let bundle = Bundle(path: bundlePath) else { fatalError("Missing packaged preview bundle") }
        let renderer = try StaticRenderer(bundle: bundle)
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("fixture.md")
        func read(_ bytes: Data) throws -> PreviewSource {
            try bytes.write(to: file)
            return try PreviewSource.read(file)
        }
        let empty = try read(Data())
        precondition(empty.text.isEmpty && empty.bytesRead == 0 && !empty.truncated && !empty.invalidUtf8)
        let invalid = try read(Data([0x61, 0xff, 0x62]))
        precondition(invalid.text == "a\u{fffd}b" && invalid.invalidUtf8)
        let exact = try read(Data(repeating: 0x61, count: PreviewSource.byteLimit))
        precondition(exact.bytesRead == PreviewSource.byteLimit && !exact.truncated)
        let large = try read(Data(repeating: 0x61, count: PreviewSource.byteLimit + 100))
        precondition(large.bytesRead == PreviewSource.byteLimit && large.truncated)
        let hostile = try read(Data("<script>alert('x')</script>\n![image](https://example.com/x.png)".utf8))
        let html = try renderer.html(source: hostile, filePath: "/tmp/<file>.md", dark: false)
        precondition(html.contains("&lt;script&gt;") && !html.contains("<script>"))
        precondition(html.contains("&lt;file&gt;.md") && html.contains("script-src 'none'"))
        precondition(!html.contains("<img") && !html.contains("<a "))
        let largeHTML = try renderer.html(source: large, filePath: file.path, dark: true)
        precondition(largeHTML.contains("Showing the first 4 MB"))
        precondition(largeHTML.contains("color-scheme:dark"))
        let invalidHTML = try renderer.html(source: invalid, filePath: file.path, dark: false)
        precondition(invalidHTML.contains("Invalid UTF-8 bytes"))
        let repeated = try renderer.html(source: hostile, filePath: "/tmp/<file>.md", dark: false)
        precondition(repeated == html)
        print("PASS: packaged JavaScriptCore entry, escaping, no resource tags, empty and invalid UTF-8, exact 4 MB and truncation, appearance, repeat render")
    }
}
