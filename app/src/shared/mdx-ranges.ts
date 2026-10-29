import { parse, postprocess, preprocess } from "micromark";
import { mdxjs, type Extension } from "micromark-extension-mdxjs";

export type MdxKind = "esm" | "jsx-flow" | "jsx-text" | "expression-flow" | "expression-text" | "mdx-comment";
export interface MdxSpan {
  /** Half-open UTF-16 offsets into the unchanged source. */
  start: number;
  end: number;
  /** One-based lines containing start and the last included character. */
  startLine: number;
  endLine: number;
}
export interface MdxSyntaxSpan extends MdxSpan {
  kind: "esm" | "tag-name" | "attribute" | "expression" | "comment";
}
export type MdxRange = MdxSpan & { syntax: MdxSyntaxSpan[] } & (
  | { kind: "jsx-flow" | "jsx-text"; name: string | null; capitalized: boolean }
  | { kind: "esm" | "expression-flow" | "expression-text" | "mdx-comment" }
);
export interface MdxParseError extends MdxSpan {
  message: string;
  /** Parser failure location. start/end identify source to display escaped. */
  offset: number;
  line: number;
}
/** JSX elements include their children. Nested ranges may overlap.
 * When crossing a worker boundary, send { ranges, error: ranges.error } explicitly.
 */
export interface MdxRanges extends Array<MdxRange> {
  error?: MdxParseError;
}

type Tokenizer = ReturnType<ReturnType<typeof parse>["text"]>;
type Token = Tokenizer["events"][number][1];
type Construct = Exclude<NonNullable<Extension["text"]>[string], unknown[] | undefined>;
type State = ReturnType<Construct["tokenize"]>;

// MDX normally rejects HTML comments. Recognize only comments here, leaving
// fenced/inline code, JSX attributes, and JavaScript strings to their tokenizers.
const htmlComment: Construct = {
  concrete: true,
  tokenize(effects, ok, nok) {
    let prefix = 0;
    let dashes = 0;
    return open;
    function open(code: Parameters<State>[0]): ReturnType<State> {
      if (code !== "<!--".charCodeAt(prefix)) return nok(code);
      if (prefix === 0) effects.enter("htmlText");
      effects.consume(code);
      return ++prefix === 4 ? body : open;
    }
    function body(code: Parameters<State>[0]): ReturnType<State> {
      if (code === null) {
        effects.exit("htmlText");
        return ok(code);
      }
      effects.consume(code);
      if (code === 62 && dashes >= 2) {
        effects.exit("htmlText");
        return ok;
      }
      dashes = code === 45 ? dashes + 1 : 0;
      return body;
    }
  },
};

function lineStarts(source: string): number[] {
  const starts = [0];
  const endings = /\r\n|[\r\n]/g;
  for (const match of source.matchAll(endings)) starts.push(match.index + match[0].length);
  return starts;
}

