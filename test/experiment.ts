// Read-only generalization harness: run the full classify -> key -> rewrite -> binding
// pipeline against real cloned apps and report per-app metrics. Corruption is measured
// by re-parsing every rewritten file (Vue via @vue/compiler-sfc, JSX via the TS parser)
// and counting files whose edit introduced a NEW parse error. No app is mutated.
import fs from "node:fs";
import path from "node:path";
import { parse as parseVue } from "@vue/compiler-sfc";
import { detectRepo } from "../src/detect.ts";
import { extractFile } from "../src/extract.ts";
import { assignKeys } from "../src/keys.ts";
import { buildReview } from "../src/catalog.ts";
import { rewriteFile } from "../src/rewire.ts";
import { analyzeJsx, applyJsx } from "../src/react-pipeline.ts";
import type { Candidate } from "../src/types.ts";

function vueTemplateErrors(src: string): number {
  try { return parseVue(src).errors.length; } catch { return 1; }
}

function runVue(dir: string) {
  const repo = detectRepo(dir);
  const candidates: Candidate[] = [];
  let parseErrors = 0;
  const srcs = new Map<string, string>();
  for (const f of repo.sfcFiles) {
    const s = fs.readFileSync(f, "utf8"); srcs.set(f, s);
    const rep = extractFile(f, s);
    if (rep.parseError) parseErrors++;
    candidates.push(...rep.candidates);
  }
  assignKeys(candidates);
  const high = candidates.filter((c) => c.cls === "HIGH").length;
  const amb = candidates.filter((c) => c.cls === "AMBIGUOUS").length;
  const skip = candidates.filter((c) => c.cls === "SKIP").length;
  let edits = 0, corruptions = 0, filesTouched = 0;
  for (const f of repo.sfcFiles) {
    const s = srcs.get(f)!;
    const { out, result } = rewriteFile(f, s, candidates, false);
    if (result.edits === 0) continue;
    filesTouched++;
    edits += result.edits;
    if (vueTemplateErrors(out) > vueTemplateErrors(s)) corruptions++;
  }
  const loc = high + amb;
  return {
    name: repo.name, fw: repo.framework, files: repo.sfcFiles.length, parseErrors,
    high, amb, skip, autoPct: loc ? Math.round((high / loc) * 1000) / 10 : 0,
    effPct: loc ? Math.round((high / loc) * 1000) / 10 : 0,
    corruptions, filesTouched, review: amb,
    bindingNote: "n/a (vue $t is global)",
  };
}

function runJsx(dir: string) {
  const out = analyzeJsx(dir);
  applyJsx(out, false); // dry: fills rewriteEdits/corruptions via reparse, writes nothing
  const m = out.metrics;
  return {
    name: out.repo.name, fw: out.repo.framework, files: m.files, parseErrors: m.parseErrors,
    high: m.high, amb: m.ambiguous, skip: m.skip, autoPct: m.autoHandledPct,
    effPct: m.effectiveAppliedPct, corruptions: m.corruptions, filesTouched: m.bindingSafeFiles,
    review: m.ambiguous + m.highBindingBlocked,
    bindingNote: `client=${m.clientFiles} server=${m.serverFiles} safe=${m.bindingSafeFiles} blocked=${m.bindingBlockedFiles} (blockedStrings=${m.highBindingBlocked})`,
  };
}

const dirs = process.argv.slice(2);
const rows: ReturnType<typeof runJsx>[] = [];
for (const d of dirs) {
  const dir = path.resolve(d);
  try {
    const repo = detectRepo(dir);
    if (repo.hasI18n) { console.log(`\n[${repo.name}] ABORT: already localized (${repo.i18nDep}) -> tool refuses, correct`); continue; }
    const r = repo.framework === "vue" ? runVue(dir) : runJsx(dir);
    rows.push(r);
    console.log(`\n[${r.name}] fw=${r.fw} files=${r.files} (parseErr ${r.parseErrors})`);
    console.log(`  HIGH=${r.high} AMBIG=${r.amb} SKIP=${r.skip}  auto-handled=${r.autoPct}%  effective-applied=${r.effPct}%`);
    console.log(`  corruptions=${r.corruptions}  files-rewired=${r.filesTouched}  review-queue=${r.review}`);
    console.log(`  binding: ${r.bindingNote}`);
  } catch (e) {
    console.log(`\n[${path.basename(dir)}] ERROR ${(e as Error).message}`);
  }
}

// summary
if (rows.length) {
  const totC = rows.reduce((a, r) => a + r.corruptions, 0);
  console.log(`\n==== SUMMARY: ${rows.length} apps | total corruptions=${totC} | auto-handled ${Math.min(...rows.map((r) => r.autoPct))}-${Math.max(...rows.map((r) => r.autoPct))}% ====`);
}
