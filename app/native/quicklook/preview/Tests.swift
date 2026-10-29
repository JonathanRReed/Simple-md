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
        let html = try renderer.html(source: hostile, filePath: "/tmp/<file>.md")
        precondition(!html.contains("<script>") && !html.contains("alert("))
        precondition(html.contains("default-src 'none'") && html.contains("prefers-color-scheme: dark"))
        precondition(!html.contains("<img") && html.contains("Image unavailable: image"))
        let largeHTML = try renderer.html(source: large, filePath: file.path)
        precondition(largeHTML.contains("Showing the first 4 MB"))
        precondition(!largeHTML.contains("data:font/woff2"))
        let invalidHTML = try renderer.html(source: invalid, filePath: file.path)
        precondition(invalidHTML.contains("Invalid UTF-8 bytes"))
        let repeated = try renderer.html(source: hostile, filePath: "/tmp/<file>.md")
        precondition(repeated == html)
        let rich = try read(Data("# Rich\n\n$x^2$\n\n~~~json\n{\"n\":1}\n~~~\n\n~~~mermaid\ngraph LR\nA-->B\n~~~".utf8))
        let richHTML = try renderer.html(source: rich, filePath: file.path)
        precondition(richHTML.contains("class=\"katex\"") && richHTML.contains("data:font/woff2"))
        precondition(richHTML.contains("--shiki-light:") && richHTML.contains("language-mermaid"))
        let mdx = try read(Data("# Inert\n\n<Widget onClick={() => run()} />".utf8))
        let mdxHTML = try renderer.html(source: mdx, filePath: file.path + "x")
        precondition(mdxHTML.contains("mdx-component"))
        print("PASS: real packaged JavaScriptCore renderer, math, Shiki, Mermaid code, inert MDX, hostile HTML, image placeholders, empty and invalid UTF-8, exact 4 MB and truncation, repeat render")
    }
}
