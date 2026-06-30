#!/usr/bin/env node
import path from "node:path";
import { detectRepo } from "./detect.ts";
import { analyze, applyChanges, writeArtifact, outDir, type ExtractOutput } from "./pipeline.ts";
import { analyzeJsx, applyJsx, type JsxOutput } from "./react-pipeline.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";
import { decideVerdict, type VerifyDecision } from "./verdict.ts";
import {
  buildReviewQueue, verdictCardSvg, reportHtml, summaryLine, type ProductSummary,
} from "./report.ts";
import fs from "node:fs";

function log(...a: unknown[]) { process.stdout.write(Buffer.from(a.join(" ") + "\n", "utf8")); }
function hr() { log("-".repeat(68)); }

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, boolean | string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function printMetrics(out: ExtractOutput) {
  const m = out.metrics;
  log(`  SFC files:        ${m.sfcFiles}  (parse errors: ${m.parseErrors})`);
  log(`  candidates:       ${m.candidates}`);
  log(`    HIGH (auto):    ${m.high}`);
  log(`    AMBIGUOUS:      ${m.ambiguous}  (flagged for human review, NOT rewired)`);
  log(`    SKIP:           ${m.skip}`);
  log(`  localizable:      ${m.localizable}  (HIGH + AMBIGUOUS)`);
  log(`  auto-handled:     ${m.autoHandledPct}%  (HIGH / localizable)`);
  log(`  unique keys (en): ${m.uniqueKeys}`);
  log(`  SKIP breakdown:`);
  for (const [r, n] of Object.entries(m.skipByReason).sort((a, b) => b[1] - a[1])) log(`     ${String(n).padStart(3)}  ${r}`);
}

function printSnapshot(s: Snapshot) {
  const ph = (p: { ran: boolean; ok: boolean; durationMs: number; note: string }) =>
    p.ran ? `${p.ok ? "OK  " : "FAIL"} (${(p.durationMs / 1000) | 0}s) ${p.ok ? "" : "- " + p.note}` : `n/a - ${p.note}`;
  log(`  install:   ${ph(s.install)}`);
  log(`  build:     ${ph(s.build)}`);
  log(`  typecheck: ${ph(s.typecheck)}`);
  log(`  test:      ${ph(s.test)} [${s.test.stats.runner} ${s.test.stats.passed}/${s.test.stats.total} pass, ${s.test.stats.failed} fail]`);
}

async function cmdDetect(dir: string) {
  const r = detectRepo(dir);
  hr(); log(`DETECT: ${r.name}`); hr();
  log(`  dir:        ${r.dir}`);
  log(`  framework:  ${r.framework}`);
  log(`  srcDir:     ${r.srcDir}`);
  log(`  SFC files:  ${r.sfcFiles.length}`);
  log(`  i18n:       ${r.hasI18n ? "ALREADY localized (" + r.i18nDep + ")" : "none (target is English-only)"}`);
  log(`  scripts:    build=${r.buildScript}  typecheck=${r.typecheckScript}  test=${r.testScript}`);
}

function printJsxMetrics(out: JsxOutput) {
  const m = out.metrics;
  log(`  files:            ${m.files}  (parse errors: ${m.parseErrors})`);
  log(`  candidates:       ${m.candidates}`);
  log(`    HIGH (auto):    ${m.high}`);
  log(`    AMBIGUOUS:      ${m.ambiguous}  (review, not rewired)`);
  log(`    SKIP:           ${m.skip}`);
  log(`  auto-handled:     ${m.autoHandledPct}%  (HIGH / localizable, classifier-level)`);
  log(`  effective-applied:${m.effectiveAppliedPct}%  (HIGH actually rewired / localizable)`);
  log(`  components:       client=${m.clientFiles} server=${m.serverFiles}`);
  log(`  binding:          safe=${m.bindingSafeFiles} files, blocked=${m.bindingBlockedFiles} files (${m.highBindingBlocked} strings -> review)`);
  for (const [r, n] of Object.entries(m.bindingBlockReasons)) log(`     ${String(n).padStart(3)}  ${r}`);
}

