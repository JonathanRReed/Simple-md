import Foundation
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for w in windows where ["qlmanage", "QuickLookUIService", "Quick Look", "Finder"].contains(w[kCGWindowOwnerName as String] as? String ?? "") {
    print(String(data: try! JSONSerialization.data(withJSONObject: w, options: [.sortedKeys]), encoding: .utf8)!)
}
