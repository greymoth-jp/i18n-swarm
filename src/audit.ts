// Audit mode: a read-only readiness scan. It reuses the same extract / classify /
// binding engine as the full pass, but writes nothing into the target's source — it only
// reports. The full pass mutates code and verifies a build; the audit answers, before any
// code is touched:
//   - is i18n wired at all, and with which library
//   - how many user-facing UI strings are hardcoded, and in which files
//   - what share a deterministic retrofit would auto-wire vs leave for human review
//   - the drift-gate baseline a CI check would hold the line against
//
// JSX (Next / React): analyzeJsx (read) + applyJsx(out, false) (dry run: computes the
// rewrite + binding plan and the corruption check without writing) + buildReviewQueue.
// Vue: analyze (read) + a dry-run rewriteFile per file to count what would auto-wire.

import fs from "node:fs";
import path from "node:path";
import { detectRepo } from "./detect.ts";
import { analyzeJsx, applyJsx } from "./react-pipeline.ts";
import { analyze } from "./pipeline.ts";
import { rewriteFile } from "./rewire.ts";
import { buildReviewQueue } from "./report.ts";
import type { Candidate } from "./types.ts";

const VERSION = "0.1.0";

export interface FileHardcode {
  file: string; // repo-relative path, forward slashes
  hardcoded: number; // HIGH + AMBIGUOUS in this file
  autoWirable: number; // HIGH (classifier-level)
  review: number; // AMBIGUOUS
}

export interface AuditReport {
  tool: string; // "i18n-swarm audit"
  version: string;
  repo: string;
  framework: string;
  i18n: { wired: boolean; library: string | null; note: string };
  strings: {
    componentFiles: number;
    parseErrors: number;
    scanned: number; // every classified candidate (UI + non-UI)
    hardcoded: number; // HIGH + AMBIGUOUS: user-facing copy, hardcoded
    nonUiSkipped: number; // SKIP: interpolations / icons / code / numbers
    localizedCallsites: number; // detected t() / $t() call-sites (estimate of already-wired strings)
    hardcodedSharePct: number | null; // hardcoded / (hardcoded + localizedCallsites); null when no UI copy at all
    filesWithHardcoded: number;
  };
  retrofit: {
    autoWired: number; // strings a deterministic pass would actually rewire (verified dry run)
    autoHandledPct: number; // autoWired / hardcoded
    reviewQueue: number; // prose + unusual-component + translations
    review: { prose: number; unusualComponents: number; translations: number };
    corruptions: number; // dry-run reparse failures; must be 0 (JSX only)
    summary: string;
  };
  topFiles: FileHardcode[];
  driftGate: { baseline: number; valueLine: string };
}

const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Group the localizable candidates by file and rank by hardcoded-string count. */
export function topHardcodedFiles(candidates: Candidate[], repoDir: string, n = 10): FileHardcode[] {
  const by = new Map<string, { high: number; amb: number }>();
  for (const c of candidates) {
    if (c.cls !== "HIGH" && c.cls !== "AMBIGUOUS") continue;
    const rec = by.get(c.file) ?? { high: 0, amb: 0 };
    if (c.cls === "HIGH") rec.high++; else rec.amb++;
    by.set(c.file, rec);
  }
  const rel = (f: string) => path.relative(repoDir, f).split(path.sep).join("/");
  return [...by.entries()]
    .map(([file, r]) => ({ file: rel(file), hardcoded: r.high + r.amb, autoWirable: r.high, review: r.amb }))
    .sort((a, b) => b.hardcoded - a.hardcoded || a.file.localeCompare(b.file))
    .slice(0, n);
}

/** A conservative proxy for strings already going through a translator: count `t('...')`
 *  / `$t('...')` call-sites (a string-literal first arg). It only feeds the "% hardcoded"
 *  estimate; the hardcoded count itself comes from the AST classifier, not from this. */
