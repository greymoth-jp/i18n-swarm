import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasLetter, norm, isVersionLike, isIconClass, isComponentTag,
  classifyText, classifyAttr, classifyExprString, isEntityOnlyText,
} from "../src/classify-core.ts";
import { scaffoldReact } from "../src/scaffold-react.ts";
import { extractJsxFile, detectScope, fileI18nState } from "../src/extract-jsx.ts";
import { rewriteJsxFile, jsxParseErrors } from "../src/rewire-jsx.ts";
import { planBinding } from "../src/binding.ts";
import { assignKeys } from "../src/keys.ts";
import { buildLocales, nestLocale } from "../src/catalog.ts";
import type { Candidate } from "../src/types.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }
const byCls = (cs: Candidate[], cls: string) => cs.filter((c) => c.cls === cls);
const ex = (src: string) => extractJsxFile("Demo.tsx", src).candidates;
const wrap = (jsx: string) => `export default function Demo(){ return (${jsx}); }`;

// ============================================================================
// 1. classify-core: every pure primitive, independently, with edge-cases
// ============================================================================
check("hasLetter: letters vs pure number/symbol", () => {
  assert.equal(hasLetter("Save"), true);
  assert.equal(hasLetter("123 %"), false);
  assert.equal(hasLetter("日本語"), true);
});
check("norm: collapses internal whitespace and trims", () => {
  assert.equal(norm("  Save   changes \n now "), "Save changes now");
});
check("isVersionLike: versions/ids yes, prose no", () => {
  assert.equal(isVersionLike("v2.3.1"), true);
  assert.equal(isVersionLike("12:30"), true);
  assert.equal(isVersionLike("AB-12"), true);
  assert.equal(isVersionLike("21% more"), false, "has whitespace -> prose");
  assert.equal(isVersionLike("Save"), false);
});
check("isIconClass: material icon carriers", () => {
  assert.equal(isIconClass("material-icons-outlined"), true);
  assert.equal(isIconClass("material-symbols-rounded"), true);
  assert.equal(isIconClass("btn primary"), false);
});
check("isComponentTag: host vs component", () => {
  assert.equal(isComponentTag("div"), false);
  assert.equal(isComponentTag("Button"), true);
  assert.equal(isComponentTag("Foo.Bar"), true);
  assert.equal(isComponentTag("my-widget"), true);
});
check("classifyText: every branch", () => {
  assert.equal(classifyText("", { inCode: false, iconParent: false, inSentence: false, parentTag: "p" }), null);
  assert.equal(classifyText("x", { inCode: true, iconParent: false, inSentence: false, parentTag: "code" })!.cls, "SKIP");
  assert.equal(classifyText("home", { inCode: false, iconParent: true, inSentence: false, parentTag: "span" })!.cls, "SKIP");
  assert.equal(classifyText("89,400", { inCode: false, iconParent: false, inSentence: false, parentTag: "div" })!.cls, "SKIP");
  assert.equal(classifyText("v2.3.1", { inCode: false, iconParent: false, inSentence: false, parentTag: "small" })!.cls, "SKIP");
  assert.equal(classifyText("Visit", { inCode: false, iconParent: false, inSentence: true, parentTag: "p" })!.cls, "AMBIGUOUS");
  assert.equal(classifyText("Save", { inCode: false, iconParent: false, inSentence: false, parentTag: "button" })!.cls, "HIGH");
});
check("classifyAttr: text-attr HIGH, never-copy null, host-prop null", () => {
  assert.equal(classifyAttr("placeholder", "Your name", "input")!.cls, "HIGH");
  assert.equal(classifyAttr("alt", "A cat", "img")!.cls, "HIGH");
  assert.equal(classifyAttr("href", "/about", "a"), null);
  assert.equal(classifyAttr("className", "btn primary", "div"), null);
  assert.equal(classifyAttr("title", "Open settings", "div")!.cls, "HIGH", "title is a user-facing attr");
  assert.equal(classifyAttr("title", "123", "div"), null, "no-letter title value is not copy");
  assert.equal(classifyAttr("data-foo", "Bar baz", "div"), null, "data-* is never copy");
});
check("classifyAttr config props are NOT review noise: enum/css/url/data/class -> dropped", () => {
  // config tokens that used to flood the review queue as AMBIGUOUS are now correctly dropped
  assert.equal(classifyAttr("variant", "primary", "Button"), null, "style enum");
  assert.equal(classifyAttr("size", "sm", "Button"), null, "size enum");
  assert.equal(classifyAttr("align", "end", "Cell"), null, "layout enum");
  assert.equal(classifyAttr("data-slot", "accordion-trigger", "Foo"), null, "data-* slot id");
  assert.equal(classifyAttr("dataKey", "weightedPipeline", "Bar"), null, "recharts data key (camelCase)");
  assert.equal(classifyAttr("videoSrc", "https://x.com/v.mp4", "Hero"), null, "url-bearing prop");
  assert.equal(classifyAttr("eventColor", "var(--primary)", "Cal"), null, "css value");
  assert.equal(classifyAttr("popoverClass", "rounded-md bg-popover", "Cal"), null, "*Class css list");
  assert.equal(classifyAttr("position", "insideLeft", "Label"), null, "recharts position enum");
});
check("classifyAttr copy props ARE auto-handled when the value is prose", () => {
  assert.equal(classifyAttr("label", "Actionable deals", "StatCard")!.cls, "HIGH", "multi-word label");
  assert.equal(classifyAttr("label", "Nostalgia", "Card")!.cls, "HIGH", "capitalized real word");
  assert.equal(classifyAttr("description", "Receive product updates", "Field")!.cls, "HIGH");
  assert.equal(classifyAttr("pageTitle", "Billing & Plans", "Shell")!.cls, "HIGH");
  assert.equal(classifyAttr("text", "Prev", "Marquee")!.cls, "HIGH");
  // a copy-ish prop whose value is a bare lower-case token is NOT prose -> stays in review, never auto-wired
  assert.equal(classifyAttr("label", "lg", "Icon")!.cls, "AMBIGUOUS");
});
check("classifyExprString: multiword phrase AMBIGUOUS, enum/single-token null", () => {
  assert.equal(classifyExprString("Welcome back")!.cls, "AMBIGUOUS");
  assert.equal(classifyExprString("destructive"), null, "single-token enum -> not surfaced");
  assert.equal(classifyExprString("123"), null);
});

