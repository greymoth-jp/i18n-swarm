import { parse } from "@vue/compiler-sfc";
import type { Candidate, Klass, ExtractReport } from "./types.ts";
import { classifyText, classifyAttr, isIconClass, norm, NEVER_COPY_ATTRS } from "./classify-core.ts";

// @vue/compiler-dom NodeTypes (kept as local constants so we do not depend on the
// enum export shape across compiler versions).
const ELEMENT = 1;
const TEXT = 2;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

const CODE_TAGS = new Set(["script", "style", "code", "pre", "textarea"]);

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

/** An element directly containing non-whitespace text AND (child elements OR a
 *  {{ interpolation }}) is a mixed flow — a prose sentence or an interpolated
 *  phrase ("{{ count }} items"). Its text fragments cannot be auto-wrapped without
 *  splitting / losing the placeholder, so everything under it is AMBIGUOUS. */
function isSentenceContainer(el: AnyNode): boolean {
  let hasText = false;
  let hasMix = false;
  for (const ch of el.children ?? []) {
    if (ch.type === TEXT && norm(ch.content ?? "")) hasText = true;
    else if (ch.type === ELEMENT || ch.type === INTERPOLATION) hasMix = true;
  }
  return hasText && hasMix;
}

/** Inner trimmed [start,end] offsets of a text node (preserve surrounding ws).
 *  Trims against loc.source so offsets never drift on CRLF / entity-decoded text. */
function innerSpan(node: AnyNode): { start: number; end: number; raw: string } {
  const raw0 = node.loc.source ?? node.content ?? "";
  const s0 = node.loc.start.offset;
  const lead = raw0.length - raw0.replace(/^\s+/, "").length;
  const trail = raw0.length - raw0.replace(/\s+$/, "").length;
  const start = s0 + lead;
  const end = node.loc.end.offset - trail;
  return { start, end, raw: raw0.slice(lead, raw0.length - trail) };
}

function textCandidate(node: AnyNode, parent: AnyNode | null, inSentence: boolean, inCode: boolean): Candidate | null {
  const text = norm(node.content ?? "");
  const d = classifyText(text, {
    inCode,
    iconParent: !!parent && isIconClass(classOf(parent)),
    inSentence,
    parentTag: parent?.tag ?? "",
  });
  if (!d) return null;
  const { start, end, raw } = innerSpan(node);
  return { file: "", kind: "text", tag: parent?.tag ?? "", text, raw, start, end, cls: d.cls, reason: d.reason };
}

function attrCandidate(attr: AnyNode, ownerTag: string): Candidate | null {
  if (attr.type !== ATTRIBUTE || !attr.value) return null;
  const d = classifyAttr(attr.name ?? "", attr.value.content, ownerTag);
  if (!d) return null;
  return {
    file: "", kind: "attr", attrName: attr.name, tag: ownerTag, text: norm(attr.value.content),
    raw: attr.loc.source, start: attr.loc.start.offset, end: attr.loc.end.offset, cls: d.cls, reason: d.reason,
  };
}

function walk(node: AnyNode, parent: AnyNode | null, inSentence: boolean, inCode: boolean, out: Candidate[]): void {
  if (node.type === TEXT) {
    const c = textCandidate(node, parent, inSentence, inCode);
    if (c) out.push(c);
    return;
  }
  if (node.type !== ELEMENT) return; // interpolation/comment: not literal copy
  const tag = (node.tag ?? "").toLowerCase();
  const childCode = inCode || CODE_TAGS.has(tag);
  for (const p of node.props ?? []) {
    const c = attrCandidate(p, node.tag ?? "");
    if (c) out.push(c);
  }
  // A named slot (<template #heading>) is a distinct content region; the sentence
  // context resets at its boundary rather than inheriting the surrounding prose.
  const isSlotTemplate = tag === "template" && (node.props ?? []).some((p) => p.type === DIRECTIVE && p.name === "slot");
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
  // Verify every offset actually points at the raw text (defends against drift);
  // demote any mismatch to SKIP so rewire can never corrupt the file.
  for (const c of candidates) {
    if (source.slice(c.start, c.end) !== c.raw) {
      c.cls = "SKIP";
      c.reason = "offset/source mismatch (not rewired)";
    }
  }
  const count = (k: Klass) => candidates.filter((c) => c.cls === k).length;
  return { file, candidates, high: count("HIGH"), ambiguous: count("AMBIGUOUS"), skip: count("SKIP"), parseError };
}

// re-export for callers that imported these from extract previously
export { NEVER_COPY_ATTRS };
