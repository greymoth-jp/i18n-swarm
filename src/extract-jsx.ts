import ts from "typescript";
import type { Candidate, Klass, ExtractReport } from "./types.ts";
import { classifyText, classifyAttr, classifyExprString, isIconClass, norm } from "./classify-core.ts";

const CODE_TAGS = new Set(["script", "style", "code", "pre", "textarea"]);

function tagOf(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sf: ts.SourceFile): string {
  return el.tagName.getText(sf);
}

/** Read a static string-literal className/class off an opening element (for icon detection). */
function classNameOf(attrs: ts.JsxAttributes, sf: ts.SourceFile): string {
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const n = a.name.getText(sf).toLowerCase();
    if (n !== "classname" && n !== "class") continue;
    const init = a.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
  }
  return "";
}

/** Element is screen-reader-hidden: aria-hidden="true" / aria-hidden (shorthand) /
 *  aria-hidden={true}, or role="presentation"/"none". Its visible glyphs are decorative,
 *  so any letters inside are not translatable copy. */
function isDecorativeEl(attrs: ts.JsxAttributes, sf: ts.SourceFile): boolean {
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const n = a.name.getText(sf).toLowerCase();
    const init = a.initializer;
    if (n === "aria-hidden") {
      if (!init) return true; // <span aria-hidden> shorthand = true
      if (ts.isStringLiteral(init)) return init.text === "true";
      if (ts.isJsxExpression(init) && init.expression && init.expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    }
    if (n === "role" && init && ts.isStringLiteral(init)) {
      if (init.text === "presentation" || init.text === "none") return true;
    }
  }
  return false;
}

/** A parent whose children mix non-whitespace text with element OR {expression}
 *  children is a sentence/interpolated flow; its text fragments are AMBIGUOUS. */
function isSentenceContainer(children: ts.NodeArray<ts.JsxChild>): boolean {
  let hasText = false;
  let hasMix = false;
  for (const ch of children) {
    if (ts.isJsxText(ch)) { if (norm(ch.text)) hasText = true; }
    else if (ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch) || ts.isJsxFragment(ch)) hasMix = true;
    else if (ts.isJsxExpression(ch) && ch.expression) hasMix = true;
  }
  return hasText && hasMix;
}

interface Ctx { inSentence: boolean; inCode: boolean; parentTag: string; iconParent: boolean; decorative: boolean; }

function innerTextSpan(node: ts.JsxText, sf: ts.SourceFile, source: string): { start: number; end: number; raw: string } {
  const s0 = node.getStart(sf);
  const e0 = node.getEnd();
  const full = source.slice(s0, e0);
  const lead = full.length - full.replace(/^\s+/, "").length;
  const trail = full.length - full.replace(/\s+$/, "").length;
  return { start: s0 + lead, end: e0 - trail, raw: full.slice(lead, full.length - trail) };
}

function pushAttrs(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sf: ts.SourceFile, out: Candidate[]): void {
  const tag = tagOf(el, sf);
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue; // spread attr {...props}: skip
    const init = a.initializer;
    if (!init || !ts.isStringLiteral(init)) continue; // only static string-literal attrs
    const name = a.name.getText(sf);
    const d = classifyAttr(name, init.text, tag);
    if (!d) continue;
    out.push({
      file: "", kind: "attr", attrName: name, tag, text: norm(init.text),
      raw: a.getText(sf), start: a.getStart(sf), end: a.getEnd(), cls: d.cls, reason: d.reason,
    });
  }
}

function walkChildren(children: ts.NodeArray<ts.JsxChild>, parentTag: string, ctx: Ctx, sf: ts.SourceFile, source: string, out: Candidate[]): void {
  const childCtx: Ctx = {
    ...ctx,
    inSentence: ctx.inSentence || isSentenceContainer(children),
    parentTag,
  };
  for (const ch of children) walk(ch, childCtx, sf, source, out);
}

