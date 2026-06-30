import type { Snapshot } from "./snapshot.ts";

export type Verdict = "AUTO-VERIFIED" | "FAILED" | "NEEDS-HUMAN";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface VerifyDecision {
  verdict: Verdict;
  confidence: Confidence;
  /** Did the code-side i18n (extract+wire+rewire) survive build+tests with no regression? */
  codeSideTrustWithoutReview: boolean;
  reasons: string[];
}

function fail(reasons: string[]): VerifyDecision {
  return { verdict: "FAILED", confidence: "HIGH", codeSideTrustWithoutReview: false, reasons };
}

/**
 * The killer decision for code-side i18n: after the agent rewired the components and
 * wired vue-i18n, does the app still build and do its tests stay green? The verify gate
 * (build compile + non-regressing tests) is the trust mechanism. Translation quality is
 * judged separately and is never auto-trusted here.
 */
export function decideVerdict(
  baseline: Snapshot,
  after: Snapshot,
  rewriteEdits: number,
  rewriteSkipped: number,
): VerifyDecision {
  const reasons: string[] = [];
  if (rewriteEdits === 0) {
    reasons.push("no strings were auto-rewired -> nothing localized to verify");
    return { verdict: "NEEDS-HUMAN", confidence: "LOW", codeSideTrustWithoutReview: false, reasons };
  }
  if (rewriteSkipped > 0) reasons.push(`${rewriteSkipped} HIGH node(s) skipped on offset mismatch (left as English)`);

  const baselineBuildGreen = baseline.build.ran && baseline.build.ok;
  const baselineHasTests = baseline.test.ran && baseline.test.stats.parsed && baseline.test.stats.total > 0;
  const baselineTestsGreen = baselineHasTests && baseline.test.ok;

  // 1. Did the rewrite break a previously-green build? (template compile regression)
  if (baselineBuildGreen && after.build.ran && !after.build.ok) {
    reasons.push("post-rewrite build FAILED (was green at baseline): " + after.build.note);
    return fail(reasons);
  }
  // 2. Did the rewrite break previously-green tests?
  if (baselineTestsGreen && after.test.ran) {
    if (!after.test.ok) { reasons.push("post-rewrite tests FAILED: " + after.test.note); return fail(reasons); }
    if (after.test.stats.failed > 0) { reasons.push(`post-rewrite shows ${after.test.stats.failed} failing test(s)`); return fail(reasons); }
    if (after.test.stats.passed < baseline.test.stats.passed) {
      reasons.push(`passing tests dropped ${baseline.test.stats.passed} -> ${after.test.stats.passed}`);
      return fail(reasons);
    }
  }

  // 3. Clean. Grade by how strong the surviving signal is.
  const buildGreen = after.build.ran && after.build.ok;
  const testsGreen = baselineTestsGreen && after.test.ran && after.test.ok && after.test.stats.failed === 0;
  if (after.typecheck.ran) reasons.push(`type-check (advisory): ${after.typecheck.ok ? "ok" : "errors - " + after.typecheck.note}`);

  if (buildGreen && testsGreen) {
    reasons.push(`build compiles all components; tests ${after.test.stats.passed}/${after.test.stats.total} green (>= baseline ${baseline.test.stats.passed})`);
    reasons.push("note: green tests prove no regression in COVERED components; rewired components without tests are validated by compile only");
    return { verdict: "AUTO-VERIFIED", confidence: "HIGH", codeSideTrustWithoutReview: true, reasons };
  }
  if (buildGreen && !baselineHasTests) {
    reasons.push("build compiles all components, but project has no unit tests -> behavior change cannot be auto-proven");
    return { verdict: "AUTO-VERIFIED", confidence: "MEDIUM", codeSideTrustWithoutReview: false, reasons };
  }
  if (buildGreen) {
    reasons.push("build green; test signal weak (no green baseline) -> compile-only verification");
    return { verdict: "AUTO-VERIFIED", confidence: "MEDIUM", codeSideTrustWithoutReview: false, reasons };
  }
  reasons.push("no green build signal after rewrite -> cannot auto-verify");
  return { verdict: "NEEDS-HUMAN", confidence: "LOW", codeSideTrustWithoutReview: false, reasons };
}