// ============================================================================
// 2. extract-jsx: JSX text / attribute / prop / interpolation / icon / enum / code
// ============================================================================
check("JSX text: sole child of a leaf element is HIGH", () => {
  const h = byCls(ex(wrap(`<button>Save changes</button>`)), "HIGH");
  assert.equal(h.length, 1);
  assert.equal(h[0].text, "Save changes");
});
check("JSX attribute: user-facing attr HIGH, technical attr ignored", () => {
  const cs = ex(wrap(`<input placeholder="Your name" type="text" className="f" />`));
  const h = byCls(cs, "HIGH");
  assert.equal(h.length, 1);
  assert.equal(h[0].attrName, "placeholder");
  assert.equal(cs.filter((c) => c.attrName === "type").length, 0);
});
check("known copy prop with a prose value is auto-handled HIGH", () => {
  const h = byCls(ex(wrap(`<Greeting message="You did it!" />`)), "HIGH");
  assert.equal(h.length, 1);
  assert.equal(h[0].attrName, "message");
});
check("unknown prop with a prose value stays AMBIGUOUS (could be copy or a config string)", () => {
  const amb = byCls(ex(wrap(`<Chart note="closed won / monthly target" />`)), "AMBIGUOUS");
  assert.equal(amb.length, 1);
  assert.equal(amb[0].attrName, "note");
});
check("config props on a component are dropped, not queued for review", () => {
  const cs = ex(wrap(`<Button variant="primary" size="sm" data-slot="cta">Go</Button>`));
  assert.equal(byCls(cs, "AMBIGUOUS").length, 0, "variant/size/data-slot are not copy");
  assert.equal(byCls(cs, "HIGH").filter((c) => c.kind === "text").length, 1, "the label child is still HIGH");
});
check("interpolation: {var} sibling makes the text AMBIGUOUS (not a clean label)", () => {
  const cs = ex(wrap(`<span>{count} items left</span>`));
  assert.equal(byCls(cs, "HIGH").length, 0, "interpolated phrase is not auto-wrapped");
  assert.equal(byCls(cs, "AMBIGUOUS").length, 1);
});
check("plural-ish interpolation across fragments stays AMBIGUOUS", () => {
  const cs = ex(wrap(`<p>You have {n} new {n === 1 ? 'message' : 'messages'}</p>`));
  assert.equal(byCls(cs, "HIGH").length, 0);
  assert.ok(byCls(cs, "AMBIGUOUS").length >= 1);
});
check("mixed prose + inline element: fragments AMBIGUOUS, none auto-wrapped", () => {
  const cs = ex(wrap(`<p>Read the <a href="#">docs</a> first</p>`));
  assert.equal(byCls(cs, "HIGH").length, 0);
  const amb = byCls(cs, "AMBIGUOUS").map((c) => c.text).sort();
  assert.deepEqual(amb, ["Read the", "docs", "first"]);
});
check("icon-font ligature text is SKIP (would break the glyph)", () => {
  const s = byCls(ex(wrap(`<span className="material-icons">home</span>`)), "SKIP");
  assert.equal(s.length, 1);
  assert.match(s[0].reason, /icon-font ligature/);
});
check("enum string literal in an expression is NOT translated", () => {
  // <Badge variant={"destructive"}> -> single-token expr string -> dropped entirely
  const cs = ex(wrap(`<Badge variant={"destructive"}>{"ok"}</Badge>`));
  assert.equal(byCls(cs, "HIGH").length, 0);
  // neither single token becomes a HIGH; "ok" is single-token -> not surfaced
  assert.equal(cs.filter((c) => c.text === "destructive").length, 0);
});
check("code/pre content is SKIP", () => {
  const cs = ex(wrap(`<pre><code>const x = 1 plus two</code></pre>`));
  assert.equal(byCls(cs, "HIGH").length, 0);
  assert.equal(byCls(cs, "SKIP").length, 1);
});
check("number / percentage with no letters is SKIP; sentence with a number is HIGH", () => {
  assert.equal(byCls(ex(wrap(`<div>89,400</div>`)), "SKIP").length, 1);
  assert.equal(byCls(ex(wrap(`<span>21% more than last month</span>`)), "HIGH").length, 1);
});
check("self-closing element attributes are classified", () => {
  const h = byCls(ex(wrap(`<img alt="A red fox" src="/fox.png" />`)), "HIGH");
  assert.equal(h.length, 1);
  assert.equal(h[0].attrName, "alt");
});
check("fragment <>...</> is transparent; leaf children still HIGH", () => {
  const h = byCls(ex(`export default function D(){return (<><button>One</button><button>Two</button></>);}`), "HIGH");
  assert.equal(h.length, 2);
});
check("spread attributes {...props} do not crash and yield nothing", () => {
  const cs = ex(wrap(`<button {...rest}>Go</button>`));
  assert.equal(byCls(cs, "HIGH").length, 1);
});

