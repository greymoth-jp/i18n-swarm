import { parse } from "@vue/compiler-sfc";
import type { Candidate, Klass, ExtractReport } from "./types.ts";

// @vue/compiler-dom NodeTypes (kept as local constants so we do not depend on
// the enum export shape across compiler versions).
const ELEMENT = 1;
const TEXT = 2;
const ATTRIBUTE = 6;

// Tags whose text content is never user-facing copy.
const CODE_TAGS = new Set(["script", "style", "code", "pre", "textarea"]);
// Static attributes that hold user-facing copy and are safe to rewire to a binding.
const TEXT_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-placeholder"]);
// Attributes that are never user-facing copy (routes, urls, ids, technical values).
const NEVER_COPY_ATTRS = new Set([
  "to", "href", "src", "id", "name", "for", "type", "value", "key", "ref", "rel",
  "target", "lang", "dir", "role", "width", "height", "min", "max", "step", "d",
  "fill", "stroke", "viewbox", "xmlns", "style", "class", "model", "v-model",
]);
// Icon-font ligature carriers: their text IS the glyph; translating breaks the icon.
const ICON_CLASS = /\bmaterial-(icons|symbols)/;

const hasLetter = (s: string): boolean => /\p{L}/u.test(s);
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

interface AnyNode {
  type: number;
  tag?: string;
  content?: string;
  props?: AnyNode[];
  children?: AnyNode[];
  name?: string;
  value?: { content: string; loc: Loc };
  loc: Loc;
}
interface Loc { start: { offset: number }; end: { offset: number }; source: string }

function classOf(el: AnyNode): string {
  const c = (el.props ?? []).find((p) => p.type === ATTRIBUTE && p.name === "class");
  return c?.value?.content ?? "";
}

/** An element directly containing BOTH non-whitespace text AND child elements is a
 *  prose sentence (e.g. "Vue's <a>docs</a> provide..."); its text fragments cannot
 *  be auto-wrapped without splitting, so everything under it is AMBIGUOUS. */
function isSentenceContainer(el: AnyNode): boolean {
  let hasText = false;
  let hasEl = false;
  for (const ch of el.children ?? []) {
    if (ch.type === TEXT && norm(ch.content ?? "")) hasText = true;
    else if (ch.type === ELEMENT) hasEl = true;
  }
  return hasText && hasEl;
}

/** Inner trimmed [start,end] offsets of a text node (preserve surrounding ws).
 *  Trims against loc.source (the exact source slice) so offsets never drift on
 *  CRLF files or entity-decoded content. */
function innerSpan(node: AnyNode): { start: number; end: number; raw: string } {
  const raw0 = node.loc.source ?? node.content ?? "";
  const s0 = node.loc.start.offset;
  const lead = raw0.length - raw0.replace(/^\s+/, "").length;
  const trail = raw0.length - raw0.replace(/\s+$/, "").length;
  const start = s0 + lead;
  const end = node.loc.end.offset - trail;
  return { start, end, raw: raw0.slice(lead, raw0.length - trail) };
}

function classifyText(node: AnyNode, parent: AnyNode | null, inSentence: boolean, inCode: boolean): Candidate | null {
  const text = norm(node.content ?? "");
  if (!text) return null; // pure whitespace: not a candidate at all
  const { start, end, raw } = innerSpan(node);
  const base = { kind: "text" as const, tag: parent?.tag ?? "", text, raw, start, end };
  const skip = (reason: string): Candidate => ({ file: "", cls: "SKIP", reason, ...base });

  if (inCode) return skip("inside code/preformatted block");
  if (parent && ICON_CLASS.test(classOf(parent))) return skip("icon-font ligature (would break the glyph)");
  if (!hasLetter(text)) return skip("no natural-language letters (number/symbol)");
  // single dotted/hyphenated numeric token: version / id / SKU, not copy (e.g. v2.3.1)
  if (!/\s/.test(text) && /\d/.test(text) && /[.\-_:]\d/.test(text)) return skip("version/identifier-like token");
  if (inSentence) return { file: "", cls: "AMBIGUOUS", reason: "fragment of a mixed text+markup sentence", ...base };
  // Sole, clean text content of its element -> safe to wrap.
  return { file: "", cls: "HIGH", reason: "sole text child of <" + (parent?.tag ?? "?") + ">", ...base };
}

