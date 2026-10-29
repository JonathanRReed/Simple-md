import Cocoa
import QuickLookThumbnailing
let file = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let request = QLThumbnailGenerator.Request(fileAt: file, size: CGSize(width: 512, height: 512),
                                          scale: 1, representationTypes: .thumbnail)
QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
    guard let representation else {
        print("ERROR", error as Any)
        exit(1)
    }
    do {
        guard let data = NSBitmapImageRep(cgImage: representation.cgImage).representation(using: .png, properties: [:])
            else { exit(2) }
        try data.write(to: output)
        print("Representation", representation.type.rawValue)
        exit(0)
    } catch {
        print(error)
        exit(3)
    }
}
RunLoop.main.run()
