// `check` mode: the recurring drift-gate.
//
// The retrofit (`run`) is a one-time migration; `check` is what a team puts in CI to
// keep the codebase localized over time. It answers one question on a diff:
//   "Did this change add a NEW hardcoded user-facing UI string that is not keyed?"
// If so it FAILS (non-zero exit) and offers the keyed fix as a suggested diff, scoped
// to the new strings only. It reuses the exact same extract + classify-core + rewire
// engine as the retrofit, so the gate and the migration agree on what counts as a
// user-facing string. Nothing new is classified here.
//
// Design choice that controls the false-positive rate (the killer metric): the gate
// FAILS only on HIGH candidates (clean sole-child UI text / user-facing attributes —
// the same set that is safe to auto-rewire). AMBIGUOUS strings (mixed sentences,
// component props, enum-ish expression literals) are surfaced as a non-failing review
// note, never a hard failure. A gate that fails on ambiguous cases gets disabled.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractFile } from "./extract.ts";
import { extractJsxFile } from "./extract-jsx.ts";
import { assignKeys } from "./keys.ts";
import { rewriteFile } from "./rewire.ts";
import { rewriteJsxFile } from "./rewire-jsx.ts";
import { classifySuppression, loadSuppressConfig, defaultConfig, type SuppressBucket, type SuppressConfig } from "./suppress.ts";
import type { Candidate, ExtractReport } from "./types.ts";

const UI_EXTS = [".vue", ".tsx", ".jsx"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "e2e", "playwright-report",
  "coverage", ".next", "out", "build", "storybook-static",
]);
// Files whose strings are not production user-facing copy: declarations, tests, stories.
const NON_UI_FILE = /\.(d\.ts|test\.[jt]sx?|spec\.[jt]sx?|stories\.[jt]sx?)$/;

export interface CheckFlag {
  file: string; // repo-relative posix path
  line: number; // 1-based line in the head version
  kind: "text" | "attr";
  attrName?: string;
  tag: string;
  text: string;
  key: string;
}

export interface SuppressedFlag {
  line: number;
  text: string;
  kind: "text" | "attr";
  bucket: SuppressBucket; // why it was demoted from a hard failure
  detail: string;
}

export interface FileCheck {
  file: string;
  flags: CheckFlag[]; // newly-added HIGH (un-keyed user-facing) strings -> failures
  newAmbiguous: { line: number; text: string; reason: string }[]; // soft review notes
  suppressed: SuppressedFlag[]; // HIGH flags demoted to soft notes by the FP-suppression layer
  suggestedDiff: string; // unified diff applying the keyed fix to the surviving (failing) strings only
  parseError: string | null;
}

export interface CheckResult {
  repoRoot: string;
  base: string;
  head: string; // "<worktree>" when comparing against the working tree
  filesScanned: number;
  files: FileCheck[];
  totalFlags: number; // hard failures (after suppression)
  totalSuppressed: number; // demoted to soft notes
  suppressedByBucket: Record<SuppressBucket, number>;
  pass: boolean;
}

export interface CheckOpts {
  repo?: string; // repo dir (default cwd)
  range?: string; // "A..B" | "A" (A vs worktree) | undefined (HEAD vs worktree)
  files?: string[]; // explicit file list; whole file treated as added (skips git)
  noSuppress?: boolean; // disable the FP-suppression layer (raw classifier output; for measurement)
  config?: SuppressConfig; // pre-built suppression config (else loaded from the repo root)
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitRoot(dir: string): string {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return path.resolve(dir);
  }
}

/** Parse "A..B" -> {base:A, head:B}; "A" -> {base:A, head:null}; "" -> {base:HEAD, head:null}. */
function parseRange(range: string | undefined): { base: string; head: string | null } {
  if (!range) return { base: "HEAD", head: null };
  const m = range.split("..");
  if (m.length === 2 && m[1] !== "") return { base: m[0] || "HEAD", head: m[1] };
  return { base: m[0] || "HEAD", head: null };
}