function cmdExtractJsx(dir: string) {
  const out = analyzeJsx(dir);
  applyJsx(out, false);
  hr(); log(`EXTRACT (${out.repo.framework}): ${out.repo.name}`); hr();
  printJsxMetrics(out);
  log("  sample HIGH:");
  for (const c of out.candidates.filter((x) => x.cls === "HIGH").slice(0, 8)) log(`     ${c.key}  =  ${JSON.stringify(c.text)}`);
  writeArtifact(dir, "catalog.json", { metrics: out.metrics, en: out.locales.en });
  writeArtifact(dir, "review.json", out.review);
}

function cmdApplyJsx(dir: string) {
  const out = analyzeJsx(dir);
  hr(); log(`APPLY (${out.repo.framework}): ${out.repo.name}`); hr();
  const { filesChanged, scaffoldSteps, scaffoldWarnings } = applyJsx(out, true);
  log(`  files rewired: ${filesChanged}  (edits ${out.metrics.rewriteEdits}, skipped ${out.metrics.rewriteSkipped}, corruptions ${out.metrics.corruptions})`);
  for (const s of scaffoldSteps) log(`     + ${s}`);
  for (const w of scaffoldWarnings) log(`     ! ${w}`);
}

function cmdExtract(dir: string) {
  const out = analyze(dir);
  hr(); log(`EXTRACT: ${out.repo.name}`); hr();
  printMetrics(out);
  log("");
  log("  sample HIGH (auto-rewired):");
  for (const c of out.candidates.filter((x) => x.cls === "HIGH").slice(0, 8)) log(`     ${c.key}  =  ${JSON.stringify(c.text)}`);
  log("  sample AMBIGUOUS (review):");
  for (const c of out.candidates.filter((x) => x.cls === "AMBIGUOUS").slice(0, 6)) log(`     <${c.tag}> ${JSON.stringify(c.text.slice(0, 50))}  (${c.reason})`);
  writeArtifact(dir, "catalog.json", { metrics: out.metrics, en: out.locales.en, ja: out.locales.ja });
  writeArtifact(dir, "review.json", out.review);
  writeArtifact(dir, "candidates.json", out.candidates);
  log("");
  log(`  wrote .i18nswarm/catalog.json, review.json, candidates.json`);
}

function cmdApply(dir: string) {
  const out = analyze(dir);
  hr(); log(`APPLY: ${out.repo.name}`); hr();
  const { rewrites, scaffoldSteps, scaffoldWarnings } = applyChanges(out);
  log(`  components rewired: ${out.metrics.componentsRewired}  (edits: ${out.metrics.rewriteEdits}, skipped: ${out.metrics.rewriteSkipped})`);
  for (const r of rewrites) log(`     ${path.basename(r.file).padEnd(20)} edits=${r.edits} skipped=${r.skipped}`);
  log(`  scaffold:`);
  for (const s of scaffoldSteps) log(`     + ${s}`);
  for (const w of scaffoldWarnings) log(`     ! ${w}`);
}

async function cmdVerify(dir: string, noInstall: boolean) {
  const repo = detectRepo(dir);
  hr(); log(`VERIFY: ${repo.name}`); hr();
  const s = await takeSnapshot(repo, "verify", !noInstall);
  printSnapshot(s);
}

