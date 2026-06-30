import fs from "node:fs";
import ts from "typescript";
import type { Candidate } from "./types.ts";
import type { FileRewrite } from "./rewire.ts";

/** Replacement text for one HIGH candidate in JSX. */
function replacement(c: Candidate): string {
  const call = `t('${c.key}')`;
  if (c.kind === "text") return `{${call}}`;
  return `${c.attrName}={${call}}`;
}

/**
 * Count syntactic + grammar errors in a JSX/TSX source (corruption oracle). NOTE:
 * createSourceFile().parseDiagnostics alone is NOT enough — grammar errors such as
 * TS1029 ("'export' modifier must precede 'async' modifier") are raised by the
 * transform, not the scanner, so a malformed `async export default function` parses
 * clean there. transpileModule runs that grammar pass, so it catches the class of
 * corruption an in-place edit can introduce. The authoritative gate is still the
 * project's real build + typecheck.
 */
export function jsxParseErrors(file: string, source: string): number {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parse = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  const t = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, isolatedModules: true },
  });
  // grammar/syntactic diagnostics live in code range 1000-1999
  const grammar = (t.diagnostics ?? []).filter((d) => d.code >= 1000 && d.code < 2000);
  return parse.length + grammar.length;
}

/**
 * Rewrite one JSX/TSX file: replace each HIGH candidate span with a t() call, applied
 * end->start. Every edit is re-checked against the live source slice; a mismatch is
 * skipped. After rewriting, the output is re-parsed: if the edit introduced a NEW
 * syntactic error the whole file is reverted (corruption guard), so a file is only
 * mutated when it still parses at least as cleanly as before.
 */
export function rewriteJsxFile(file: string, source: string, candidates: Candidate[], write: boolean): { out: string; result: FileRewrite & { corrupted: boolean } } {
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
  const before = jsxParseErrors(file, source);
  const after = jsxParseErrors(file, out);
  const corrupted = edits > 0 && after > before;
  if (corrupted) { out = source; edits = 0; } // never write a file we broke
  const applied = write && edits > 0;
  if (applied) fs.writeFileSync(file, out, "utf8");
  return { out, result: { file, edits, skipped, applied, corrupted } };
}
