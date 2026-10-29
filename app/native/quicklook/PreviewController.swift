import Cocoa
import QuickLookUI
import WebKit
import os

@objc(PreviewController)
final class PreviewController: NSViewController, QLPreviewingController, WKNavigationDelegate {
    private let logger = Logger(subsystem: "com.jonathanreed.simplemd.qlspike", category: "preview")
    private var completion: ((Error?) -> Void)?
    private var timeout: DispatchWorkItem?
    private var webView: WKWebView!

    override func loadView() {
        preferredContentSize = NSSize(width: 800, height: 600)
        view = NSView(frame: NSRect(origin: .zero, size: preferredContentSize))
        view.autoresizingMask = [.width, .height]
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        view.addSubview(webView)
        logger.notice("WKWebView created pid=\(getpid())")
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        finish(NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        completion = handler
        logger.notice("Preparing \(url.lastPathComponent, privacy: .public) pid=\(getpid())")
        do {
            let source = try String(contentsOf: url, encoding: .utf8)
            let escaped = source.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
            // This placeholder deliberately does not parse Markdown or execute MDX.
            let html = """
            <!doctype html><html><head><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
            <style>:root{color-scheme:light dark}body{font:18px system-ui;padding:32px}
            h1{font-size:28px}pre{white-space:pre-wrap;font:16px ui-monospace,monospace}</style>
            </head><body><h1>SimpleMD Quick Look spike</h1><pre>\(escaped)</pre></body></html>
            """
            _ = view // Load the container before accessing its web view.
            let deadline = DispatchWorkItem { [weak self] in
                self?.finish(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
            }
            timeout = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: deadline)
            webView.loadHTMLString(html, baseURL: nil)
        } catch {
            finish(error)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        logger.notice("WKWebView didFinish pid=\(getpid()) frame=\(String(describing: webView.frame), privacy: .public) root=\(String(describing: self.view.frame), privacy: .public)")
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(NSError(domain: "SimpleMDQLSpike", code: 2))
    }

    private func finish(_ error: Error?) {
        guard let handler = completion else { return }
        completion = nil
        timeout?.cancel()
        timeout = nil
        if let error {
            logger.error("Preview failed: \(error.localizedDescription, privacy: .public)")
        } else {
            logger.notice("Preview ready")
        }
        handler(error)
    }
}
