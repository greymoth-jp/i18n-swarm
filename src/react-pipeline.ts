import fs from "node:fs";
import { detectRepo, type RepoInfo } from "./detect.ts";
import { extractJsxFile, detectScope } from "./extract-jsx.ts";
import { assignKeys } from "./keys.ts";
import { buildLocales, buildReview, type Locales, type ReviewItem } from "./catalog.ts";
import { jsxParseErrors } from "./rewire-jsx.ts";
import { planBinding, type Edit, type Target } from "./binding.ts";
import { scaffoldNext } from "./scaffold-next.ts";
import { scaffoldReact } from "./scaffold-react.ts";
import type { Candidate } from "./types.ts";

const targetFor = (fw: string): Target => (fw === "next" ? "next-intl" : "react-i18next");

export interface JsxMetrics {
  files: number;
  parseErrors: number;
  candidates: number;
  high: number;
  ambiguous: number;
  skip: number;
  localizable: number;
  autoHandledPct: number; // HIGH / localizable (classifier-level)
  uniqueKeys: number;
  clientFiles: number;
  serverFiles: number;
  bindingSafeFiles: number; // files with HIGH that got a t binding
  bindingBlockedFiles: number; // files with HIGH that could NOT (left English -> review)
  highApplied: number; // HIGH strings actually rewired (in binding-safe files)
  highBindingBlocked: number; // HIGH strings deferred because binding unsafe
  effectiveAppliedPct: number; // highApplied / localizable (end-to-end auto-handled)
  rewriteEdits: number;
  rewriteSkipped: number;
  corruptions: number;
  skipByReason: Record<string, number>;
  bindingBlockReasons: Record<string, number>;
}

export interface JsxOutput {
  repo: RepoInfo;
  candidates: Candidate[];
  locales: Locales;
  review: ReviewItem[];
  metrics: JsxMetrics;
  /** per-file binding decision, for the review queue + apply stage */
  fileBinding: Map<string, { safe: boolean; reason: string; scope: string; edits: Edit[] }>;
}

function replacement(c: Candidate): string {
  return c.kind === "text" ? `{t('${c.key}')}` : `${c.attrName}={t('${c.key}')}`;
}

export function analyzeJsx(dir: string): JsxOutput {
  const repo = detectRepo(dir);
  const candidates: Candidate[] = [];
  let parseErrors = 0;
  const fileSources = new Map<string, string>();
  for (const f of repo.sfcFiles) {
    const src = fs.readFileSync(f, "utf8");
    fileSources.set(f, src);
    const rep = extractJsxFile(f, src);
    if (rep.parseError) parseErrors++;
    candidates.push(...rep.candidates);
  }
  assignKeys(candidates);
  const locales = buildLocales(candidates);
  const review = buildReview(candidates);

  // per-file binding plan (drives effective coverage + which files are review-only)
  const fileBinding = new Map<string, { safe: boolean; reason: string; scope: string; edits: Edit[] }>();
  const highByFile = new Map<string, Candidate[]>();
  for (const c of candidates) if (c.cls === "HIGH") (highByFile.get(c.file) ?? highByFile.set(c.file, []).get(c.file)!).push(c);

  let clientFiles = 0, serverFiles = 0, bindingSafeFiles = 0, bindingBlockedFiles = 0, highApplied = 0, highBindingBlocked = 0;
  const bindingBlockReasons: Record<string, number> = {};
  for (const f of repo.sfcFiles) {
    const src = fileSources.get(f)!;
    const scope = detectScope(src);
    if (scope === "client") clientFiles++; else serverFiles++;
    const highs = highByFile.get(f) ?? [];
    if (highs.length === 0) { fileBinding.set(f, { safe: true, reason: "no rewrites", scope, edits: [] }); continue; }
    const plan = planBinding(f, src, highs.map((c) => c.start), targetFor(repo.framework));
    fileBinding.set(f, { safe: plan.safe, reason: plan.reason, scope: plan.scope, edits: plan.edits });
    if (plan.safe) { bindingSafeFiles++; highApplied += highs.length; }
    else {
      bindingBlockedFiles++; highBindingBlocked += highs.length;
      bindingBlockReasons[plan.reason] = (bindingBlockReasons[plan.reason] ?? 0) + 1;
    }
  }

  const high = candidates.filter((c) => c.cls === "HIGH").length;
  const ambiguous = candidates.filter((c) => c.cls === "AMBIGUOUS").length;
  const skip = candidates.filter((c) => c.cls === "SKIP").length;
  const localizable = high + ambiguous;
  const skipByReason: Record<string, number> = {};
  for (const c of candidates) if (c.cls === "SKIP") skipByReason[c.reason] = (skipByReason[c.reason] ?? 0) + 1;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  const metrics: JsxMetrics = {
    files: repo.sfcFiles.length, parseErrors, candidates: candidates.length,
    high, ambiguous, skip, localizable,
    autoHandledPct: pct(high, localizable),
    uniqueKeys: Object.keys(locales.en).length,
    clientFiles, serverFiles, bindingSafeFiles, bindingBlockedFiles,
    highApplied, highBindingBlocked,
    effectiveAppliedPct: pct(highApplied, localizable),
    rewriteEdits: 0, rewriteSkipped: 0, corruptions: 0,
    skipByReason, bindingBlockReasons,
  };
  return { repo, candidates, locales, review, metrics, fileBinding };
}

