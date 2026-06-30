import assert from "node:assert/strict";
import { extractFile } from "../src/extract.ts";
import { assignKeys, slug } from "../src/keys.ts";
import { buildLocales } from "../src/catalog.ts";
import { rewriteFile } from "../src/rewire.ts";
import { decideVerdict } from "../src/verdict.ts";
import type { Candidate } from "../src/types.ts";
import type { Snapshot } from "../src/snapshot.ts";

let n = 0;
function check(name: string, fn: () => void) {
  fn();
  n++;
  process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8"));
}

const sfc = (tmpl: string) => `<template>${tmpl}</template>`;
function classifyOne(tmpl: string): Candidate[] {
  return extractFile("Demo.vue", sfc(tmpl)).candidates;
}
function byCls(cs: Candidate[], cls: string) { return cs.filter((c) => c.cls === cls); }

// ---- classification: the trustworthy core --------------------------------------
check("HIGH: sole text child of a leaf element", () => {
  const cs = classifyOne(`<button>Save changes</button>`);
  const high = byCls(cs, "HIGH");
  assert.equal(high.length, 1);
  assert.equal(high[0].text, "Save changes");
});

check("AMBIGUOUS: text fragments + link inside a mixed sentence", () => {
  const cs = classifyOne(`<p>Visit <a href="#">our site</a> today</p>`);
  assert.equal(byCls(cs, "HIGH").length, 0, "nothing in a prose sentence is auto-rewired");
  const amb = byCls(cs, "AMBIGUOUS").map((c) => c.text).sort();
  assert.deepEqual(amb, ["Visit", "our site", "today"]);
});

check("SKIP: icon-font ligature text (would break the glyph)", () => {
  const cs = classifyOne(`<span class="material-icons-outlined">home</span>`);
  const s = byCls(cs, "SKIP");
  assert.equal(s.length, 1);
  assert.match(s[0].reason, /icon-font ligature/);
});

check("SKIP: number / percentage with no letters", () => {
  assert.equal(byCls(classifyOne(`<div>89,400</div>`), "SKIP").length, 1);
  assert.equal(byCls(classifyOne(`<div>60%</div>`), "SKIP").length, 1);
  // but a sentence containing a number is still real copy
  assert.equal(byCls(classifyOne(`<span>21% more than last month</span>`), "HIGH").length, 1);
});

check("SKIP: code / preformatted content", () => {
  const cs = classifyOne(`<pre><code>const x = 1</code></pre>`);
  assert.equal(byCls(cs, "HIGH").length, 0);
  assert.equal(byCls(cs, "SKIP").length, 1);
});

check("interpolation {{ x }} is not a literal candidate at all", () => {
  const cs = classifyOne(`<span>{{ msg }}</span>`);
  assert.equal(cs.length, 0);
});

check("attr: user-facing attribute is HIGH; component prop is AMBIGUOUS", () => {
  const high = byCls(classifyOne(`<input placeholder="Your name">`), "HIGH");
  assert.equal(high.length, 1);
  assert.equal(high[0].kind, "attr");
  assert.equal(high[0].attrName, "placeholder");
  const amb = byCls(classifyOne(`<HelloWorld msg="You did it!" />`), "AMBIGUOUS");
  assert.equal(amb.length, 1);
  assert.equal(amb[0].attrName, "msg");
});

// ---- keys + dedupe -------------------------------------------------------------
check("slug normalizes and bounds length", () => {
  assert.equal(slug("Save changes!"), "save_changes");
  assert.equal(slug("I'm a simple link"), "im_a_simple_link");
  assert.equal(slug("???"), "t");
});

check("identical text in one file collapses to one shared key", () => {
  const cs = classifyOne(`<div><button>Default</button><span>Default</span><button>Primary</button></div>`);
  // div has only element children -> not a sentence container -> all HIGH
  assignKeys(cs);
  const high = byCls(cs, "HIGH");
  assert.equal(high.length, 3);
  const defaults = high.filter((c) => c.text === "Default");
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0].key, defaults[1].key, "same text -> same key");
  assert.notEqual(defaults[0].key, high.find((c) => c.text === "Primary")!.key);
});