function isUiFile(rel: string): boolean {
  if (!UI_EXTS.some((e) => rel.endsWith(e))) return false;
  if (NON_UI_FILE.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  return true;
}

function diffNameOnly(root: string, base: string, head: string | null): string[] {
  const args = head
    ? ["diff", "--name-only", "--diff-filter=ACMR", base, head]
    : ["diff", "--name-only", "--diff-filter=ACMR", base];
  const tracked = git(root, args).split("\n").map((s) => s.trim()).filter(Boolean);
  if (head) return tracked;
  // worktree mode: also include brand-new untracked files (a dev-time pre-commit catch)
  let untracked: string[] = [];
  try {
    untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* none */ }
  return [...new Set([...tracked, ...untracked])];
}

/** Line numbers (1-based, in the head/new version) that this change ADDED. */
function addedLines(root: string, base: string, head: string | null, rel: string): Set<number> {
  const args = head
    ? ["diff", "--unified=0", base, head, "--", rel]
    : ["diff", "--unified=0", base, "--", rel];
  let out: string;
  try { out = git(root, args); } catch { return new Set(); }
  const added = new Set<number>();
  let newLine = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { newLine = parseInt(h[1], 10); continue; }
    if (line.startsWith("+")) { added.add(newLine); newLine++; }
    else if (line.startsWith("-")) { /* removed: no new-side advance */ }
    else if (line.startsWith("\\")) { /* "No newline at end of file" */ }
    else { newLine++; } // context
  }
  return added;
}

/** Content of the file in the head version (blob at ref, or the working tree). */
function headContent(root: string, head: string | null, rel: string): string | null {
  try {
    if (head) return git(root, ["show", `${head}:${rel}`]);
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function lineOf(source: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") n++;
  return n;
}

function extractFor(rel: string, source: string): ExtractReport {
  return rel.endsWith(".vue") ? extractFile(rel, source) : extractJsxFile(rel, source);
}

/** Minimal LCS-based unified diff (sufficient + deterministic for small component files). */
export function unifiedDiff(a: string, b: string, rel: string, ctx = 3): string {
  if (a === b) return "";
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  // LCS length table
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  type Op = { t: "=" | "-" | "+"; a: number; b: number };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: "=", a: i, b: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", a: i, b: j }); i++; }
    else { ops.push({ t: "+", a: i, b: j }); j++; }
  }
  while (i < n) { ops.push({ t: "-", a: i, b: j }); i++; }
  while (j < m) { ops.push({ t: "+", a: i, b: j }); j++; }
  // group changed ops into hunks with `ctx` lines of surrounding equal context
  const changedIdx = ops.map((o, k) => (o.t === "=" ? -1 : k)).filter((k) => k >= 0);
  if (changedIdx.length === 0) return "";
  const hunks: { lo: number; hi: number }[] = [];
  for (const k of changedIdx) {
    const lo = Math.max(0, k - ctx), hi = Math.min(ops.length - 1, k + ctx);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else hunks.push({ lo, hi });
  }
  const lines: string[] = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const { lo, hi } of hunks) {
    let aStart = 0, bStart = 0, aCount = 0, bCount = 0;
    let firstA = -1, firstB = -1;
    const body: string[] = [];
    for (let k = lo; k <= hi; k++) {
      const o = ops[k];
      if (o.t === "=") { if (firstA < 0) { firstA = o.a; firstB = o.b; } aCount++; bCount++; body.push(" " + A[o.a]); }
      else if (o.t === "-") { if (firstA < 0) firstA = o.a; if (firstB < 0) firstB = o.b; aCount++; body.push("-" + A[o.a]); }
      else { if (firstA < 0) firstA = o.a; if (firstB < 0) firstB = o.b; bCount++; body.push("+" + B[o.b]); }
    }
    aStart = firstA + 1; bStart = firstB + 1;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    lines.push(...body);
  }
  return lines.join("\n") + "\n";
}

