import assert from "node:assert/strict";
import {
  buildAuditReport, auditMarkdown, topHardcodedFiles, countLocalizedCallsites,
  type AuditReport, type FileHardcode,
} from "../src/audit.ts";
import type { Candidate } from "../src/types.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }

function cand(p: Partial<Candidate>): Candidate {
  return { file: "/repo/a.tsx", kind: "text", tag: "p", text: "", raw: "", start: 0, end: 0, cls: "SKIP", reason: "", ...p } as Candidate;
}

const A = "/repo/app/page.tsx";
const B = "/repo/components/card.tsx";
const C = "/repo/components/icon.tsx";

// --- 1. countLocalizedCallsites -------------------------------------------------------
check("countLocalizedCallsites counts t('..') / $t('..') and ignores effect(/import(", () => {
  const src = `const t = useTranslations(); return <p>{t('a.b')}</p>; useEffect(()=>{}); import('x'); {$t('c.d')}`;
  // t('a.b') and $t('c.d') -> 2 ; useEffect( / import( must NOT match \bt\(
  assert.equal(countLocalizedCallsites([src]), 2);
});
check("countLocalizedCallsites: a no-i18n source has zero call-sites", () => {
  assert.equal(countLocalizedCallsites([`export default function P(){ return <h1>Hello</h1>; }`]), 0);
});

// --- 2. topHardcodedFiles -------------------------------------------------------------
check("topHardcodedFiles ranks files by hardcoded count, splits HIGH vs AMBIGUOUS, posix-relative path", () => {
  const cands: Candidate[] = [
    cand({ file: A, cls: "HIGH" }), cand({ file: A, cls: "HIGH" }), cand({ file: A, cls: "AMBIGUOUS" }),
    cand({ file: B, cls: "HIGH" }),
    cand({ file: C, cls: "SKIP" }), // non-UI -> excluded entirely
  ];
  const top = topHardcodedFiles(cands, "/repo", 10);
  assert.equal(top.length, 2, "icon.tsx had only SKIP, so it is not listed");
  assert.equal(top[0].file, "app/page.tsx");
  assert.equal(top[0].hardcoded, 3);
  assert.equal(top[0].autoWirable, 2);
  assert.equal(top[0].review, 1);
  assert.equal(top[1].file, "components/card.tsx");
  assert.equal(top[1].hardcoded, 1);
});

// --- 3. buildAuditReport --------------------------------------------------------------
function input(over: Partial<Parameters<typeof buildAuditReport>[0]> = {}) {
  const topFiles: FileHardcode[] = [
    { file: "app/page.tsx", hardcoded: 20, autoWirable: 18, review: 2 },
    { file: "components/card.tsx", hardcoded: 6, autoWirable: 5, review: 1 },
  ];
  return {
    repo: "open-react-template", framework: "next (App Router)",
    hasI18n: false, library: null,
    componentFiles: 13, parseErrors: 0, scanned: 240,
    hardcoded: 99, nonUiSkipped: 141, autoWired: 84, corruptions: 0,
    review: { prose: 12, unusualComponents: 2, translations: 84 },
    topFiles, localizedCallsites: 0, ...over,
  };
}

check("buildAuditReport: no i18n -> 100% hardcoded share, baseline = hardcoded count", () => {
  const r = buildAuditReport(input());
  assert.equal(r.i18n.wired, false);
  assert.equal(r.strings.hardcodedSharePct, 100, "no t() call-sites -> all UI copy is hardcoded");
  assert.equal(r.retrofit.autoHandledPct, 84.8, "84/99");
  assert.equal(r.retrofit.reviewQueue, 14, "prose 12 + unusual 2; translations are a separate axis");
  assert.equal(r.retrofit.review.translations, 84, "translations reported separately, not in reviewQueue");
  assert.equal(r.driftGate.baseline, 99);
  assert.match(r.driftGate.valueLine, /baseline of 99/);
});

check("buildAuditReport: i18n wired with call-sites -> fractional drift share + drift wording", () => {
  const r = buildAuditReport(input({ hasI18n: true, library: "next-intl", hardcoded: 10, localizedCallsites: 90 }));
  assert.equal(r.i18n.wired, true);
  assert.equal(r.strings.hardcodedSharePct, 10, "10 / (10 + 90)");
  assert.match(r.i18n.note, /wired via next-intl/);
  assert.match(r.driftGate.valueLine, /drifted past the wired setup|pins the baseline at 10/);
});

check("buildAuditReport: no UI copy at all -> share is null (no false 100%)", () => {
  const r = buildAuditReport(input({ hardcoded: 0, localizedCallsites: 0, autoWired: 0, review: { prose: 0, unusualComponents: 0, translations: 0 }, topFiles: [] }));
  assert.equal(r.strings.hardcodedSharePct, null);
  assert.equal(r.retrofit.autoHandledPct, 0);
  assert.match(r.retrofit.summary, /No hardcoded user-facing strings/);
});

// --- 4. auditMarkdown -----------------------------------------------------------------
check("auditMarkdown: PR-body-ready - headline, summary table, top files, review queue, drift gate, faceless footer", () => {
  const r = buildAuditReport(input());
  const md = auditMarkdown(r);
  assert.ok(md.startsWith("# i18n readiness — open-react-template"));
  assert.match(md, /No i18n is wired\. 99 user-facing strings are hardcoded across 2 files\./);
  assert.match(md, /\| Hardcoded user-facing strings \| 99 \|/);
  assert.match(md, /\| Share of detected UI copy hardcoded \| 100% \|/);
  assert.match(md, /\| Auto-wired by a deterministic retrofit \| 84 \(84\.8% of hardcoded\) \|/);
  assert.match(md, /\| Not auto-wired \(needs a human\) \| 14 \(12 prose, 2 unusual\) \|/);
  assert.match(md, /\| Translations awaiting a ja value \| 84 \|/);
  assert.match(md, /## Top files by hardcoded strings/);
  assert.match(md, /`app\/page\.tsx`/);
  assert.match(md, /## Review queue/);
  assert.match(md, /## Drift gate/);
  assert.match(md, /Generated by i18n-swarm v.*read-only audit; no files were changed/);
});

check("auditMarkdown: contains no emoji and no AI self-labels", () => {
  const md = auditMarkdown(buildAuditReport(input()));
  // no emoji / pictographs
  assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(md), "no emoji");
  assert.ok(!/\b(as an ai|cold[- ]honest|verbatim)\b/i.test(md), "no AI self-labels");
});

check("auditMarkdown: empty top-files renders a clean 'none' line, not a broken table", () => {
  const r = buildAuditReport(input({ hardcoded: 0, autoWired: 0, review: { prose: 0, unusualComponents: 0, translations: 0 }, topFiles: [] }));
  const md = auditMarkdown(r);
  assert.match(md, /_No hardcoded user-facing strings found\._/);
});

process.stdout.write(Buffer.from(`\nAUDIT SELFCHECK PASSED: ${n} checks\n`, "utf8"));
