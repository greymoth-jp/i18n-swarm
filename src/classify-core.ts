// Framework-agnostic classification primitives.
//
// The hard, reusable judgement — "is this string user-facing copy, and is it safe
// to auto-rewire?" — does not depend on Vue vs React. The framework extractors
// (extract.ts for Vue SFCs, extract-jsx.ts for React/JSX) walk their own AST,
// resolve offsets, and defer every classification decision to the pure functions
// here. Each function is independently runnable and has a self-check.

export type Klass = "HIGH" | "AMBIGUOUS" | "SKIP";

// Tags whose text content is never user-facing copy.
export const CODE_TAGS = new Set(["script", "style", "code", "pre", "textarea"]);
// Static attributes that hold user-facing copy and are safe to rewire to a binding.
export const TEXT_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-placeholder"]);
// Attributes that are never user-facing copy (routes, urls, ids, technical values).
// Includes both HTML (class/for) and JSX (className/htmlFor) spellings.
export const NEVER_COPY_ATTRS = new Set([
  "to", "href", "src", "srcset", "id", "name", "for", "htmlfor", "type", "value",
  "key", "ref", "rel", "target", "lang", "dir", "role", "width", "height", "min",
  "max", "step", "d", "fill", "stroke", "viewbox", "xmlns", "style", "class",
  "classname", "model", "v-model", "datatestid", "data-testid", "slot", "tabindex",
]);
// Icon-font ligature carriers: their text IS the glyph; translating breaks the icon.
const ICON_CLASS = /\bmaterial-(icons|symbols)/;

export const hasLetter = (s: string): boolean => /\p{L}/u.test(s);
export const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
export const isIconClass = (className: string): boolean => ICON_CLASS.test(className);

/** A single dotted/hyphenated/coloned numeric token: version, id, SKU, time — not copy.
 *  e.g. "v2.3.1", "12:30", "AB-12". A string with whitespace is never version-like. */
export const isVersionLike = (text: string): boolean =>
  !/\s/.test(text) && /\d/.test(text) && /[.\-_:]\d/.test(text);

/** Tag refers to a component (Capitalized, dotted, or kebab custom element) rather
 *  than a native host element (lowercase, no dash). A string prop on a component may
 *  be display copy or may be an id/url/mode, so it is never auto-rewired. */
export const isComponentTag = (tag: string): boolean =>
  /^[A-Z]/.test(tag) || tag.includes(".") || tag.includes("-");

export interface Decision { cls: Klass; reason: string; }

export interface TextCtx {
  inCode: boolean; // inside <script>/<style>/<code>/<pre>/<textarea>
  iconParent: boolean; // parent carries a material-icons/-symbols class
  inSentence: boolean; // fragment of a mixed text + markup/interpolation flow
  parentTag: string;
}

/**
 * Classify one already-normalized (whitespace-collapsed, trimmed) text string.
 * Returns null only for empty/pure-whitespace input (not a candidate at all).
 * Decision order is deliberate: code/icon context first (never copy), then
 * letter/version shape, then sentence context, then the safe HIGH default.
 */
export function classifyText(text: string, ctx: TextCtx): Decision | null {
  if (!text) return null;
  if (ctx.inCode) return { cls: "SKIP", reason: "inside code/preformatted block" };
  if (ctx.iconParent) return { cls: "SKIP", reason: "icon-font ligature (would break the glyph)" };
  if (!hasLetter(text)) return { cls: "SKIP", reason: "no natural-language letters (number/symbol)" };
  if (isVersionLike(text)) return { cls: "SKIP", reason: "version/identifier-like token" };
  if (ctx.inSentence) return { cls: "AMBIGUOUS", reason: "fragment of a mixed text+markup/interpolation sentence" };
  return { cls: "HIGH", reason: "sole text child of <" + (ctx.parentTag || "?") + ">" };
}

/**
 * Classify one static attribute (string-literal value). Returns null when the
 * attribute is not natural-language copy at all (so the caller drops it silently).
 */
export function classifyAttr(name: string, value: string, ownerTag: string): Decision | null {
  const val = norm(value);
  if (!val || !hasLetter(val)) return null;
  const lname = name.toLowerCase();
  if (NEVER_COPY_ATTRS.has(lname)) return null;
  if (TEXT_ATTRS.has(lname)) return { cls: "HIGH", reason: `user-facing attribute "${name}"` };
  if (isComponentTag(ownerTag)) {
    return { cls: "AMBIGUOUS", reason: `string prop "${name}" on component <${ownerTag}> (may not be copy)` };
  }
  return null;
}

/** A standalone natural-language string literal that appears INSIDE a {expression}
 *  (JSX) — never auto-rewired (could be a ternary branch / enum / className), but a
 *  multi-word phrase is surfaced for review so real copy is not silently dropped. */
export function classifyExprString(text: string): Decision | null {
  const t = norm(text);
  if (!t || !hasLetter(t)) return null;
  if (isVersionLike(t)) return null;
  // single-token strings inside expressions are overwhelmingly enums/keys/classes
  if (!/\s/.test(t)) return null;
  return { cls: "AMBIGUOUS", reason: "string literal inside a {expression} (could be an enum/condition — review)" };
}