/** Render + write the product report (card SVG, zine HTML, review-queue JSON). */
function emitReport(
  dir: string, out: JsxOutput, baseline: Snapshot, after: Snapshot,
  decision: VerifyDecision, scaffoldWarnings: string[], filesChanged: number,
): void {
  const m = out.metrics;
  const queue = buildReviewQueue(out, scaffoldWarnings);
  const summary: ProductSummary = {
    repoName: out.repo.name,
    framework: out.repo.framework,
    autoCount: m.rewriteEdits,
    reviewCount: queue.counts.total,
    autoHandledPct: m.autoHandledPct,
    effectivePct: m.effectiveAppliedPct,
    uniqueKeys: m.uniqueKeys,
    filesRewired: filesChanged,
    corruptions: m.corruptions,
    buildGreen: after.build.ran && after.build.ok,
    verdict: decision.verdict,
    trust: decision.codeSideTrustWithoutReview,
  };
  const cardSvg = verdictCardSvg(summary);
  const html = reportHtml(summary, baseline, after, decision, queue, cardSvg);
  const od = outDir(dir);
  fs.writeFileSync(path.join(od, "card.svg"), cardSvg, "utf8");
  fs.writeFileSync(path.join(od, "report.html"), html, "utf8");
  writeArtifact(dir, "review-queue.json", queue);
  hr();
  log(`REPORT:  ${summaryLine(summary)}`);
  log(`         review queue: ${queue.counts.prose} prose, ${queue.counts.unusual} unusual-component, ${queue.counts.wiring} wiring, ${queue.counts.translations} translation`);
  log(`         wrote .i18nswarm/report.html  .i18nswarm/card.svg  .i18nswarm/review-queue.json`);
  hr();
}

async function cmdRunJsx(dir: string) {
  const repo0 = detectRepo(dir);
  if (repo0.hasI18n) { log(`ABORT: ${repo0.name} already has i18n (${repo0.i18nDep})`); return; }
  hr(); log(`BASELINE: ${repo0.name} (${repo0.framework}; install + build + test, pre-i18n)`); hr();
  const baseline = await takeSnapshot(repo0, "baseline", true);
  printSnapshot(baseline);

  hr(); log(`EXTRACT + CLASSIFY`); hr();
  const out = analyzeJsx(dir);
  applyJsx(out, false); // compute binding plan + corruption dry-run
  printJsxMetrics(out);

  hr(); log(`APPLY (rewire components + scaffold ${repo0.framework === "next" ? "next-intl" : "react-i18next"})`); hr();
  const { filesChanged, scaffoldSteps, scaffoldWarnings } = applyJsx(out, true);
  log(`  files rewired: ${filesChanged} (edits ${out.metrics.rewriteEdits}, skipped ${out.metrics.rewriteSkipped}, corruptions ${out.metrics.corruptions})`);
  for (const s of scaffoldSteps) log(`     + ${s}`);
  for (const w of scaffoldWarnings) log(`     ! ${w}`);

  hr(); log(`VERIFY (re-install + build + test, post-i18n)`); hr();
  const repo1 = detectRepo(dir);
  const after = await takeSnapshot(repo1, "verify", true);
  printSnapshot(after);
  const decision = decideVerdict(baseline, after, out.metrics.rewriteEdits, out.metrics.rewriteSkipped);
  hr();
  log(`VERDICT:    ${decision.verdict}  (confidence ${decision.confidence})`);
  log(`CODE-SIDE TRUST WITHOUT REVIEW: ${decision.codeSideTrustWithoutReview ? "YES" : "NO"}`);
  for (const r of decision.reasons) log(`   - ${r}`);
  log(`review queue: ${out.metrics.ambiguous} ambiguous + ${out.metrics.highBindingBlocked} binding-blocked + ${out.metrics.uniqueKeys} ja translations`);
  hr();
  writeArtifact(dir, "run.json", { metrics: out.metrics, baseline, after, decision });
  emitReport(dir, out, baseline, after, decision, scaffoldWarnings, filesChanged);
}