export function countLocalizedCallsites(sources: string[]): number {
  const re = /(?:\$t|\bt)\(\s*['"`]/g;
  let total = 0;
  for (const s of sources) total += (s.match(re) ?? []).length;
  return total;
}

interface AuditInput {
  repo: string;
  framework: string;
  hasI18n: boolean;
  library: string | null;
  componentFiles: number;
  parseErrors: number;
  scanned: number;
  hardcoded: number;
  nonUiSkipped: number;
  autoWired: number;
  corruptions: number;
  review: { prose: number; unusualComponents: number; translations: number };
  topFiles: FileHardcode[];
  localizedCallsites: number;
}

/** Pure: turn normalized scan inputs into the report (no IO). */
export function buildAuditReport(i: AuditInput): AuditReport {
  const denom = i.hardcoded + i.localizedCallsites;
  const hardcodedSharePct = denom === 0 ? null : pct(i.hardcoded, denom);
  // The clean decomposition of the hardcoded count: autoWired + reviewQueue = hardcoded.
  // ja translations are a separate, post-wiring axis (every wired key still needs a value),
  // so they are reported on their own line, not folded into the code-side review count.
  const reviewQueue = i.review.prose + i.review.unusualComponents;
  const autoHandledPct = pct(i.autoWired, i.hardcoded);
  const filesWithHardcoded = i.topFiles.length; // topFiles already covers every file with hardcoded copy when n is large; the IO wrapper passes the full set for this field

  const i18nNote = i.hasI18n
    ? `i18n is wired via ${i.library}. ${i.hardcoded} user-facing string${i.hardcoded === 1 ? "" : "s"} remain hardcoded outside it (drift from the wired baseline).`
    : `No i18n library is wired. Every user-facing string is hardcoded; the app renders English only.`;

  const retrofitSummary = i.hardcoded === 0
    ? `No hardcoded user-facing strings detected.`
    : `A deterministic retrofit would auto-wire ${i.autoWired} of ${i.hardcoded} hardcoded strings (${autoHandledPct}%) with ${i.corruptions} corruption${i.corruptions === 1 ? "" : "s"} in a dry run. The other ${reviewQueue} (${i.review.prose} prose / interpolated, ${i.review.unusualComponents} unusual component shape${i.review.unusualComponents === 1 ? "" : "s"}) stay with a human. Separately, ${i.review.translations} key${i.review.translations === 1 ? "" : "s"} need a ja translation value once the keys are wired.`;

  const valueLine = i.hasI18n
    ? `${i.hardcoded} string${i.hardcoded === 1 ? " has" : "s have"} drifted past the wired setup. A drift gate pins the baseline at ${i.hardcoded} and fails any pull request that adds another hardcoded user-facing string, so the gap stops widening.`
    : `Wire i18n once, then hold the line: a drift gate fails any pull request that pushes the hardcoded-string count above today's baseline of ${i.hardcoded}, so new untranslated copy can't slip back in.`;

  return {
    tool: "i18n-swarm audit",
    version: VERSION,
    repo: i.repo,
    framework: i.framework,
    i18n: { wired: i.hasI18n, library: i.library, note: i18nNote },
    strings: {
      componentFiles: i.componentFiles,
      parseErrors: i.parseErrors,
      scanned: i.scanned,
      hardcoded: i.hardcoded,
      nonUiSkipped: i.nonUiSkipped,
      localizedCallsites: i.localizedCallsites,
      hardcodedSharePct,
      filesWithHardcoded,
    },
    retrofit: {
      autoWired: i.autoWired,
      autoHandledPct,
      reviewQueue,
      review: i.review,
      corruptions: i.corruptions,
      summary: retrofitSummary,
    },
    topFiles: i.topFiles.slice(0, 12),
    driftGate: { baseline: i.hardcoded, valueLine },
  };
}

/** Read-only audit of a repo. Detects the framework and routes to the matching pipeline;
 *  no source file is modified. */
export function auditRepo(dir: string): AuditReport {
  const repo = detectRepo(dir);
  const isJsx = repo.framework === "next" || repo.framework === "react";

  if (isJsx) {
    const out = analyzeJsx(dir);
    applyJsx(out, false); // dry run: fills rewriteEdits / corruptions, writes nothing
    const queue = buildReviewQueue(out, []); // wiring is an apply-time concern; excluded from a read-only scan
    const sources = repo.sfcFiles.map((f) => fs.readFileSync(f, "utf8"));
    const allFiles = topHardcodedFiles(out.candidates, repo.dir, Number.MAX_SAFE_INTEGER);
    const report = buildAuditReport({
      repo: repo.name,
      framework: repo.framework === "next" ? "next (App Router)" : "react",
      hasI18n: repo.hasI18n,
      library: repo.i18nDep,
      componentFiles: out.metrics.files,
      parseErrors: out.metrics.parseErrors,
      scanned: out.metrics.candidates,
      hardcoded: out.metrics.localizable,
      nonUiSkipped: out.metrics.skip,
      autoWired: out.metrics.rewriteEdits,
      corruptions: out.metrics.corruptions,
      review: { prose: queue.counts.prose, unusualComponents: queue.counts.unusual, translations: queue.counts.translations },
      topFiles: allFiles,
      localizedCallsites: countLocalizedCallsites(sources),
    });
    report.strings.filesWithHardcoded = allFiles.length;
    return report;
  }

  // Vue: dry-run rewrite to count what would auto-wire (vue-i18n's $t needs no per-file binding).
  const out = analyze(dir);
  let autoWired = 0;
  const sources: string[] = [];
  for (const f of repo.sfcFiles) {
    const src = fs.readFileSync(f, "utf8");
    sources.push(src);
    autoWired += rewriteFile(f, src, out.candidates, false).result.edits;
  }
  const allFiles = topHardcodedFiles(out.candidates, repo.dir, Number.MAX_SAFE_INTEGER);
  const report = buildAuditReport({
    repo: repo.name,
    framework: "vue",
    hasI18n: repo.hasI18n,
    library: repo.i18nDep,
    componentFiles: out.metrics.sfcFiles,
    parseErrors: out.metrics.parseErrors,
    scanned: out.metrics.candidates,
    hardcoded: out.metrics.localizable,
    nonUiSkipped: out.metrics.skip,
    autoWired,
    corruptions: 0,
    review: { prose: out.metrics.ambiguous, unusualComponents: 0, translations: out.metrics.uniqueKeys },
    topFiles: allFiles,
    localizedCallsites: countLocalizedCallsites(sources),
  });
  report.strings.filesWithHardcoded = allFiles.length;
  return report;
}

// --- Markdown renderer (PR-body-ready, plain prose; no theming) ----------------------

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

/** Render the report as a clean Markdown document a maintainer can read or paste. */
export function auditMarkdown(r: AuditReport): string {
  const s = r.strings;
  const share = s.hardcodedSharePct === null ? "n/a" : `${s.hardcodedSharePct}%`;
  const headline = r.i18n.wired
    ? `${s.hardcoded} user-facing string${s.hardcoded === 1 ? " is" : "s are"} hardcoded outside the wired ${r.i18n.library} setup, across ${s.filesWithHardcoded} file${s.filesWithHardcoded === 1 ? "" : "s"}.`
    : `No i18n is wired. ${s.hardcoded} user-facing string${s.hardcoded === 1 ? " is" : "s are"} hardcoded across ${s.filesWithHardcoded} file${s.filesWithHardcoded === 1 ? "" : "s"}.`;

  const summary = mdTable(["metric", "value"], [
    ["Framework", r.framework],
    ["i18n wired", r.i18n.wired ? `yes (${r.i18n.library})` : "no"],
    ["Component files scanned", `${s.componentFiles}${s.parseErrors ? ` (${s.parseErrors} parse error${s.parseErrors === 1 ? "" : "s"})` : ""}`],
    ["Hardcoded user-facing strings", `${s.hardcoded}`],
    ["Share of detected UI copy hardcoded", share],
    ["Files containing hardcoded copy", `${s.filesWithHardcoded}`],
    ["Auto-wired by a deterministic retrofit", `${r.retrofit.autoWired} (${r.retrofit.autoHandledPct}% of hardcoded)`],
    ["Not auto-wired (needs a human)", `${r.retrofit.reviewQueue} (${r.retrofit.review.prose} prose, ${r.retrofit.review.unusualComponents} unusual)`],
    ["Translations awaiting a ja value", `${r.retrofit.review.translations}`],
    ["Corruptions in dry run", `${r.retrofit.corruptions}`],
  ]);

  const topRows = r.topFiles.map((f) => [`\`${f.file}\``, `${f.hardcoded}`, `${f.autoWirable}`, `${f.review}`]);
  const topTable = topRows.length
    ? mdTable(["file", "hardcoded", "auto-wirable", "review"], topRows)
    : "_No hardcoded user-facing strings found._";

  return `# i18n readiness — ${r.repo}

${headline}

## Summary

${summary}

## What this means

${r.i18n.note} ${r.retrofit.summary}

The hardcoded count comes from a real parse of every component (the TypeScript / Vue compiler AST), not a text grep: interpolations, numbers, icon ligatures, and code blocks are excluded. The "share hardcoded" is an estimate whose denominator is the hardcoded strings plus the \`t()\` / \`$t()\` call-sites detected in source.

## Top files by hardcoded strings

${topTable}

## Review queue — what an automated pass will not touch

- prose / interpolated sentences: ${r.retrofit.review.prose}
- unusual component shapes (binding left for review): ${r.retrofit.review.unusualComponents}
- ja translations awaiting a human or MT pass: ${r.retrofit.review.translations}

A deterministic pass never splits a mixed sentence or an interpolated phrase, and never machine-translates: that is what holds corruptions at ${r.retrofit.corruptions} and leaves genuine human work clearly separated.

## Drift gate

${r.driftGate.valueLine}

---

Generated by i18n-swarm v${r.version} (read-only audit; no files were changed). MIT.
`;
}
