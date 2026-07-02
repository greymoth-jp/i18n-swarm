// Self-checks for the false-positive suppression layer (src/suppress.ts).
// One independent check per bucket, plus the two safety invariants the gate depends on:
//   (1) real UI copy is NEVER suppressed (no false-negatives introduced), and
//   (2) suppression is config-extensible without code changes.
import assert from "node:assert/strict";
import {
  isHandle, isBrand, isDecorativeImageText, isCodeish, isDevOnlyPath, hasInlineIgnore,
  classifySuppression, makeConfig, defaultConfig,
} from "../src/suppress.ts";
import { extractJsxFile } from "../src/extract-jsx.ts";
import type { Candidate } from "../src/types.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }
const cfg = defaultConfig();
const cand = (text: string, extra: Partial<Candidate> = {}): Candidate =>
  ({ file: "f.tsx", kind: "text", tag: "span", text, raw: text, start: 0, end: text.length, cls: "HIGH", reason: "", ...extra });

// ---------------------------------------------------------------------------
// bucket 1: brand / proper-noun / handle
// ---------------------------------------------------------------------------
check("brand: whole-string brands and handles are suppressed; sentences mentioning a brand are NOT", () => {
  for (const b of ["GitHub", "Stripe", "Clerk", "Vercel", "Bootstrap", "React"]) assert.ok(isBrand(b, cfg), b);
  assert.ok(isHandle("@mdo") && isBrand("@mdo", cfg));
  assert.ok(isBrand("Clerk logo", cfg), "'<brand> logo' is a brand-logo label");
  // a phrase that merely contains a brand is real copy -> not a brand match
  assert.ok(!isBrand("Deploy to Vercel", cfg));
  assert.ok(!isBrand("Introducing Precedent", cfg));
  assert.ok(!isBrand("Sign in with GitHub", cfg));
});

// ---------------------------------------------------------------------------
// bucket 2: decorative (empty/decorative alt, aria-hidden context)
// ---------------------------------------------------------------------------
check("decorative: filename / illustration / logo / slide alt suppressed; descriptive alt kept", () => {
  assert.ok(isDecorativeImageText("alt", "hero.png"));
  assert.ok(isDecorativeImageText("alt", "Page illustration"));
  assert.ok(isDecorativeImageText("alt", "Blurred shape"));
  assert.ok(isDecorativeImageText("alt", "First slide"));
  assert.ok(isDecorativeImageText("alt", "avatar"));
  assert.ok(isDecorativeImageText("alt", "Clerk logo"));
  // a real, informative alt sentence is kept
  assert.ok(!isDecorativeImageText("alt", "Chart showing weekly revenue growth"));
  // only alt is treated this way, not text nodes
  assert.ok(!isDecorativeImageText(undefined, "Blurred shape"));
});
check("decorative: aria-hidden / role=presentation context flag is suppressed", () => {
  const c = cand("→", { decorative: true });
  assert.equal(classifySuppression(c, "f.tsx", "<span aria-hidden>→</span>", cfg).bucket, "decorative");
});
check("REGRESSION: aria-hidden element's OWN alt attr is suppressed end-to-end (extract -> gate), not just its text children", () => {
  // Before the fix, extractJsxFile never stamped `decorative` on attr candidates, so
  // this alt text (which does not match any isDecorativeImageText pattern on its own)
  // would reach the gate as an unsuppressed HIGH flag -- a false positive on a
  // screen-reader-hidden image.
  const src = `export default function D(){return (<img aria-hidden alt="A red fox" src="/fox.png" />);}`;
  const cs = extractJsxFile("Demo.tsx", src).candidates;
  const alt = cs.find((c) => c.attrName === "alt")!;
  assert.ok(alt, "alt candidate exists");
  const res = classifySuppression(alt, "Demo.tsx", src, cfg);
  assert.equal(res.suppressed, true, "a decorative element's own alt must be suppressed");
  assert.equal(res.bucket, "decorative");
});