/** Apply rewrites + binding edits per binding-safe file, with offset + reparse guards. */
export function applyJsx(out: JsxOutput, write: boolean): { filesChanged: number; scaffoldSteps: string[]; scaffoldWarnings: string[] } {
  let edits = 0, skipped = 0, corruptions = 0, filesChanged = 0;
  for (const f of out.repo.sfcFiles) {
    const plan = out.fileBinding.get(f)!;
    if (!plan.safe) continue; // binding-blocked: leave English, it is in the review queue
    const highs = out.candidates.filter((c) => c.file === f && c.cls === "HIGH" && c.key);
    if (highs.length === 0) continue;
    const src = fs.readFileSync(f, "utf8");

    // merge rewrite spans (verified) + binding insertions; apply end->start
    type E = { start: number; end: number; text: string; verify?: string };
    const all: E[] = [...plan.edits];
    let localSkip = 0;
    for (const c of highs) {
      if (src.slice(c.start, c.end) !== c.raw) { localSkip++; continue; }
      all.push({ start: c.start, end: c.end, text: replacement(c), verify: c.raw });
    }
    all.sort((a, b) => b.start - a.start || b.end - a.end);
    let result = src;
    let applied = 0;
    for (const e of all) {
      if (e.verify !== undefined && result.slice(e.start, e.end) !== e.verify) { localSkip++; continue; }
      result = result.slice(0, e.start) + e.text + result.slice(e.end);
      if (e.verify !== undefined) applied++;
    }
    const before = jsxParseErrors(f, src);
    const after = jsxParseErrors(f, result);
    if (applied > 0 && after > before) { corruptions++; skipped += highs.length; continue; } // never write a broken file
    edits += applied; skipped += localSkip;
    if (write && applied > 0) { fs.writeFileSync(f, result, "utf8"); filesChanged++; }
  }
  out.metrics.rewriteEdits = edits;
  out.metrics.rewriteSkipped = skipped;
  out.metrics.corruptions = corruptions;
  const sc = !write
    ? { steps: ["dry run"], warnings: [] }
    : out.repo.framework === "next"
      ? scaffoldNext(out.repo.dir, out.repo.srcDir, out.locales, true)
      : scaffoldReact(out.repo.dir, out.repo.srcDir, out.locales, true);
  return { filesChanged, scaffoldSteps: sc.steps, scaffoldWarnings: sc.warnings };
}