function walk(node: ts.Node, ctx: Ctx, sf: ts.SourceFile, source: string, out: Candidate[]): void {
  if (ts.isJsxText(node)) {
    const text = norm(node.text);
    const d = classifyText(text, { inCode: ctx.inCode, iconParent: ctx.iconParent, inSentence: ctx.inSentence, parentTag: ctx.parentTag });
    if (!d) return;
    const { start, end, raw } = innerTextSpan(node, sf, source);
    out.push({ file: "", kind: "text", tag: ctx.parentTag, text, raw, start, end, cls: d.cls, reason: d.reason, decorative: ctx.decorative });
    return;
  }
  if (ts.isJsxExpression(node)) {
    // {expression}: never auto-rewired. Surface a standalone natural-language string
    // literal for review; everything else (identifiers, calls, ternaries) is ignored.
    const e = node.expression;
    if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) {
      const d = classifyExprString(e.text);
      if (d) out.push({ file: "", kind: "text", tag: ctx.parentTag, text: norm(e.text), raw: e.getText(sf), start: e.getStart(sf), end: e.getEnd(), cls: d.cls, reason: d.reason });
    }
    return;
  }
  if (ts.isJsxElement(node)) {
    const open = node.openingElement;
    const tag = tagOf(open, sf);
    pushAttrs(open, sf, out);
    const low = tag.toLowerCase();
    const childCode = ctx.inCode || CODE_TAGS.has(low);
    const iconParent = isIconClass(classNameOf(open.attributes, sf));
    const decorative = ctx.decorative || isDecorativeEl(open.attributes, sf);
    walkChildren(node.children, tag, { inSentence: ctx.inSentence, inCode: childCode, parentTag: tag, iconParent, decorative }, sf, source, out);
    return;
  }
  if (ts.isJsxSelfClosingElement(node)) {
    pushAttrs(node, sf, out);
    return;
  }
  if (ts.isJsxFragment(node)) {
    walkChildren(node.children, ctx.parentTag, { ...ctx, parentTag: "" }, sf, source, out);
    return;
  }
  ts.forEachChild(node, (c) => walk(c, ctx, sf, source, out));
}

export type ComponentScope = "client" | "server";

/** App-Router default: a file is a Server Component unless it opts into 'use client'. */
export function detectScope(source: string): ComponentScope {
  return /^\s*(['"])use client\1/m.test(source) ? "client" : "server";
}

/** Whether the file already imports/uses a translation hook (already-partially-i18n'd). */
export function fileI18nState(source: string): { hasNextIntl: boolean; usesHook: boolean } {
  return {
    hasNextIntl: /from\s+['"]next-intl(\/server)?['"]/.test(source) || /from\s+['"]react-i18next['"]/.test(source),
    usesHook: /\b(useTranslations|getTranslations|useTranslation)\s*\(/.test(source),
  };
}

/** Parse one JSX/TSX file and classify every JSX text node, attribute, and standalone
 *  string literal inside an expression. Uses the TypeScript compiler (real AST). */
export function extractJsxFile(file: string, source: string): ExtractReport {
  let candidates: Candidate[] = [];
  let parseError: string | null = null;
  try {
    const kind = file.endsWith(".jsx") || file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TSX;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    // syntactic diagnostics on the parsed tree
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diags.length) parseError = ts.flattenDiagnosticMessageText(diags[0].messageText, " ");
    const root: Ctx = { inSentence: false, inCode: false, parentTag: "", iconParent: false, decorative: false };
    ts.forEachChild(sf, (n) => walk(n, root, sf, source, candidates));
  } catch (e) {
    parseError = (e as Error).message;
  }
  candidates = candidates.map((c) => ({ ...c, file }));
  for (const c of candidates) {
    if (source.slice(c.start, c.end) !== c.raw) {
      c.cls = "SKIP";
      c.reason = "offset/source mismatch (not rewired)";
    }
  }
  const count = (k: Klass) => candidates.filter((c) => c.cls === k).length;
  return { file, candidates, high: count("HIGH"), ambiguous: count("AMBIGUOUS"), skip: count("SKIP"), parseError };
}
