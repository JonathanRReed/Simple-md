import AppKit
import UniformTypeIdentifiers

struct HandlerResult: Encodable {
    let type: String
    let extensions: [String]
    let handler: String?
    let success: Bool
    let error: String?
    enum CodingKeys: String, CodingKey { case type, extensions, handler, success, error }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(extensions, forKey: .extensions)
        try container.encode(handler, forKey: .handler)
        try container.encode(success, forKey: .success)
        try container.encode(error, forKey: .error)
    }
}

@main
struct DefaultApp {
    @MainActor static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 2, ["--set", "--query"].contains(arguments[0]), arguments[1].hasSuffix(".app") else {
            FileHandle.standardError.write(Data("Usage: simplemd-default-app --set|--query /path/to/SimpleMD.app\n".utf8))
            exit(2)
        }
        let application = URL(fileURLWithPath: arguments[1]).resolvingSymlinksInPath()
        var types: [String: (UTType, [String])] = [:]
        for ext in ["md", "markdown", "mdown", "mkd", "mdx"] {
            for type in UTType.types(tag: ext, tagClass: .filenameExtension, conformingTo: nil) {
                var entry = types[type.identifier] ?? (type, [])
                entry.1.append(ext)
                types[type.identifier] = entry
            }
        }
        var results: [HandlerResult] = []
        for identifier in types.keys.sorted() {
            guard let (type, extensions) = types[identifier] else { continue }
            var failure: String?
            if arguments[0] == "--set" {
                failure = await withCheckedContinuation { continuation in
                    NSWorkspace.shared.setDefaultApplication(at: application, toOpen: type) { error in
                        continuation.resume(returning: error?.localizedDescription)
                    }
                }
            }
            let handler = NSWorkspace.shared.urlForApplication(toOpen: type)?.resolvingSymlinksInPath()
            results.append(HandlerResult(type: identifier, extensions: extensions, handler: handler?.path,
                                         success: handler == application, error: failure))
        }
        do {
            let data = try JSONEncoder().encode(results)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("Could not encode default handlers.\n".utf8))
            exit(1)
        }
    }
}
