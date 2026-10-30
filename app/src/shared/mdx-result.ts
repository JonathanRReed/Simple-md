import type { MdxParseError, MdxRange, MdxSpan } from "./mdx-ranges.js";

export function isMdxResult(value: unknown): value is { ranges: MdxRange[]; error?: MdxParseError } {
  const isSpan = (span: unknown): span is MdxSpan => typeof span === "object" && span !== null &&
    "start" in span && Number.isSafeInteger(span.start) && typeof span.start === "number" && span.start >= 0 &&
    "end" in span && typeof span.end === "number" && Number.isSafeInteger(span.end) && span.end >= span.start &&
    "startLine" in span && typeof span.startLine === "number" && Number.isSafeInteger(span.startLine) && span.startLine > 0 &&
    "endLine" in span && typeof span.endLine === "number" && Number.isSafeInteger(span.endLine) && span.endLine >= span.startLine;
  if (typeof value !== "object" || value === null || !("ranges" in value) || !Array.isArray(value.ranges)) return false;
  if (!value.ranges.every((range: unknown) => isSpan(range) && "kind" in range &&
      ["esm", "jsx-flow", "jsx-text", "expression-flow", "expression-text", "mdx-comment"].includes(String(range.kind)) &&
      "syntax" in range && Array.isArray(range.syntax) && range.syntax.every((syntax: unknown) => isSpan(syntax) && "kind" in syntax &&
        ["esm", "tag-name", "attribute", "expression", "comment"].includes(String(syntax.kind))) &&
      (!(range.kind === "jsx-flow" || range.kind === "jsx-text") || ("name" in range && (typeof range.name === "string" || range.name === null) && "capitalized" in range && typeof range.capitalized === "boolean")))) return false;
  return !("error" in value) || value.error === undefined || (isSpan(value.error) && "message" in value.error && typeof value.error.message === "string" &&
    "offset" in value.error && Number.isSafeInteger(value.error.offset) && "line" in value.error && Number.isSafeInteger(value.error.line));
}
