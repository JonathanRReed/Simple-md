import Foundation
import JavaScriptCore
@main struct Measure {
 static func main() throws {
  let start = ProcessInfo.processInfo.systemUptime
  let context = JSContext()!
  let created = ProcessInfo.processInfo.systemUptime
  let code = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
  let read = ProcessInfo.processInfo.systemUptime
  context.evaluateScript(code)
  let evaluated = ProcessInfo.processInfo.systemUptime
  if let error = context.exception { fatalError(error.toString()) }
  let source = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
  let call = context.evaluateScript("(function(source) { const result = {}; SimpleMDRenderCore.renderStaticHtml(source, '/project/README.md').then(html => result.html = html, error => result.error = String(error)); return result; })")!
  var rows: [[String: Any]] = []
  for _ in 0..<6 {
   let tick = ProcessInfo.processInfo.systemUptime
   let result = call.call(withArguments: [source])!
   guard let html = result.forProperty("html"), html.isString else { fatalError(result.toString()) }
   rows.append(["ms":(ProcessInfo.processInfo.systemUptime-tick)*1000,"html_bytes":html.toString()!.utf8.count])
  }
  let output: [String: Any] = ["context_ms":(created-start)*1000,"bundle_read_ms":(read-created)*1000,"bundle_eval_ms":(evaluated-read)*1000,"bundle_bytes":code.utf8.count,"renders":rows]
  print(String(data:try JSONSerialization.data(withJSONObject:output, options:[.sortedKeys]), encoding:.utf8)!)
 }
}
