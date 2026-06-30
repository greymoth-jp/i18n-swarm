// False-positive suppression for the drift gate.
//
// The classifier answers "is this a clean user-facing string?"; in incremental (diff)
// mode that is enough — a developer adds one new string and the gate flags it. But run
// whole-codebase the same HIGH set is ~a third noise: brand names, code identifiers,
// decorative alt text, enum tokens, and strings that live in dev-only files (OG images,
// config, scripts). A gate that fires on those gets disabled. This layer runs AFTER the
// classifier and demotes a HIGH flag from a hard failure to a soft note when it falls in
// one of five precise buckets. It is deliberately conservative: it suppresses only when
// confident, so real UI copy ("Sign In", "Save", "Active Generators") is never silenced.
//
// Every bucket is a pure, independently-runnable predicate (see test/selfcheck-suppress.ts).
// Brand/enum/path lists are user-extensible via i18n-swarm.config.json so a team can pin
// its own product nouns and demo-data tokens without touching code.

import fs from "node:fs";
import path from "node:path";
import type { Candidate } from "./types.ts";

export type SuppressBucket = "brand" | "decorative" | "codeish" | "devpath" | "directive";

export interface SuppressConfig {
  brands: Set<string>; // proper nouns / product names (lower-cased), incl. user-supplied
  enums: Set<string>; // lower-case variant/enum tokens treated as code-ish
  extraDevPaths: RegExp[]; // additional dev-only path patterns
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Proper nouns that localization teams do not translate. A flag is suppressed only when
// the WHOLE string is one of these (or "<brand> logo"); a sentence that merely mentions a
// brand ("Deploy to Vercel", "Introducing Precedent") is left as a genuine flag.
const DEFAULT_BRANDS = [
  "github", "gitlab", "bitbucket", "stripe", "sentry", "clerk", "crowdin", "arcjet",
  "vercel", "netlify", "cloudflare", "supabase", "firebase", "auth0", "okta", "twilio",
  "sendgrid", "resend", "mailgun", "postmark", "twitter", "facebook", "instagram",
  "linkedin", "youtube", "tiktok", "discord", "slack", "telegram", "whatsapp",
  "google", "apple", "microsoft", "amazon", "aws", "azure", "gcp", "openai", "anthropic",
  "figma", "notion", "linear", "asana", "jira", "trello", "zoom", "shopify", "paypal",
  "bootstrap", "tailwind", "tailwindcss", "react", "vue", "angular", "svelte", "solid",
  "next.js", "nextjs", "nuxt", "vite", "remix", "astro", "node.js", "nodejs", "deno", "bun",
  "typescript", "javascript", "graphql", "postgresql", "postgres", "mysql", "mongodb",
  "redis", "sqlite", "prisma", "drizzle", "shadcn", "radix", "cruip", "wordpress",
];

// Variant/enum tokens that show up as demo labels but are not copy. Suppressed only in
// their lower-case (enum) spelling; capitalized forms ("Primary", "Dark") may be headings.
const DEFAULT_ENUMS = [
  "primary", "secondary", "success", "danger", "warning", "info", "light", "dark", "muted",
  "default", "destructive", "outline", "ghost", "link", "accent", "neutral", "subtle",
];

// CSS breakpoint indicators (the content of dev-only viewport badges).
const BREAKPOINTS = new Set(["xs", "sm", "md", "lg", "xl", "2xl", "xxl", "3xl", "4xl"]);

// ---------------------------------------------------------------------------
// Config loading (user-extensible)
// ---------------------------------------------------------------------------

const CONFIG_NAMES = ["i18n-swarm.config.json", ".i18nswarmrc.json", ".i18nswarmrc"];

interface RawConfig {
  brands?: string[];
  enums?: string[];
  ignorePaths?: string[]; // regex source strings matched against the repo-relative posix path
}

export function loadSuppressConfig(repoRoot: string): SuppressConfig {
  let raw: RawConfig = {};
  for (const name of CONFIG_NAMES) {
    const p = path.join(repoRoot, name);
    try {
      if (fs.existsSync(p)) { raw = JSON.parse(fs.readFileSync(p, "utf8")); break; }
    } catch { /* malformed config: fall back to defaults rather than crash the gate */ }
  }
  return makeConfig(raw);
}

/** Pure config builder (tested without IO). */
export function makeConfig(raw: RawConfig): SuppressConfig {
  const brands = new Set(DEFAULT_BRANDS);
  for (const b of raw.brands ?? []) brands.add(b.toLowerCase());
  const enums = new Set(DEFAULT_ENUMS);
  for (const e of raw.enums ?? []) enums.add(e.toLowerCase());
  const extraDevPaths: RegExp[] = [];
  for (const src of raw.ignorePaths ?? []) {
    try { extraDevPaths.push(new RegExp(src)); } catch { /* skip invalid pattern */ }
  }
  return { brands, enums, extraDevPaths };
}

export const defaultConfig = (): SuppressConfig => makeConfig({});

// ---------------------------------------------------------------------------
// Bucket predicates (each pure + independently runnable)
// ---------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();
const isSingleToken = (s: string) => !/\s/.test(s);

/** A social handle: "@mdo", "@next_js". */
export const isHandle = (text: string): boolean => /^@[A-Za-z0-9_.]+$/.test(text);

/** The whole string is a brand/product noun, or "<brand> logo". A multi-word phrase that
 *  merely contains a brand is NOT a brand match (it is real copy). */
export function isBrand(text: string, cfg: SuppressConfig): boolean {
  if (isHandle(text)) return true;
  const t = text.trim();
  if (cfg.brands.has(lower(t))) return true;
  const m = /^(.+?)\s+logo$/i.exec(t); // "Clerk logo", "Precedent Logo"
  if (m && cfg.brands.has(lower(m[1]))) return true;
  return false;
}

/** alt/title text on an image that is decorative rather than informative: a filename, a
 *  generic placeholder, an illustration/shape/slide descriptor, or "<x> logo". */
export function isDecorativeImageText(attrName: string | undefined, text: string): boolean {
  if (attrName !== "alt") return false;
  if (/\.(png|jpe?g|svg|webp|gif|avif|ico)$/i.test(text)) return true; // filename
  if (/^(avatar|image|image description|background|placeholder|thumbnail|banner|hero)$/i.test(text)) return true;
  if (/\b(illustration|illustrations|shape|gradient|pattern|texture|decoration|graphic)$/i.test(text)) return true;
  if (/\blogo$/i.test(text)) return true; // "Company logo", "Clerk logo"
  if (/^(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|prev|previous|next)(st|nd|rd|th)?\s+slide$/i.test(text)) return true; // carousel slide
  return false;
}

/** The string is a code identifier / config token rather than prose: camelCase,
 *  multi-hump PascalCase, kebab/snake, dotted, SCREAMING_SNAKE/-KEBAB, a known variant
 *  enum, or a breakpoint indicator. Bare all-caps words (OK / NEW / FAQ) are deliberately
 *  NOT matched — they are real UI copy; only all-caps WITH a separator is treated as a
 *  constant. Single dictionary words are left alone (they are usually labels). */
export function isCodeish(text: string, cfg: SuppressConfig): boolean {
  if (!isSingleToken(text)) return false; // any whitespace -> never a single identifier
  const t = text;
  if (BREAKPOINTS.has(lower(t))) return true; // xs / sm / md / lg / xl / 2xl
  if (cfg.enums.has(t) && t === lower(t)) return true; // lower-case variant token ("primary")
  if (/^[a-z][a-z0-9]*([-_][a-z0-9]+)+$/.test(t)) return true; // kebab/snake: "icon-sm", "data_table"
  if (/^[A-Z][A-Z0-9]*([_-][A-Z0-9]+)+$/.test(t)) return true; // SCREAMING_SNAKE / -KEBAB const
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return true; // camelCase: "useScroll", "nFormatter"
  if (/^([A-Z][a-z0-9]+){2,}$/.test(t)) return true; // multi-hump PascalCase API: "OverlayTrigger"
  if (/^[a-zA-Z][\w$]*(\.[\w$]+)+$/.test(t)) return true; // dotted member/namespace: "magicui.design"
  return false;
}

const DEV_PATH_PATTERNS: RegExp[] = [
  /\.(config|stories|story|test|spec)\.[cm]?[jt]sx?$/, // *.config.tsx, *.stories.tsx, *.test.tsx
  /(^|\/)(stories|story|tests|test|__tests__|e2e|cypress|playwright|scripts|script|mocks|__mocks__|fixtures|\.storybook)\//,
  /(^|\/)(opengraph-image|twitter-image|icon|apple-icon|favicon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/, // Next metadata routes
  /(^|[-/.])(tailwind-indicator|breakpoint-indicator|grid-overlay|dev-?tools?|debug-?grid)\b/i, // viewport/dev overlays
];

/** The string lives in a file whose contents are never shipped as product copy: OG-image
 *  / metadata routes, config, stories, tests, scripts, or a dev-only viewport indicator. */
export function isDevOnlyPath(rel: string, cfg: SuppressConfig): boolean {
  const p = rel.split(path.sep).join("/");
  return DEV_PATH_PATTERNS.some((re) => re.test(p)) || cfg.extraDevPaths.some((re) => re.test(p));
}

/** An inline `i18n-ignore` directive on the candidate's line or the preceding non-blank
 *  line. Supports `// i18n-ignore`, `/* i18n-ignore *​/`, and JSX `{/* i18n-ignore *​/}`. */
export function hasInlineIgnore(source: string, offset: number): boolean {
  const lines = source.slice(0, Math.max(0, offset)).split("\n");
  const idx = lines.length - 1; // 0-based index of the candidate's line
  const all = source.split("\n");
  const RE = /(?:\/\/|\/\*|\{\s*\/\*)\s*i18n-ignore\b/;
  if (idx >= 0 && idx < all.length && RE.test(all[idx])) return true; // trailing on same line
  // nearest preceding non-blank line
  for (let i = idx - 1; i >= 0; i--) {
    if (all[i].trim() === "") continue;
    return RE.test(all[i]);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Combined decision
// ---------------------------------------------------------------------------

export interface SuppressResult { suppressed: boolean; bucket: SuppressBucket | null; detail: string }

/** Decide whether a HIGH candidate should be demoted from a hard failure. `rel` is the
 *  repo-relative posix path; `source` is the file text (for the inline directive + offset). */
export function classifySuppression(c: Candidate, rel: string, source: string, cfg: SuppressConfig): SuppressResult {
  if (hasInlineIgnore(source, c.start)) return { suppressed: true, bucket: "directive", detail: "// i18n-ignore" };
  if (isDevOnlyPath(rel, cfg)) return { suppressed: true, bucket: "devpath", detail: "dev-only file (not shipped copy)" };
  if (c.decorative) return { suppressed: true, bucket: "decorative", detail: "screen-reader-hidden (aria-hidden/role=presentation)" };
  if (isDecorativeImageText(c.attrName, c.text)) return { suppressed: true, bucket: "decorative", detail: "decorative image alt" };
  if (isBrand(c.text, cfg)) return { suppressed: true, bucket: "brand", detail: "brand / proper noun / handle" };
  if (isCodeish(c.text, cfg)) return { suppressed: true, bucket: "codeish", detail: "code identifier / enum / breakpoint token" };
  return { suppressed: false, bucket: null, detail: "" };
}