// ============================================================================
// 2b. REGRESSION -- 3 defects caught by a real-world usability test (todomvc-react +
// a Next.js starter), fixed here. Each of these fails on the pre-fix code and passes
// after; they are wired into `selfcheck` so this class of bug cannot silently return.
// ============================================================================

// --- defect 1: hardcoded JSX inside {cond && <X/>}, a ternary, or .map() was
// invisible -- walk() returned from the JsxExpression branch without ever recursing
// into the expression, so no candidate was produced at all (not FAIL, not SKIP).
check("REGRESSION defect 1: text inside {cond && <X/>} is detected, not silently missed", () => {
  const cs = ex(wrap(`<div>{isOpen && <div className="modal"><button>Close</button></div>}</div>`));
  const h = byCls(cs, "HIGH").map((c) => c.text);
  assert.ok(h.includes("Close"), "&& RHS JSX text must be extracted");
});
check("REGRESSION defect 1: text inside a ternary {a ? <X/> : <Y/>} is detected on BOTH branches", () => {
  const cs = ex(wrap(`<div>{step === 1 ? <h2>Step one</h2> : <h2>Step two</h2>}</div>`));
  const h = byCls(cs, "HIGH").map((c) => c.text);
  assert.ok(h.includes("Step one"), "ternary whenTrue branch must be extracted");
  assert.ok(h.includes("Step two"), "ternary whenFalse branch must be extracted");
});
check("REGRESSION defect 1: text inside {items.map(i => <X/>)} is detected", () => {
  const cs = ex(wrap(`<ul>{items.map((item) => <li key={item.id}>Delete</li>)}</ul>`));
  const h = byCls(cs, "HIGH").map((c) => c.text);
  assert.ok(h.includes("Delete"), ".map() callback JSX text must be extracted");
});
check("REGRESSION defect 1: offsets stay correct end-to-end -- the rewrite actually lands on the right span", () => {
  const src = wrap(`<div>{isOpen && <button>Close</button>}{step ? <h2>Step one</h2> : <h2>Step two</h2>}</div>`);
  const cs = ex(src); assignKeys(cs);
  const { out, result } = rewriteJsxFile("Demo.tsx", src, cs, false);
  assert.equal(result.corrupted, false);
  assert.match(out, /\{isOpen && <button>\{t\('demo\.close'\)\}<\/button>\}/);
  assert.match(out, /<h2>\{t\('demo\.step_one'\)\}<\/h2>/);
  assert.match(out, /<h2>\{t\('demo\.step_two'\)\}<\/h2>/);
  assert.equal(jsxParseErrors("Demo.tsx", out), 0, "rewritten output still parses");
});
check("REGRESSION defect 1: already-i18n'd {t('x')} inside a ternary is still not re-extracted", () => {
  const cs = ex(wrap(`<div>{cond ? <button>{t('demo.save')}</button> : null}</div>`));
  assert.equal(byCls(cs, "HIGH").length, 0, "an existing t() call inside a conditional stays an expression, not a literal");
});