/** Parse only. No compilation, rendering, module loading, or evaluation. */
export function findMdxRanges(source: string): MdxRanges {
  const starts = lineStarts(source);
  function lineAt(offset: number): number {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  }
  function span(start: number, end: number): MdxSpan {
    return { start, end, startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)) };
  }

  // Keep the same offsets and line endings while excluding YAML frontmatter.
  const frontmatter = /^(?:\uFEFF)?---[^\S\r\n]*(?:\r\n|[\r\n])[\s\S]*?(?:\r\n|[\r\n])(?:---|\.\.\.)[^\S\r\n]*(?:(?:\r\n|[\r\n])|$)/.exec(source);
  const bom = !frontmatter && source.startsWith("\uFEFF") ? 1 : 0;
  const input = frontmatter ? frontmatter[0].replace(/[^\r\n]/g, " ") + source.slice(frontmatter[0].length) : source.slice(bom);
  const parser = parse({ extensions: [mdxjs({ addResult: false }), { flow: { 60: htmlComment }, text: { 60: htmlComment } }] });
  const contexts: Tokenizer[] = [];
  // Keep child contexts as well as the document context. A tokenizer can throw
  // before postprocess copies its completed tokens into the document events.
  for (const key of ["document", "flow", "content", "text", "string"] as const) {
    const create = parser[key];
    parser[key] = (from) => {
      const context = create(from);
      contexts.push(context);
      return context;
    };
  }
  const ranges: MdxRanges = [];
  let events: Tokenizer["events"] = [];
  let failure: unknown;
  try {
    events = postprocess(parser.document({ line: 1, column: 1, offset: bom }).write(preprocess()(input, undefined, true)));
  } catch (error) {
    failure = error;
  }
  const completed = new Set<Token>();
  const incomplete = new Set<Token>();
  for (const list of [events, ...contexts.map((context) => context.events)]) {
    for (const [event, token] of list) {
      if (!/^(?:mdx|htmlText)/.test(token.type)) continue;
      if (event === "exit") completed.add(token);
      else if (!token.end) incomplete.add(token);
    }
  }
  const tokens = [...completed].sort((a, b) => a.start.offset - b.start.offset || b.end.offset - a.end.offset);
  const syntax: MdxSyntaxSpan[] = [];
  const tags: { range: Extract<MdxRange, { name: string | null }>; closing: boolean; selfClosing: boolean }[] = [];
  for (const token of tokens) {
    const { offset: start } = token.start;
    const { offset: end } = token.end;
    const text = source.slice(start, end);
    const position = span(start, end);
    const type: string = token.type;
    if (/^mdxJsx(?:Flow|Text)TagName$/.test(type)) syntax.push({ ...span(start, start + text.trimEnd().length), kind: "tag-name" });
    else if (/^mdxJsx(?:Flow|Text)TagAttributeName$/.test(type)) syntax.push({ ...position, kind: "attribute" });
    else if (/^mdxJsx(?:Flow|Text)Tag(?:AttributeValueExpression|ExpressionAttribute)$/.test(type)) syntax.push({ ...position, kind: "expression" });
    if (type === "mdxJsxFlowTag" || type === "mdxJsxTextTag") {
      const name = /^<\/?([^\s/>]*)/.exec(text)?.[1] || null;
      tags.push({
        range: { ...position, kind: type === "mdxJsxFlowTag" ? "jsx-flow" : "jsx-text", name, capitalized: name !== null && /^[A-Z]/.test(name), syntax: [] },
        closing: text.startsWith("</"),
        selfClosing: !text.startsWith("</") && /\/\s*>$/.test(text),
      });
    } else if (type === "mdxjsEsm" || type === "mdxFlowExpression" || type === "mdxTextExpression" || (type === "htmlText" && text.startsWith("<!--"))) {
      const comment = type === "htmlText" || /^\{\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|[\r\n]))\s*)+\}$/.test(text);
      const kind = comment ? "mdx-comment" : type === "mdxjsEsm" ? "esm" : type === "mdxFlowExpression" ? "expression-flow" : "expression-text";
      const highlight: MdxSyntaxSpan = { ...position, kind: comment ? "comment" : kind === "esm" ? "esm" : "expression" };
      ranges.push({ ...position, kind, syntax: [highlight] });
      if (type === "htmlText" && !text.endsWith("-->")) setError(start, source.length, "Unclosed HTML comment");
    }
  }

  function setError(start: number, offset: number, message: string): void {
    const previous = ranges.error;
    if (previous && previous.offset < offset) {
      offset = previous.offset;
      message = previous.message;
    }
    ranges.error = { ...span(Math.min(start, previous?.start ?? start), source.length), offset, line: lineAt(offset), message };
  }
  const stack: typeof tags = [];
  for (const tag of tags) {
    if (tag.selfClosing) ranges.push(tag.range);
    else if (!tag.closing) stack.push(tag);
    else {
      const open = stack.at(-1);
      if (!open || open.range.name !== tag.range.name || open.range.kind !== tag.range.kind) {
        setError(tag.range.start, tag.range.start, `Unexpected closing tag ${tag.range.name ?? "fragment"}`);
      } else {
        stack.pop();
        ranges.push({ ...open.range, ...span(open.range.start, tag.range.end) });
      }
    }
  }
  for (const open of stack) {
    ranges.push(open.range);
    setError(open.range.start, source.length, `Unclosed tag ${open.range.name ?? "fragment"}`);
  }
  if (failure !== undefined) {
    const at = typeof failure === "object" && failure !== null && "place" in failure ? failure.place : undefined;
    const offset = typeof at === "object" && at !== null && "offset" in at && typeof at.offset === "number" ? Math.min(source.length, Math.max(0, at.offset)) : 0;
    let start = offset;
    for (const token of incomplete) start = Math.min(start, token.start.offset);
    setError(start, offset, failure instanceof Error ? failure.message : "Invalid MDX");
  }
  // Assign each token to its innermost JSX range, avoiding duplicate marks.
  const jsx = ranges.filter((range) => range.kind === "jsx-flow" || range.kind === "jsx-text").sort((a, b) => a.start - b.start || b.end - a.end);
  const owners: typeof jsx = [];
  let next = 0;
  for (const mark of syntax) {
    while (next < jsx.length && jsx[next]!.start <= mark.start) {
      const range = jsx[next++]!;
      while (owners.length && owners.at(-1)!.end <= range.start) owners.pop();
      owners.push(range);
    }
    while (owners.length && owners.at(-1)!.end < mark.end) owners.pop();
    owners.at(-1)?.syntax.push(mark);
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

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
