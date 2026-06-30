// Programmatic entry point. The CLI (dist/cli.js, the `i18n-swarm` bin) is the
// primary surface; these exports let the same pipeline be driven from code.

export { detectRepo } from "./detect.ts";
export type { Framework, RepoInfo } from "./detect.ts";

export { analyze, applyChanges, outDir, writeArtifact } from "./pipeline.ts";
export type { Metrics, ExtractOutput, RunResult } from "./pipeline.ts";

export { analyzeJsx, applyJsx } from "./react-pipeline.ts";
export type { JsxMetrics, JsxOutput } from "./react-pipeline.ts";

export { takeSnapshot } from "./snapshot.ts";
export type { Snapshot } from "./snapshot.ts";

export { decideVerdict } from "./verdict.ts";
export type { Verdict, Confidence, VerifyDecision } from "./verdict.ts";

export { runCheck, unifiedDiff } from "./check.ts";
export type { CheckResult, FileCheck, CheckFlag, CheckOpts, SuppressedFlag } from "./check.ts";

export { classifySuppression, loadSuppressConfig, makeConfig, defaultConfig } from "./suppress.ts";
export type { SuppressConfig, SuppressBucket, SuppressResult } from "./suppress.ts";

export { auditRepo, auditMarkdown, buildAuditReport, topHardcodedFiles, countLocalizedCallsites } from "./audit.ts";
export type { AuditReport, FileHardcode } from "./audit.ts";

export type { Candidate, Klass, ExtractReport, PhaseResult } from "./types.ts";