// --- defect 2: aria-hidden/decorative context was stamped on TEXT candidates only;
// pushAttrs() never read or set it, so a decorative element's OWN alt/title attribute
// still flagged HIGH (false positive against the README's "decorative" bucket).
check("REGRESSION defect 2: an aria-hidden element's OWN alt attr is stamped decorative", () => {
  const cs = ex(wrap(`<img aria-hidden alt="A red fox" src="/fox.png" />`));
  const alt = cs.find((c) => c.attrName === "alt");
  assert.ok(alt, "alt candidate must still exist");
  assert.equal(alt!.decorative, true, "an aria-hidden element's own attrs must be marked decorative, not just its text children");
});
check("REGRESSION defect 2: an aria-hidden PARENT propagates decorative to a child element's own attrs", () => {
  const cs = ex(wrap(`<span aria-hidden><img alt="A red fox" src="/fox.png" /></span>`));
  const alt = cs.find((c) => c.attrName === "alt");
  assert.equal(alt!.decorative, true);
});
check("REGRESSION defect 2: role=presentation marks a JsxElement's own title attr decorative", () => {
  const cs = ex(wrap(`<div role="presentation" title="Decorative divider" />`));
  const title = cs.find((c) => c.attrName === "title");
  assert.equal(title!.decorative, true);
});