/** Run the keyed-fix rewrite scoped to exactly the flagged (newly-added) HIGH candidates. */
function suggestFix(rel: string, source: string, flaggedHigh: Candidate[]): string {
  if (flaggedHigh.length === 0) return "";
  const { out } = rel.endsWith(".vue")
    ? rewriteFile(rel, source, flaggedHigh, false)
    : rewriteJsxFile(rel, source, flaggedHigh, false);
  return unifiedDiff(source, out, rel);
}

export function runCheck(opts: CheckOpts): CheckResult {
  const repoDir = path.resolve(opts.repo ?? ".");
  const root = gitRoot(repoDir);
  const { base, head } = parseRange(opts.range);
  const cfg = opts.noSuppress ? defaultConfig() : (opts.config ?? loadSuppressConfig(root));

  let rels: string[];
  let wholeFileAdded = false;
  if (opts.files && opts.files.length) {
    rels = opts.files.map((f) => path.relative(root, path.resolve(repoDir, f)).split(path.sep).join("/"));
    wholeFileAdded = true; // no diff: treat the entire file as new
  } else {
    rels = diffNameOnly(root, base, head);
  }
  rels = rels.filter(isUiFile);

  const files: FileCheck[] = [];
  const suppressedByBucket: Record<SuppressBucket, number> = { brand: 0, decorative: 0, codeish: 0, devpath: 0, directive: 0 };
  for (const rel of rels) {
    const source = wholeFileAdded ? headContent(root, null, rel) : headContent(root, head, rel);
    if (source == null) continue;
    const added = wholeFileAdded ? null : addedLines(root, base, head, rel);

    const rep = extractFor(rel, source);
    assignKeys(rep.candidates); // stable, per-file deduped keys (same as the retrofit)

    const onNewLine = (c: Candidate) => added === null || added.has(lineOf(source, c.start));
    const highOnNewLine = rep.candidates.filter((c) => c.cls === "HIGH" && c.key && onNewLine(c));

    // Split the classifier's HIGH set into hard failures (survive suppression) and soft
    // notes (a brand / code token / decorative / dev-only / directive-ignored string).
    const failing: Candidate[] = [];
    const suppressed: SuppressedFlag[] = [];
    for (const c of highOnNewLine) {
      const s = opts.noSuppress ? { suppressed: false, bucket: null, detail: "" } : classifySuppression(c, rel, source, cfg);
      if (s.suppressed && s.bucket) {
        suppressed.push({ line: lineOf(source, c.start), text: c.text, kind: c.kind, bucket: s.bucket, detail: s.detail });
        suppressedByBucket[s.bucket]++;
      } else {
        failing.push(c);
      }
    }

    const flags: CheckFlag[] = failing.map((c) => ({
      file: rel, line: lineOf(source, c.start), kind: c.kind, attrName: c.attrName,
      tag: c.tag, text: c.text, key: c.key!,
    }));
    const newAmbiguous = rep.candidates
      .filter((c) => c.cls === "AMBIGUOUS" && onNewLine(c))
      .map((c) => ({ line: lineOf(source, c.start), text: c.text, reason: c.reason }));

    if (flags.length === 0 && newAmbiguous.length === 0 && suppressed.length === 0) continue;
    files.push({
      file: rel, flags, newAmbiguous, suppressed,
      suggestedDiff: suggestFix(rel, source, failing), // fix only the surviving (failing) strings
      parseError: rep.parseError,
    });
  }

  const totalFlags = files.reduce((s, f) => s + f.flags.length, 0);
  const totalSuppressed = files.reduce((s, f) => s + f.suppressed.length, 0);
  return { repoRoot: root, base, head: head ?? "<worktree>", filesScanned: rels.length, files, totalFlags, totalSuppressed, suppressedByBucket, pass: totalFlags === 0 };
}