async function cmdRun(dir: string) {
  const repo0 = detectRepo(dir);
  if (repo0.hasI18n) { log(`ABORT: ${repo0.name} already has i18n (${repo0.i18nDep})`); return; }

  hr(); log(`BASELINE: ${repo0.name} (install + build + test, pre-i18n)`); hr();
  const baseline = await takeSnapshot(repo0, "baseline", true);
  printSnapshot(baseline);

  hr(); log(`EXTRACT + CLASSIFY`); hr();
  const out = analyze(dir);
  printMetrics(out);

  hr(); log(`APPLY (rewire components + wire vue-i18n)`); hr();
  const { rewrites, scaffoldSteps, scaffoldWarnings } = applyChanges(out);
  log(`  components rewired: ${out.metrics.componentsRewired} (edits ${out.metrics.rewriteEdits}, skipped ${out.metrics.rewriteSkipped})`);
  for (const r of rewrites) log(`     ${path.basename(r.file).padEnd(20)} edits=${r.edits} skipped=${r.skipped}`);
  for (const s of scaffoldSteps) log(`     + ${s}`);
  for (const w of scaffoldWarnings) log(`     ! ${w}`);

  hr(); log(`VERIFY (re-install + build + test, post-i18n)`); hr();
  const repo1 = detectRepo(dir); // re-detect: vue-i18n dep now present
  const after = await takeSnapshot(repo1, "verify", true);
  printSnapshot(after);

  const decision = decideVerdict(baseline, after, out.metrics.rewriteEdits, out.metrics.rewriteSkipped);
  hr();
  log(`VERDICT:    ${decision.verdict}`);
  log(`CONFIDENCE: ${decision.confidence}`);
  log(`CODE-SIDE TRUST WITHOUT REVIEW: ${decision.codeSideTrustWithoutReview ? "YES" : "NO"}`);
  log(`reasons:`);
  for (const r of decision.reasons) log(`   - ${r}`);
  log(`translation: ja seeded with English fallback for ${out.metrics.uniqueKeys} keys; quality NOT auto-trusted (human/MT + homograph review required)`);
  log(`human review queue: ${out.metrics.ambiguous} ambiguous string(s) + ${out.metrics.uniqueKeys} ja translations`);
  hr();
  writeArtifact(dir, "run.json", { metrics: out.metrics, baseline, after, decision });
}

const COMMANDS = new Set(["detect", "extract", "apply", "verify", "run", "help", "--help", "-h"]);

function usage() {
  log("i18n-swarm - autonomous code-side localization for English-only web apps (Next.js / Vue 3 / React)");
  log("");
  log("usage:");
  log("  npx i18n-swarm <dir>              full pass: scan -> scaffold -> rewrite -> verify -> report");
  log("  npx i18n-swarm run <dir>          (the same end-to-end pass, explicitly)");
  log("");
  log("per-step:");
  log("  detect  <dir>                     inspect framework / components / scripts / existing i18n");
  log("  extract <dir>                     classify UI strings, write the catalog (no app changes)");
  log("  apply   <dir>                     rewire components + scaffold the i18n runtime (mutates)");
  log("  verify  <dir> [--no-install]      install + build + test the current state");
  log("");
  log("the full pass writes .i18nswarm/report.html (zine report + verdict card), card.svg, and review-queue.json");
}

async function main() {
  const [, , first, ...restArgs] = process.argv;
  // bare `npx i18n-swarm <path>` (no subcommand) runs the full pass on <path>.
  const hasCmd = first !== undefined && COMMANDS.has(first);
  const sub = hasCmd ? first : (first === undefined ? undefined : "run");
  const rest = hasCmd ? restArgs : (first === undefined ? [] : [first, ...restArgs]);
  const { pos, flags } = parseArgs(rest);
  const dir = path.resolve(pos[0] ?? ".");
  try {
    const fw = (() => { try { return detectRepo(dir).framework; } catch { return "unknown"; } })();
    const isJsx = fw === "next" || fw === "react";
    switch (sub) {
      case "detect": await cmdDetect(dir); break;
      case "extract": isJsx ? cmdExtractJsx(dir) : cmdExtract(dir); break;
      case "apply": isJsx ? cmdApplyJsx(dir) : cmdApply(dir); break;
      case "verify": await cmdVerify(dir, !!flags["no-install"]); break;
      case "run": isJsx ? await cmdRunJsx(dir) : await cmdRun(dir); break;
      default: usage(); process.exitCode = 0;
    }
  } catch (e) {
    log("ERROR: " + (e as Error).message);
    process.exitCode = 1;
  }
}

void main();