// --- defect 3: entity-only JSX text ("&times;", "&copy;") was classified HIGH and
// rewired to {t('key')} with the un-decoded literal as the JSON value -- the rendered
// UI regressed from the glyph ("x", "(c)") to the literal escape sequence.
check("REGRESSION defect 3: isEntityOnlyText identifies bare entities, not mixed prose", () => {
  assert.equal(isEntityOnlyText("&times;"), true);
  assert.equal(isEntityOnlyText("&copy;"), true);
  assert.equal(isEntityOnlyText("&#215;"), true);
  assert.equal(isEntityOnlyText("&#xD7;"), true);
  assert.equal(isEntityOnlyText("&times; &copy;"), true, "more than one bare entity is still entity-only");
  assert.equal(isEntityOnlyText("Rock & Roll"), false, "a literal ampersand character is not an entity escape");
  assert.equal(isEntityOnlyText("Save"), false);
});
check("REGRESSION defect 3: entity-only JSX text is SKIP, not HIGH", () => {
  const cs = ex(wrap(`<button>&times;</button>`));
  assert.equal(byCls(cs, "HIGH").length, 0, "must not be auto-rewired");
  const skip = byCls(cs, "SKIP");
  assert.equal(skip.length, 1);
  assert.match(skip[0].reason, /entity/i);
});
check("REGRESSION defect 3: entity-only attr value is dropped, not queued/wired", () => {
  const cs = ex(wrap(`<button aria-label="&copy;">X</button>`));
  assert.equal(cs.filter((c) => c.attrName === "aria-label").length, 0, "entity-only attr value is not a candidate at all");
});
check("REGRESSION defect 3: retrofit end-to-end -- entity-only text is left untouched by the rewrite and excluded from the catalog", () => {
  const src = wrap(`<button>&times;</button>`);
  const cs = ex(src); assignKeys(cs);
  const locales = buildLocales(cs);
  assert.deepEqual(Object.values(locales.en), [], "no key/value pair carries the raw escape sequence");
  const { out, result } = rewriteJsxFile("Demo.tsx", src, cs, false);
  assert.equal(result.edits, 0, "nothing rewired");
  assert.equal(out, src, "source is byte-identical: the &times; button still renders '×', never the literal escape");
});

// ============================================================================
// 3. rewire-jsx: surgical, verified, corruption-guarded
// ============================================================================
check("rewire JSX text -> {t()} and attr -> name={t()}", () => {
  const src = wrap(`<form><input placeholder="Name" /><button>Save</button></form>`);
  const cs = ex(src); assignKeys(cs);
  const { out } = rewriteJsxFile("Demo.tsx", src, cs, false);
  assert.match(out, /<button>\{t\('demo\.save'\)\}<\/button>/);
  assert.match(out, /placeholder=\{t\('demo\.name'\)\}/);
  assert.ok(!out.includes(`placeholder="Name"`));
  assert.equal(jsxParseErrors("Demo.tsx", out), 0, "rewritten output still parses");
});
check("rewire: tampered offset is skipped, file untouched", () => {
  const src = wrap(`<button>Save</button>`);
  const cs = ex(src); assignKeys(cs);
  const tampered = cs.map((c) => (c.cls === "HIGH" ? { ...c, raw: "WRONG" } : c));
  const { out, result } = rewriteJsxFile("Demo.tsx", src, tampered, false);
  assert.equal(result.edits, 0);
  assert.equal(result.skipped, 1);
  assert.equal(out, src);
});
check("rewire: identical text in one file dedupes to one key", () => {
  const src = `export default function D(){return (<div><button>OK</button><a href="#">OK</a></div>);}`;
  const cs = ex(src); assignKeys(cs);
  const high = byCls(cs, "HIGH");
  // <a> is inside a div with only element children -> not a sentence -> both HIGH
  const oks = high.filter((c) => c.text === "OK");
  assert.equal(oks.length, 2);
  assert.equal(oks[0].key, oks[1].key);
});

