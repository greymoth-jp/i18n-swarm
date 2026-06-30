import assert from "node:assert/strict";
import {
  hasLetter, norm, isVersionLike, isIconClass, isComponentTag,
  classifyText, classifyAttr, classifyExprString,
} from "../src/classify-core.ts";
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
check("classifyAttr: text-attr HIGH, never-copy null, component-prop AMBIGUOUS, host-prop null", () => {
  assert.equal(classifyAttr("placeholder", "Your name", "input")!.cls, "HIGH");
  assert.equal(classifyAttr("alt", "A cat", "img")!.cls, "HIGH");
  assert.equal(classifyAttr("href", "/about", "a"), null);
  assert.equal(classifyAttr("className", "btn primary", "div"), null);
  assert.equal(classifyAttr("title", "Open settings", "div")!.cls, "HIGH", "title is a user-facing attr");
  assert.equal(classifyAttr("title", "123", "div"), null, "no-letter title value is not copy");
  assert.equal(classifyAttr("label", "Submit", "Button")!.cls, "AMBIGUOUS");
  assert.equal(classifyAttr("data-foo", "Bar baz", "div"), null, "unknown host attr -> not copy");
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
check("component prop string is AMBIGUOUS (never auto-rewired)", () => {
  const amb = byCls(ex(wrap(`<Greeting message="You did it!" />`)), "AMBIGUOUS");
  assert.equal(amb.length, 1);
  assert.equal(amb[0].attrName, "message");
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
check("binding SERVER: injects getTranslations() (awaited) + makes component async", () => {
  const src = `export default function Page(){\n  return <button>Save</button>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  assert.equal(plan.scope, "server");
  const texts = plan.edits.map((e) => e.text);
  assert.ok(texts.some((t) => /getTranslations\(\)/.test(t)));
  assert.ok(texts.some((t) => /await/.test(t)));
  assert.ok(texts.includes("async "), "non-async server component is made async");
});
check("binding SERVER already async: no extra async insert", () => {
  const src = `export default async function Page(){\n  const d = await load();\n  return <h1>Welcome</h1>;\n}`;
  const cs = ex(src); assignKeys(cs);
  const plan = planBinding("Page.tsx", src, byCls(cs, "HIGH").map((c) => c.start));
  assert.equal(plan.safe, true);
  assert.ok(!plan.edits.map((e) => e.text).includes("async "));
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

process.stdout.write(Buffer.from(`\nJSX SELFCHECK PASSED: ${n} checks\n`, "utf8"));
