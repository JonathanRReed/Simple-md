import { clipboard, ClipboardItem } from "electron";

const findType = "electron application/findtext";
export async function readFindText(): Promise<string> {
  if (process.platform !== "darwin") return "";
  try {
    for (const item of await clipboard.read()) {
      if (item.types.includes(findType)) return await (await item.getType(findType)).text();
    }
  } catch { /* Finding remains available if the system pasteboard is unavailable. */ }
  return "";
}
export async function writeFindText(text: string): Promise<void> {
  if (process.platform !== "darwin" || !text) return;
  try { await clipboard.write([new ClipboardItem({ [findType]: text })]); }
  catch { /* Keep the document selection when the pasteboard is unavailable. */ }
}