// ============================================================================
// 4. Server vs Client component binding (the next-intl-specific hard part)
// ============================================================================
check("detectScope: 'use client' -> client, default -> server", () => {
  assert.equal(detectScope(`'use client'\nexport default function P(){}`), "client");
  assert.equal(detectScope(`export default function P(){}`), "server");
});
check("binding CLIENT: injects useTranslations() + import, no async", () => {
  const src = `'use client'\nexport default function Page(){\n  return <button>Save</button>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  assert.equal(plan.scope, "client");
  const texts = plan.edits.map((e) => e.text).join("|");
  assert.match(texts, /import \{ useTranslations \} from 'next-intl'/);
  assert.match(texts, /const t = useTranslations\(\);/);
  assert.ok(!texts.includes("async"));
});
check("binding NON-ASYNC server (no 'use client'): useTranslations(), never getTranslations, never async", () => {
  // A shared/leaf component a Client Component may import: file has no 'use client', but it
  // can still run on the client, so getTranslations() would crash at prerender. useTranslations
  // works in both contexts -> it is the safe binding, and the component stays non-async.
  const src = `export default function Page(){\n  return <button>Save</button>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  assert.equal(plan.scope, "server");
  const texts = plan.edits.map((e) => e.text).join("|");
  assert.match(texts, /import \{ useTranslations \} from 'next-intl'/);
  assert.match(texts, /const t = useTranslations\(\);/);
  assert.ok(!/getTranslations/.test(texts), "no server-only getTranslations in a possibly-client component");
  assert.ok(!plan.edits.map((e) => e.text).includes("async "), "component is never made async");
});
check("binding ASYNC server component: await getTranslations(), no async insert", () => {
  const src = `export default async function Page(){\n  const d = await load();\n  return <h1>Welcome</h1>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  const texts = plan.edits.map((e) => e.text).join("|");
  assert.match(texts, /import \{ getTranslations \} from 'next-intl\/server'/);
  assert.match(texts, /const t = await getTranslations\(\);/);
  assert.ok(!plan.edits.map((e) => e.text).includes("async "), "already async -> no extra async insert");
});
check("binding MIXED file: sync component gets useTranslations, async gets getTranslations", () => {
  const src = `export function A(){ return <button>One</button>; }\nexport async function B(){ const d = await x(); return <h1>Two</h1>; }`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("M.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  const texts = plan.edits.map((e) => e.text).join("|");
  assert.match(texts, /const t = useTranslations\(\);/);
  assert.match(texts, /const t = await getTranslations\(\);/);
  assert.match(texts, /from 'next-intl'/);
  assert.match(texts, /from 'next-intl\/server'/);
});
check("binding UNSAFE: file already uses a translation hook", () => {
  const src = `'use client'\nimport {useTranslations} from 'next-intl'\nexport default function P(){const t=useTranslations();return <button>Save</button>;}`;
  const plan = planBinding("P.tsx", src, [src.indexOf("Save")]);
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /already calls a translation hook/);
});
check("binding UNSAFE: arrow expression-body component (no block to inject into)", () => {
  const src = `export const Card = () => <button>Save</button>;`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Card.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, false, "no block body -> cannot place a binding safely");
});
check("binding: multiple block-body components each get their own binding", () => {
  const src = `'use client'\nexport function A(){return <button>One</button>;}\nexport function B(){return <button>Two</button>;}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("M.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  const bindings = plan.edits.filter((e) => /const t = useTranslations/.test(e.text));
  assert.equal(bindings.length, 2, "one binding per owning component");
});
check("binding UNSAFE: copy lives outside any component function", () => {
  // string in a module-level array constant rendered elsewhere
  const src = `const labels = <button>Save</button>;\nexport default function P(){ return labels; }`;
  const cs = ex(src); assignKeys(cs);
  const highs = byCls(cs, "HIGH");
  const plan = planBinding("P.tsx", src, highs.map((c) => c.start));
  // 'labels' is a module-level VariableDeclaration, not component-shaped (lowercase) -> unsafe
  assert.equal(plan.safe, false);
});

// ============================================================================
// 5. already-partially-i18n'd files + catalog nesting
// ============================================================================
check("fileI18nState detects existing next-intl / hook usage", () => {
  assert.equal(fileI18nState(`import {useTranslations} from 'next-intl'`).hasNextIntl, true);
  assert.equal(fileI18nState(`const t = getTranslations('X')`).usesHook, true);
  assert.equal(fileI18nState(`export default function P(){}`).usesHook, false);
});
check("already-i18n'd JSX: {t('x')} expressions are not re-extracted", () => {
  const cs = ex(wrap(`<button>{t('demo.save')}</button>`));
  assert.equal(byCls(cs, "HIGH").length, 0, "an existing t() call is an expression, not a literal");
});
check("nestLocale: flat dotted keys expand to nested (next-intl resolves nested only)", () => {
  const nested = nestLocale({ "demo.save": "Save", "demo.cancel": "Cancel", "nav.home": "Home" }) as Record<string, Record<string, string>>;
  assert.equal(nested.demo.save, "Save");
  assert.equal(nested.demo.cancel, "Cancel");
  assert.equal(nested.nav.home, "Home");
});

// ============================================================================
// 6. end-to-end: only safe strings rewired; build-shape preserved; catalog correct
// ============================================================================
check("end-to-end mixed component: clean labels wired, prose/icon/version left intact", () => {
  const src = `'use client'\nexport default function App(){\n  return (<div>` +
    `<button>Submit</button>` +
    `<span className="material-icons">send</span>` +
    `<p>See <a href="#">docs</a> here</p>` +
    `<small>v2.3.1</small>` +
    `<input placeholder="Email address" />` +
    `</div>);\n}`;
  const cs = extractJsxFile("App.tsx", src).candidates; assignKeys(cs);
  const locales = buildLocales(cs);
  assert.deepEqual(Object.values(locales.en).sort(), ["Email address", "Submit"]);
  const { out, result } = rewriteJsxFile("App.tsx", src, cs, false);
  assert.equal(result.corrupted, false);
  assert.ok(out.includes(`{t('app.submit')}`));
  assert.ok(out.includes(`placeholder={t('app.email_address')}`));
  assert.ok(out.includes(`material-icons">send<`), "icon ligature intact");
  assert.ok(out.includes(`<a href="#">docs</a>`), "sentence fragment intact");
  assert.ok(out.includes(`<small>v2.3.1</small>`), "version intact");
  assert.equal(jsxParseErrors("App.tsx", out), 0);
});

// ============================================================================
// 7. react-i18next path: binding hook + plain-React scaffold (Vite / CRA)
// ============================================================================
check("binding react-i18next: useTranslation() hook + import, never async/server", () => {
  const src = `export default function Page(){\n  return <button>Save</button>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start), "react-i18next");
  assert.equal(plan.safe, true);
  const texts = plan.edits.map((e) => e.text).join("|");
  assert.match(texts, /import \{ useTranslation \} from 'react-i18next'/);
  assert.match(texts, /const \{ t \} = useTranslation\(\);/);
  assert.ok(!/next-intl/.test(texts), "no next-intl in the react path");
  assert.ok(!/getTranslations/.test(texts), "no server hook in the react path");
});
check("binding react-i18next UNSAFE: async component cannot take the hook", () => {
  const src = `export default async function Page(){ const d = await x(); return <h1>Welcome</h1>; }`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start), "react-i18next");
  assert.equal(plan.safe, false);
  assert.match(plan.reason, /async component cannot receive/);
});

const mkapp = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18nswarm-react-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return dir;
};
const locales = { en: { "app.save": "Save", "app.email": "Email" }, ja: { "app.save": "Save", "app.email": "Email" }, translationTodo: [{ key: "app.save", en: "Save" }] };

check("scaffoldReact (Vite/TS, no resolveJsonModule): inlines resources, wires <I18nextProvider>", () => {
  const dir = mkapp({
    "package.json": JSON.stringify({ name: "vite-ts", dependencies: { react: "^18.0.0" } }),
    "tsconfig.app.json": JSON.stringify({ compilerOptions: { moduleResolution: "Bundler" } }),
    "src/main.tsx": `import ReactDOM from 'react-dom/client';\nimport App from './App.tsx';\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
  });
  const r = scaffoldReact(dir, path.join(dir, "src"), locales, true);
  const init = fs.readFileSync(path.join(dir, "src/i18n/index.ts"), "utf8");
  assert.ok(!/from '\.\/locales/.test(init), "TS app w/o resolveJsonModule must inline, not import JSON");
  assert.match(init, /const en: Record<string, string> =/);
  assert.match(init, /useSuspense: false/);
  const entry = fs.readFileSync(path.join(dir, "src/main.tsx"), "utf8");
  assert.match(entry, /import i18n from '\.\/i18n'/);
  assert.match(entry, /<I18nextProvider i18n=\{i18n\}><React\.StrictMode>/);
  assert.match(entry, /<\/React\.StrictMode><\/I18nextProvider>/);
  assert.equal(jsxParseErrors("main.tsx", entry), 0, "wired entry still parses");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["react-i18next"] && pkg.dependencies["i18next"], "deps added");
  assert.ok(r.steps.some((s) => /index\.ts/.test(s)));
  fs.rmSync(dir, { recursive: true, force: true });
});
check("scaffoldReact (JS/CRA-shape): writes index.js with JSON import, wires entry", () => {
  const dir = mkapp({
    "package.json": JSON.stringify({ name: "cra-js", dependencies: { react: "^18.0.0", "react-scripts": "5.0.0" } }),
    "src/index.js": `import ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n`,
  });
  scaffoldReact(dir, path.join(dir, "src"), locales, true);
  assert.ok(fs.existsSync(path.join(dir, "src/i18n/index.js")), "JS app -> index.js");
  const init = fs.readFileSync(path.join(dir, "src/i18n/index.js"), "utf8");
  assert.match(init, /import en from '\.\/locales\/en\.json'/);
  const entry = fs.readFileSync(path.join(dir, "src/index.js"), "utf8");
  assert.match(entry, /<I18nextProvider i18n=\{i18n\}><App \/><\/I18nextProvider>/);
  assert.equal(jsxParseErrors("index.js", entry), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
check("scaffoldReact: idempotent + unusual entry -> review (no double-wire / no risk)", () => {
  // already-wired entry: left untouched
  const d1 = mkapp({
    "package.json": JSON.stringify({ name: "a", dependencies: { react: "^18.0.0" } }),
    "src/main.tsx": `import i18n from './i18n';\nimport ReactDOM from 'react-dom/client';\nReactDOM.createRoot(x).render(<App />);\n`,
  });
  const r1 = scaffoldReact(d1, path.join(d1, "src"), locales, true);
  assert.ok(r1.steps.some((s) => /already wires i18n/.test(s)));
  fs.rmSync(d1, { recursive: true, force: true });
  // no render() call found: provider wiring punted to the review queue, init still written
  const d2 = mkapp({
    "package.json": JSON.stringify({ name: "b", dependencies: { react: "^18.0.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
    "src/main.tsx": `export const x = 1;\n`,
  });
  const r2 = scaffoldReact(d2, path.join(d2, "src"), locales, true);
  assert.ok(fs.existsSync(path.join(d2, "src/i18n/index.ts")), "init still scaffolded");
  assert.ok(r2.warnings.some((w) => /no React entry|render\(\) root element/.test(w)), "entry wiring left for review");
  fs.rmSync(d2, { recursive: true, force: true });
});

process.stdout.write(Buffer.from(`\nJSX SELFCHECK PASSED: ${n} checks\n`, "utf8"));
