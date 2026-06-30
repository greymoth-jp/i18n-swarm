import fs from "node:fs";
import type { Candidate } from "./types.ts";

export interface FileRewrite {
  file: string;
  edits: number;
  skipped: number;
  applied: boolean;
}

/** Build the replacement text for one HIGH candidate. */
function replacement(c: Candidate): string {
  const call = `$t('${c.key}')`;
  if (c.kind === "text") return `{{ ${call} }}`;
  // attribute -> bound attribute
  return `:${c.attrName}="${call}"`;
}

/**
 * Rewrite one SFC: replace each HIGH candidate's source span with a $t() call,
 * applied end->start so earlier offsets stay valid. Every edit is re-checked against
 * the live source slice; a mismatch is skipped rather than risk corrupting the file.
 */
export function rewriteFile(file: string, source: string, candidates: Candidate[], write: boolean): { out: string; result: FileRewrite } {
  const highs = candidates
    .filter((c) => c.file === file && c.cls === "HIGH" && c.key)
    .sort((a, b) => b.start - a.start);
  let out = source;
  let edits = 0;
  let skipped = 0;
  for (const c of highs) {
    if (out.slice(c.start, c.end) !== c.raw) { skipped++; continue; }
    out = out.slice(0, c.start) + replacement(c) + out.slice(c.end);
    edits++;
  }
  const applied = write && edits > 0;
  if (applied) fs.writeFileSync(file, out, "utf8");
  return { out, result: { file, edits, skipped, applied } };
}