function classifyAttr(attr: AnyNode, ownerTag: string): Candidate | null {
  if (attr.type !== ATTRIBUTE || !attr.value) return null;
  const val = norm(attr.value.content);
  if (!val || !hasLetter(val)) return null;
  const name = attr.name ?? "";
  if (NEVER_COPY_ATTRS.has(name.toLowerCase())) return null;
  const raw = attr.loc.source;
  const start = attr.loc.start.offset;
  const end = attr.loc.end.offset;
  const base = { kind: "attr" as const, attrName: name, tag: ownerTag, text: val, raw, start, end };
  if (TEXT_ATTRS.has(name)) {
    return { file: "", cls: "HIGH", reason: `user-facing attribute "${name}"`, ...base };
  }
  // A string prop on a child component (Capitalized / kebab-with-dash tag) MIGHT be
  // display text, but could just as well be an id/url/mode -> never auto-rewire.
  const isComponent = /[A-Z]/.test(ownerTag) || ownerTag.includes("-");
  if (isComponent) {
    return { file: "", cls: "AMBIGUOUS", reason: `string prop "${name}" on component <${ownerTag}> (may not be copy)`, ...base };
  }
  return null;
}

function walk(node: AnyNode, parent: AnyNode | null, inSentence: boolean, inCode: boolean, out: Candidate[]): void {
  if (node.type === TEXT) {
    const c = classifyText(node, parent, inSentence, inCode);
    if (c) out.push(c);
    return;
  }
  if (node.type !== ELEMENT) return; // interpolation/comment/etc: not literal copy
  const tag = (node.tag ?? "").toLowerCase();
  const childCode = inCode || CODE_TAGS.has(tag);
  // attributes
  for (const p of node.props ?? []) {
    const c = classifyAttr(p, node.tag ?? "");
    if (c) out.push(c);
  }
  // A named slot (<template #heading>) is a distinct content region, not part of
  // any surrounding prose flow, so the sentence context resets at its boundary.
  const isSlotTemplate = tag === "template" && (node.props ?? []).some((p) => p.type === 7 && p.name === "slot");
  const childSentence = isSlotTemplate ? isSentenceContainer(node) : inSentence || isSentenceContainer(node);
  for (const ch of node.children ?? []) walk(ch, node, childSentence, childCode, out);
}

/** Parse one SFC and classify every text node + attribute. */
export function extractFile(file: string, source: string): ExtractReport {
  let candidates: Candidate[] = [];
  let parseError: string | null = null;
  try {
    const { descriptor, errors } = parse(source, { filename: file });
    if (errors.length) parseError = String(errors[0]?.message ?? errors[0]);
    const ast = descriptor.template?.ast as unknown as AnyNode | undefined;
    if (ast) {
      for (const ch of ast.children ?? []) walk(ch, null, false, false, candidates);
    } else if (!parseError) {
      parseError = "no <template> block";
    }
  } catch (e) {
    parseError = (e as Error).message;
  }
  candidates = candidates.map((c) => ({ ...c, file }));
  // Verify every offset actually points at the raw text (defends against
  // offset-base drift); demote mismatches to SKIP so rewire never corrupts.
  for (const c of candidates) {
    const slice = source.slice(c.start, c.end);
    if (slice !== c.raw) {
      c.cls = "SKIP";
      c.reason = "offset/source mismatch (not rewired)";
    }
  }
  const count = (k: Klass) => candidates.filter((c) => c.cls === k).length;
  return {
    file,
    candidates,
    high: count("HIGH"),
    ambiguous: count("AMBIGUOUS"),
    skip: count("SKIP"),
    parseError,
  };
}