// ---- rewire: offset-surgical, verified -----------------------------------------
check("rewire: text -> {{ $t() }} and attr -> :attr binding, offsets correct", () => {
  const src = sfc(`<input placeholder="Name"><button>Save</button>`);
  const cs = extractFile("Demo.vue", src).candidates;
  assignKeys(cs);
  const { out } = rewriteFile("Demo.vue", src, cs, false);
  assert.match(out, /<button>\{\{ \$t\('demo\.save'\) \}\}<\/button>/);
  assert.match(out, /:placeholder="\$t\('demo\.name'\)"/);
  assert.ok(!out.includes(`placeholder="Name"`), "static attr replaced");
});

check("rewire: mismatched offset is skipped, never corrupts the file", () => {
  const src = sfc(`<button>Save</button>`);
  const cs = extractFile("Demo.vue", src).candidates;
  assignKeys(cs);
  // corrupt the stored raw so the slice check fails
  const tampered = cs.map((c) => (c.cls === "HIGH" ? { ...c, raw: "WRONG" } : c));
  const { out, result } = rewriteFile("Demo.vue", src, tampered, false);
  assert.equal(result.edits, 0);
  assert.equal(result.skipped, 1);
  assert.equal(out, src, "source untouched on mismatch");
});

check("end-to-end on a mixed component: only safe strings rewired, catalog correct", () => {
  const src = sfc(
    `<div>` +
    `<button>Submit</button>` +
    `<span class="material-icons">send</span>` +
    `<p>See <a href="#">docs</a> here</p>` +
    `<small>v2.3.1</small>` +
    `</div>`,
  );
  const cs = extractFile("App.vue", src).candidates;
  assignKeys(cs);
  const locales = buildLocales(cs);
  assert.deepEqual(Object.values(locales.en).sort(), ["Submit"], "only the clean label is wired");
  assert.deepEqual(locales.ja, locales.en, "ja seeded with en fallback");
  const { out } = rewriteFile("App.vue", src, cs, false);
  assert.ok(out.includes(`{{ $t('app.submit') }}`));
  assert.ok(out.includes(`material-icons">send<`), "icon ligature left intact");
  assert.ok(out.includes(`<a href="#">docs</a>`), "sentence fragment left intact");
  assert.ok(out.includes(`<small>v2.3.1</small>`), "version number left intact");
});

// ---- verdict: the killer decision ----------------------------------------------
const phase = (ok: boolean, ran = true) => ({ ran, ok, durationMs: 1, note: ok ? "" : "exit 1" });
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    step: "baseline",
    install: phase(true),
    build: phase(true),
    typecheck: phase(true),
    test: { ...phase(true), stats: { runner: "vitest", total: 3, passed: 3, failed: 0, skipped: 0, parsed: true } },
    ...over,
  };
}

check("verdict AUTO-VERIFIED HIGH when build+tests stay green", () => {
  const d = decideVerdict(snap(), snap({ step: "verify" }), 12, 0);
  assert.equal(d.verdict, "AUTO-VERIFIED");
  assert.equal(d.confidence, "HIGH");
  assert.equal(d.codeSideTrustWithoutReview, true);
});

check("verdict FAILED when rewrite breaks a green build", () => {
  const after = snap({ step: "verify", build: phase(false) });
  const d = decideVerdict(snap(), after, 12, 0);
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.codeSideTrustWithoutReview, false);
});

check("verdict FAILED on test regression (silent count drop)", () => {
  const after = snap({ step: "verify", test: { ...phase(true), stats: { runner: "vitest", total: 3, passed: 2, failed: 0, skipped: 0, parsed: true } } });
  const d = decideVerdict(snap(), after, 12, 0);
  assert.equal(d.verdict, "FAILED");
});

check("verdict NEEDS-HUMAN when nothing was rewired", () => {
  const d = decideVerdict(snap(), snap({ step: "verify" }), 0, 0);
  assert.equal(d.verdict, "NEEDS-HUMAN");
});

check("verdict MEDIUM (no auto-trust) when build green but project has no tests", () => {
  const noTest = { ran: false, ok: false, durationMs: 0, note: "no test", stats: { runner: "unknown", total: 0, passed: 0, failed: 0, skipped: 0, parsed: false } };
  const d = decideVerdict(snap({ test: noTest }), snap({ step: "verify", test: noTest }), 12, 0);
  assert.equal(d.verdict, "AUTO-VERIFIED");
  assert.equal(d.confidence, "MEDIUM");
  assert.equal(d.codeSideTrustWithoutReview, false);
});

process.stdout.write(Buffer.from(`\nSELFCHECK PASSED: ${n} checks\n`, "utf8"));
