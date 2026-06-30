import fs from "node:fs";
import path from "node:path";
import { detectRepo, type RepoInfo } from "./detect.ts";
import { extractFile } from "./extract.ts";
import { assignKeys } from "./keys.ts";
import { buildLocales, buildReview, type Locales, type ReviewItem } from "./catalog.ts";
import { rewriteFile, type FileRewrite } from "./rewire.ts";
import { scaffold } from "./scaffold.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";
import { decideVerdict, type VerifyDecision } from "./verdict.ts";
import type { Candidate } from "./types.ts";

export interface Metrics {
  sfcFiles: number;
  parseErrors: number;
  candidates: number;
  high: number;
  ambiguous: number;
  skip: number;
  localizable: number; // high + ambiguous
  autoHandledPct: number; // high / localizable
  uniqueKeys: number;
  rewriteEdits: number;
  rewriteSkipped: number;
  componentsRewired: number;
  skipByReason: Record<string, number>;
}

export interface ExtractOutput {
  repo: RepoInfo;
  candidates: Candidate[];
  locales: Locales;
  review: ReviewItem[];
  metrics: Metrics;
}

/** Steps 1-4: detect + extract + classify + key + build catalog. Pure (no writes). */
export function analyze(dir: string): ExtractOutput {
  const repo = detectRepo(dir);
  const candidates: Candidate[] = [];
  let parseErrors = 0;
  for (const f of repo.sfcFiles) {
    const rep = extractFile(f, fs.readFileSync(f, "utf8"));
    if (rep.parseError) parseErrors++;
    candidates.push(...rep.candidates);
  }
  assignKeys(candidates);
  const locales = buildLocales(candidates);
  const review = buildReview(candidates);
  const high = candidates.filter((c) => c.cls === "HIGH").length;
  const ambiguous = candidates.filter((c) => c.cls === "AMBIGUOUS").length;
  const skip = candidates.filter((c) => c.cls === "SKIP").length;
  const localizable = high + ambiguous;
  const skipByReason: Record<string, number> = {};
  for (const c of candidates) if (c.cls === "SKIP") skipByReason[c.reason] = (skipByReason[c.reason] ?? 0) + 1;
  const metrics: Metrics = {
    sfcFiles: repo.sfcFiles.length,
    parseErrors,
    candidates: candidates.length,
    high, ambiguous, skip,
    localizable,
    autoHandledPct: localizable ? Math.round((high / localizable) * 1000) / 10 : 0,
    uniqueKeys: Object.keys(locales.en).length,
    rewriteEdits: 0,
    rewriteSkipped: 0,
    componentsRewired: 0,
    skipByReason,
  };
  return { repo, candidates, locales, review, metrics };
}

/** Step 5+6: rewire components + scaffold the framework (writes to the repo). */
export function applyChanges(out: ExtractOutput): { rewrites: FileRewrite[]; scaffoldSteps: string[]; scaffoldWarnings: string[] } {
  const rewrites: FileRewrite[] = [];
  for (const f of out.repo.sfcFiles) {
    const src = fs.readFileSync(f, "utf8");
    const { result } = rewriteFile(f, src, out.candidates, true);
    if (result.edits > 0 || result.skipped > 0) rewrites.push(result);
  }
  out.metrics.rewriteEdits = rewrites.reduce((a, r) => a + r.edits, 0);
  out.metrics.rewriteSkipped = rewrites.reduce((a, r) => a + r.skipped, 0);
  out.metrics.componentsRewired = rewrites.filter((r) => r.edits > 0).length;
  const sc = scaffold(out.repo.dir, out.repo.srcDir, out.locales, true);
  return { rewrites, scaffoldSteps: sc.steps, scaffoldWarnings: sc.warnings };
}

export interface RunResult {
  extract: ExtractOutput;
  baseline: Snapshot;
  after: Snapshot;
  decision: VerifyDecision;
}

export function outDir(dir: string): string {
  const d = path.join(dir, ".i18nswarm");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function writeArtifact(dir: string, name: string, data: unknown): void {
  fs.writeFileSync(path.join(outDir(dir), name), JSON.stringify(data, null, 2), "utf8");
}
