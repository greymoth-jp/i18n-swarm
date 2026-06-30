import path from "node:path";
import { detectRepo } from "./detect.ts";
import { analyze, applyChanges, writeArtifact, type ExtractOutput } from "./pipeline.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";
import { decideVerdict } from "./verdict.ts";

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

async function cmdRun(dir: string) {
  const repo0 = detectRepo(dir);
  if (repo0.framework !== "vue") log(`WARNING: framework=${repo0.framework} (this PoC handles Vue SFCs)`);
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

async function main() {
  const [, , sub, ...rest] = process.argv;
  const { pos, flags } = parseArgs(rest);
  const dir = path.resolve(pos[0] ?? ".");
  try {
    switch (sub) {
      case "detect": await cmdDetect(dir); break;
      case "extract": cmdExtract(dir); break;
      case "apply": cmdApply(dir); break;
      case "verify": await cmdVerify(dir, !!flags["no-install"]); break;
      case "run": await cmdRun(dir); break;
      default:
        log("i18n-swarm - autonomous code-side localization for English-only Vue 3 apps");
        log("usage:");
        log("  detect  <dir>              inspect framework / SFCs / scripts / existing i18n");
        log("  extract <dir>              classify UI strings, write catalog (no app changes)");
        log("  apply   <dir>              rewire components + wire vue-i18n (mutates the app)");
        log("  verify  <dir> [--no-install]   install + build + test the current state");
        log("  run     <dir>              full experiment: baseline -> apply -> verify -> verdict");
        process.exitCode = sub ? 1 : 0;
    }
  } catch (e) {
    log("ERROR: " + (e as Error).message);
    process.exitCode = 1;
  }
}

void main();
