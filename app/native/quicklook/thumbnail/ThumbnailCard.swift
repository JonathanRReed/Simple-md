import Foundation
import CoreGraphics
import CoreText

struct ThumbnailCard {
    struct Line {
        let text: String
        let isCode: Bool
    }

    static let byteLimit = 64 * 1024
    let title: String
    let lines: [Line]
    let badge: String

    static func read(_ url: URL) throws -> (card: ThumbnailCard, bytesRead: Int) {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        let data = try file.read(upToCount: byteLimit) ?? Data()
        return (parse(String(decoding: data, as: UTF8.self), filename: url.lastPathComponent), data.count)
    }

    static func parse(_ source: String, filename: String) -> ThumbnailCard {
        let isMDX = (filename as NSString).pathExtension.lowercased() == "mdx"
        let text = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}"))
        let rawLines = text.components(separatedBy: "\n")
        var frontmatter = rawLines.first?.trimmingCharacters(in: .whitespaces) == "---"
        var fence: Character?
        var fenceLength = 0
        var title: String?
        var lines: [Line] = []
        var index = frontmatter ? 1 : 0
        while index < rawLines.count {
            let raw = rawLines[index]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            index += 1
            if frontmatter {
                if trimmed == "---" || trimmed == "..." { frontmatter = false }
                continue
            }
            let marker = trimmed.first
            let markerCount = trimmed.prefix { $0 == marker }.count
            if let activeFence = fence {
                if marker == activeFence && markerCount >= fenceLength &&
                    trimmed.dropFirst(markerCount).trimmingCharacters(in: .whitespaces).isEmpty {
                    fence = nil
                } else if lines.count < 24 {
                    lines.append(Line(text: visible(raw), isCode: true))
                }
                continue
            }
            if (marker == "`" || marker == "~") && markerCount >= 3 {
                fence = marker
                fenceLength = markerCount
                continue
            }
            if isMDX && (trimmed == "import" || trimmed.hasPrefix("import ") ||
                         trimmed == "export" || trimmed.hasPrefix("export ")) { continue }
            if trimmed.isEmpty { continue }

            let hashes = trimmed.prefix { $0 == "#" }.count
            let isATX = (1...6).contains(hashes) &&
                (trimmed.count == hashes || trimmed.dropFirst(hashes).first?.isWhitespace == true)
            let next = index < rawLines.count ? rawLines[index].trimmingCharacters(in: .whitespaces) : ""
            let isSetext = !next.isEmpty && (next.allSatisfy { $0 == "=" } || next.allSatisfy { $0 == "-" })
            let plain = inlineText(isATX ? replace(trimmed, #"^#{1,6}\s*|\s+#+\s*$"#, "") : trimmed)
            if isSetext { index += 1 }
            if title == nil && (isATX || isSetext) && !plain.isEmpty {
                title = String(plain.prefix(180))
            } else if lines.count < 24 {
                let body = inlineText(replace(isATX ? plain : trimmed,
                    #"^(?:>\s*|[-+*]\s+|\d+[.)]\s+|\[[ xX]\]\s*)+"#, ""))
                if !body.isEmpty { lines.append(Line(text: visible(body), isCode: false)) }
            }
        }
        return ThumbnailCard(title: title ?? String(visible(filename).prefix(180)), lines: lines,
                             badge: isMDX ? "MDX" : "MD")
    }

    private static func replace(_ text: String, _ pattern: String, _ replacement: String) -> String {
        text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }

    private static func inlineText(_ text: String) -> String {
        var result = replace(text, #"!?\[([^\]]*)\]\([^)]*\)"#, "$1")
        result = replace(result, #"\[([^\]]+)\]\[[^\]]*\]"#, "$1")
        result = replace(result, #"[*`~]"#, "")
        result = replace(result, #"(?<!\w)_+|_+(?!\w)"#, "")
        return visible(result)
    }

    private static func visible(_ text: String) -> String {
        let scalars = text.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) || $0 == "\t"
        }
        return String(String(String.UnicodeScalarView(scalars))
            .replacingOccurrences(of: "\t", with: "    ").prefix(512))
    }

    func draw(in context: CGContext, size: CGSize) {
        context.saveGState()
        defer { context.restoreGState() }
        // The provider maps the pixel-backed context to the requested point size.
        let scale = min(size.width, size.height) / 512
        context.scaleBy(x: scale, y: scale)
        let width = size.width / scale
        let height = size.height / scale
        let paper = CGRect(x: 14, y: 12, width: width - 28, height: height - 24)
        let shape = CGPath(roundedRect: paper, cornerWidth: 14, cornerHeight: 14, transform: nil)
        context.setShadow(offset: CGSize(width: 0, height: -2), blur: 7,
                          color: CGColor(gray: 0, alpha: 0.12))
        context.setFillColor(CGColor(red: 0.992, green: 0.985, blue: 0.965, alpha: 1))
        context.addPath(shape)
        context.fillPath()
        context.setShadow(offset: .zero, blur: 0)
        context.setStrokeColor(CGColor(gray: 0.80, alpha: 1))
        context.setLineWidth(1)
        context.addPath(shape)
        context.strokePath()
        context.addPath(shape)
        context.clip()

        let left: CGFloat = 44
        let contentWidth = width - 88
        let badgeRect = CGRect(x: left, y: height - 80, width: badge == "MDX" ? 57 : 46, height: 28)
        context.setFillColor(CGColor(red: 0.88, green: 0.91, blue: 0.89, alpha: 1))
        context.addPath(CGPath(roundedRect: badgeRect, cornerWidth: 6, cornerHeight: 6, transform: nil))
        context.fillPath()
        drawText(badge, font: "Helvetica-Bold", size: 13,
                 rect: badgeRect.insetBy(dx: 9, dy: 6), context: context)
        drawText(title, font: "Helvetica-Bold", size: 30,
                 rect: CGRect(x: left, y: height - 188, width: contentWidth, height: 86), context: context)
        context.setStrokeColor(CGColor(gray: 0.82, alpha: 1))
        context.move(to: CGPoint(x: left, y: height - 205))
        context.addLine(to: CGPoint(x: width - left, y: height - 205))
        context.strokePath()

        var top = height - 225
        for line in lines {
            guard top > 54 else { break }
            let font = CTFontCreateWithName((line.isCode ? "Menlo-Regular" : "Helvetica") as CFString,
                                            line.isCode ? 15 : 18, nil)
            let string = attributed(line.text, font: font)
            let framesetter = CTFramesetterCreateWithAttributedString(string)
            var fit = CFRange()
            let textWidth = contentWidth - (line.isCode ? 16 : 0)
            let measured = CTFramesetterSuggestFrameSizeWithConstraints(
                framesetter, CFRange(location: 0, length: 0), nil,
                CGSize(width: textWidth, height: 10_000), &fit)
            let available = top - 48
            let lineHeight: CGFloat = line.isCode ? 22 : 25
            let blockHeight = min(ceil(measured.height / lineHeight) * lineHeight + 4, available)
            guard blockHeight >= lineHeight else { break }
            if line.isCode {
                context.setFillColor(CGColor(red: 0.93, green: 0.93, blue: 0.91, alpha: 1))
                context.fill(CGRect(x: left, y: top - blockHeight, width: contentWidth, height: blockHeight))
            }
            let rect = CGRect(x: left + (line.isCode ? 8 : 0), y: top - blockHeight,
                              width: textWidth, height: blockHeight)
            drawFrame(framesetter, rect: rect, context: context)
            top -= blockHeight + (line.isCode ? 0 : 8)
        }
    }

    private func attributed(_ text: String, font: CTFont) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.16, alpha: 1)
        ])
    }

    private func drawText(_ text: String, font: String, size: CGFloat, rect: CGRect, context: CGContext) {
        let font = CTFontCreateWithName(font as CFString, size, nil)
        drawFrame(CTFramesetterCreateWithAttributedString(attributed(text, font: font)), rect: rect, context: context)
    }

    private func drawFrame(_ framesetter: CTFramesetter, rect: CGRect, context: CGContext) {
        context.saveGState()
        context.clip(to: rect)
        context.textMatrix = .identity
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0),
                                             CGPath(rect: rect, transform: nil), nil)
        CTFrameDraw(frame, context)
        context.restoreGState()
    }
}
