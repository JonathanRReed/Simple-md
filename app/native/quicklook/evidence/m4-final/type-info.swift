import Foundation
import UniformTypeIdentifiers
for ext in ["md", "mdx", "txt"] {
    print("EXT", ext, UTType(filenameExtension: ext)?.identifier ?? "none")
}
for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    print("FILE", path, try url.resourceValues(forKeys: [.contentTypeKey]).contentType?.identifier ?? "none")
}
