import assert from "node:assert/strict";
import {
  esc, buildReviewQueue, verdictCardSvg, reportHtml, summaryLine,
  type ProductSummary,
} from "../src/report.ts";
import type { JsxOutput } from "../src/react-pipeline.ts";
import type { Snapshot } from "../src/snapshot.ts";
import type { VerifyDecision } from "../src/verdict.ts";
import type { Candidate } from "../src/types.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }

const A = "/repo/Hero.tsx";
const B = "/repo/Card.tsx";

function cand(p: Partial<Candidate>): Candidate {
  return { file: A, kind: "text", tag: "p", text: "", raw: "", start: 0, end: 0, cls: "SKIP", reason: "", ...p } as Candidate;
}

function fakeOut(): JsxOutput {
  const candidates: Candidate[] = [
    cand({ file: A, cls: "AMBIGUOUS", text: "Read the docs first", reason: "sentence with inline element", tag: "p" }),
    cand({ file: B, cls: "HIGH", text: "Save", key: "card.save", tag: "button" }),
  ];
  const fileBinding = new Map<string, { safe: boolean; reason: string; scope: string; edits: never[] }>([
    [A, { safe: true, reason: "no rewrites", scope: "client", edits: [] }],
    [B, { safe: false, reason: "arrow expression-body component (no block to inject into)", scope: "client", edits: [] }],
  ]);
  return {
    repo: { dir: "/repo", name: "open-react-template", framework: "next", srcDir: "/repo/src", sfcFiles: [A, B], hasI18n: false, i18nDep: null, buildScript: "build", typecheckScript: null, testScript: null },
    candidates,
    locales: { en: { "card.save": "Save" }, ja: { "card.save": "Save" }, translationTodo: [{ key: "card.save", en: "Save" }] },
    review: [{ file: A, kind: "text", tag: "p", text: "Read the docs first", reason: "sentence with inline element" }],
    metrics: {
      files: 2, parseErrors: 0, candidates: 2, high: 1, ambiguous: 1, skip: 0, localizable: 2,
      autoHandledPct: 50, uniqueKeys: 1, clientFiles: 2, serverFiles: 0, bindingSafeFiles: 1,
      bindingBlockedFiles: 1, highApplied: 0, highBindingBlocked: 1, effectiveAppliedPct: 0,
      rewriteEdits: 7, rewriteSkipped: 0, corruptions: 0, skipByReason: {}, bindingBlockReasons: {},
    },
    fileBinding: fileBinding as unknown as JsxOutput["fileBinding"],
  };
}

const ph = (ok: boolean, ran = true) => ({ ran, ok, durationMs: 1000, note: ok ? "ok" : "exit 1" });
function snap(buildOk: boolean): Snapshot {
  return {
    step: "verify", install: ph(true), build: ph(buildOk), typecheck: { ran: false, ok: false, durationMs: 0, note: "n/a" },
    test: { ...ph(true, false), stats: { runner: "none", passed: 0, total: 0, failed: 0, parsed: false } as never },
  };
}

const decision = (v: string): VerifyDecision => ({ verdict: v as never, confidence: "HIGH", codeSideTrustWithoutReview: v === "AUTO-VERIFIED", reasons: ["build compiles all components"] });

function summary(over: Partial<ProductSummary> = {}): ProductSummary {
  return {
    repoName: "open-react-template", framework: "next", autoCount: 24, reviewCount: 31,
    autoHandledPct: 44, effectivePct: 38, uniqueKeys: 24, filesRewired: 6, corruptions: 0,
    buildGreen: true, verdict: "AUTO-VERIFIED", trust: true, ...over,
  };
}

// 1. esc
check("esc escapes XML/HTML metacharacters", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

// 2. review queue assembly
check("buildReviewQueue splits AMBIGUOUS->prose, blocked HIGH->unusual, warnings->wiring, todo->translations", () => {
  const q = buildReviewQueue(fakeOut(), ["next.config must be wrapped", "layout must wrap children"]);
  assert.equal(q.prose.length, 1);
  assert.equal(q.prose[0].text, "Read the docs first");
  assert.equal(q.unusualComponents.length, 1, "the binding-blocked HIGH string in Card.tsx");
  assert.match(q.unusualComponents[0].reason, /arrow expression-body/);
  assert.equal(q.providerWiring.length, 2);
  assert.equal(q.translations.length, 1);
  assert.equal(q.counts.total, 5, "1 prose + 1 unusual + 2 wiring + 1 translation");
});

check("buildReviewQueue: a binding-SAFE file's HIGH strings are NOT in the review queue", () => {
  const out = fakeOut();
  // flip B to safe -> its HIGH 'Save' should no longer appear as unusual
  (out.fileBinding as Map<string, { safe: boolean }>).set(B, { safe: true } as never);
  const q = buildReviewQueue(out, []);
  assert.equal(q.unusualComponents.length, 0);
});

// 3. verdict stamp mapping
check("stamp: build green + AUTO-VERIFIED -> BUILD GREEN", () => {
  assert.match(summaryLine(summary()), /BUILD GREEN/);
  assert.match(summaryLine(summary()), /build GREEN/);
});
check("stamp: FAILED -> BUILD RED", () => {
  assert.match(summaryLine(summary({ buildGreen: false, verdict: "FAILED", trust: false })), /BUILD RED/);
});
check("stamp: build green but NEEDS-HUMAN -> NEEDS HUMAN", () => {
  assert.match(summaryLine(summary({ verdict: "NEEDS-HUMAN", trust: false })), /NEEDS HUMAN/);
});

// 4. card svg
check("verdictCardSvg: well-formed SVG with hero %, repo name, stamp, dimensions", () => {
  const svg = verdictCardSvg(summary());
  assert.ok(svg.startsWith("<svg"), "starts with <svg");
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.match(svg, /width="1200" height="630"/);
  assert.match(svg, /38%/, "hero is the effective %");
  assert.match(svg, /open-react-template/);
  assert.match(svg, /BUILD GREEN/);
  assert.match(svg, /24 auto-localized · 31 to review · 0 corruptions/);
});

// 5. html report
check("reportHtml: doctype, embedded card, before/after, all four review buckets", () => {
  const q = buildReviewQueue(fakeOut(), ["next.config must be wrapped"]);
  const html = reportHtml(summary({ autoCount: 0, effectivePct: 0, reviewCount: q.counts.total }), snap(true), snap(true), decision("AUTO-VERIFIED"), q, "<svg></svg>");
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /review queue/);
  assert.match(html, /Read the docs first/, "prose item rendered");
  assert.match(html, /arrow expression-body/, "unusual-component reason rendered");
  assert.match(html, /next\.config must be wrapped/, "wiring warning rendered");
  assert.match(html, /ja awaiting human/, "translation item rendered");
  assert.match(html, /before \/ after/);
});

check("reportHtml: a FAILED build shows the red stamp + NO trust", () => {
  const q = buildReviewQueue(fakeOut(), []);
  const html = reportHtml(summary({ buildGreen: false, verdict: "FAILED", trust: false }), snap(true), snap(false), decision("FAILED"), q, "<svg></svg>");
  assert.match(html, /BUILD RED/);
});

process.stdout.write(Buffer.from(`\nREPORT SELFCHECK PASSED: ${n} checks\n`, "utf8"));