// ---------------------------------------------------------------------------
// bucket 3: code-ish (enum / const / kebab / camel / breakpoint / component-name)
// ---------------------------------------------------------------------------
check("codeish: identifiers/enums/breakpoints suppressed; real labels and bare all-caps words kept", () => {
  for (const t of ["useScroll", "nFormatter", "icon-sm", "data_table", "OverlayTrigger", "magicui.design", "FOO_BAR", "primary", "xs", "2xl"])
    assert.ok(isCodeish(t, cfg), t);
  // bare all-caps WITHOUT a separator are real UI copy -> not code-ish
  for (const t of ["OK", "NEW", "FAQ", "PRO"]) assert.ok(!isCodeish(t, cfg), t);
  // real single-word labels are kept
  for (const t of ["Home", "Settings", "Save", "Close", "Next", "Profile", "Search"]) assert.ok(!isCodeish(t, cfg), t);
  // a capitalized variant word (heading) is kept; only the lower-case enum spelling is code-ish
  assert.ok(!isCodeish("Primary", cfg) && isCodeish("primary", cfg));
});

// ---------------------------------------------------------------------------
// bucket 4: dev-only paths
// ---------------------------------------------------------------------------
check("devpath: og-image / config / scripts / stories / indicator files suppressed; app files kept", () => {
  for (const p of [
    "app/opengraph-image.tsx", "app/twitter-image.tsx", "next.config.tsx", "src/Button.stories.tsx",
    "scripts/gen.tsx", "src/__tests__/x.tsx", "components/tailwind-indicator.tsx", "test/x.spec.jsx",
  ]) assert.ok(isDevOnlyPath(p, cfg), p);
  for (const p of ["app/page.tsx", "components/layout/navbar.tsx", "src/scenes/dashboard/index.jsx"])
    assert.ok(!isDevOnlyPath(p, cfg), p);
});

// ---------------------------------------------------------------------------
// bucket 5: inline directive
// ---------------------------------------------------------------------------
check("directive: // i18n-ignore on the same or preceding line suppresses the flag", () => {
  const src = [
    "<div>",
    "  {/* i18n-ignore */}",
    "  <span>DEBUG ONLY</span>",   // line 3 -> offset of "DEBUG" below
    "  <span>Real Copy</span>",
    "</div>",
  ].join("\n");
  const off = src.indexOf("DEBUG ONLY");
  assert.ok(hasInlineIgnore(src, off), "preceding {/* i18n-ignore */} suppresses");
  const trailing = '<span>X</span> // i18n-ignore';
  assert.ok(hasInlineIgnore(trailing, trailing.indexOf("X")), "trailing // i18n-ignore on same line");
  const off2 = src.indexOf("Real Copy");
  assert.ok(!hasInlineIgnore(src, off2), "an un-annotated line is not suppressed");
});

// ---------------------------------------------------------------------------
// safety invariant: genuine UI copy is never suppressed (FN = 0)
// ---------------------------------------------------------------------------
check("safety: real user-facing copy survives every bucket (no false-negative)", () => {
  const real = [
    "Sign In", "Save changes", "Active Generators", "Total Fuel Consumption (GPH)", "Toggle theme",
    "Building blocks for your Next project", "Welcome back", "Search", "Documentation", "Home",
    "Forgot password?", "Your cart is empty",
  ];
  for (const t of real) {
    const r = classifySuppression(cand(t), "app/page.tsx", `<span>${t}</span>`, cfg);
    assert.equal(r.suppressed, false, `must NOT suppress real copy: ${JSON.stringify(t)} (got ${r.bucket})`);
  }
});

// ---------------------------------------------------------------------------
// config extensibility: a team can pin its own product nouns + demo tokens
// ---------------------------------------------------------------------------
check("config: user brands/enums/ignorePaths extend the defaults without code changes", () => {
  const ext = makeConfig({ brands: ["Acme", "Otto"], enums: ["truncate"], ignorePaths: ["(^|/)demo/"] });
  assert.ok(isBrand("Acme", ext) && isBrand("Otto", ext));
  assert.ok(isCodeish("truncate", ext), "user enum token now code-ish");
  assert.ok(isDevOnlyPath("src/demo/Showcase.tsx", ext), "user ignorePath honored");
  // defaults still apply on top of user config
  assert.ok(isBrand("GitHub", ext));
  // and the un-extended default config does NOT suppress these
  assert.ok(!isBrand("Acme", cfg) && !isCodeish("truncate", cfg));
});

process.stdout.write(Buffer.from(`\nSUPPRESS SELFCHECK PASSED: ${n} checks\n`, "utf8"));
