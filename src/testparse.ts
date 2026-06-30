// Parse test-runner stdout/stderr into counts. The AUTHORITATIVE pass/fail is
// always the child process exit code; these counts feed the regression delta
// (did the number of passing tests drop / did new failures appear). Supports
// jest, mocha, vitest and karma — the runners the real Vue 2 targets use.

export interface TestStats {
  runner: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  parsed: boolean;
}

const EMPTY = (runner = "unknown"): TestStats => ({ runner, total: 0, passed: 0, failed: 0, skipped: 0, parsed: false });

function parseJest(out: string): TestStats | null {
  // Scope strictly to the "Tests:" summary line. The full jest output also has
  // "Test Suites: N passed" and "Snapshots: N passed", which would otherwise
  // clobber the real test count.
  const lineM = /Tests:\s*([^\n]*)/.exec(out);
  if (!lineM) return null;
  const line = lineM[1];
  const totalM = /(\d+)\s+total/.exec(line);
  if (!totalM) return null;
  const s = EMPTY("jest");
  s.total = +totalM[1];
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)/g)) {
    const n = +m[1];
    if (m[2] === "passed") s.passed = n;
    else if (m[2] === "failed") s.failed = n;
    else s.skipped += n;
  }
  s.parsed = true;
  return s;
}

function parseVitest(out: string): TestStats | null {
  // "Tests  47 passed | 1 failed (48)"
  const m = /Tests\s+(?:(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/.exec(out);
  if (!m) return null;
  const s = EMPTY("vitest");
  s.passed = +(m[1] ?? 0); s.failed = +(m[2] ?? 0); s.skipped = +(m[3] ?? 0); s.total = +(m[4] ?? 0);
  s.parsed = true;
  return s;
}

function parseMocha(out: string): TestStats | null {
  const pass = /(\d+)\s+passing/.exec(out);
  const fail = /(\d+)\s+failing/.exec(out);
  const pend = /(\d+)\s+pending/.exec(out);
  if (!pass && !fail) return null;
  const s = EMPTY("mocha");
  s.passed = +(pass?.[1] ?? 0); s.failed = +(fail?.[1] ?? 0); s.skipped = +(pend?.[1] ?? 0);
  s.total = s.passed + s.failed + s.skipped;
  s.parsed = true;
  return s;
}

function parseKarma(out: string): TestStats | null {
  // "Executed 42 of 42 SUCCESS" / "Executed 41 of 42 (1 FAILED)"
  const m = /Executed\s+(\d+)\s+of\s+(\d+)(?:\s+\((\d+)\s+FAILED\))?(?:\s+\((skipped\s+(\d+))\))?/.exec(out);
  if (!m) return null;
  const s = EMPTY("karma");
  const executed = +m[1];
  s.total = +m[2];
  s.failed = +(m[3] ?? 0);
  s.passed = executed - s.failed;
  s.skipped = s.total - executed;
  s.parsed = true;
  return s;
}

// Reporters emit ANSI color even with FORCE_COLOR=0 in some shells; strip it so
// the summary regexes (which rely on \s between label and counts) still match.
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g");
const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Try each runner; prefer the parse that yields a positive total. */
export function parseTestOutput(raw: string): TestStats {
  const out = stripAnsi(raw);
  const tries = [parseJest, parseVitest, parseMocha, parseKarma];
  let best: TestStats | null = null;
  for (const fn of tries) {
    const r = fn(out);
    if (r && (best === null || r.total > best.total)) best = r;
  }
  return best ?? EMPTY();
}
