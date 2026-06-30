import fs from "node:fs";
import path from "node:path";
import { runShell, runProjectScript, npmCmd } from "./sh.ts";
import { parseTestOutput, type TestStats } from "./testparse.ts";
import type { RepoInfo } from "./detect.ts";
import type { PhaseResult } from "./types.ts";

const MIN = 60_000;

export interface Snapshot {
  step: "baseline" | "verify";
  install: PhaseResult;
  build: PhaseResult; // pure bundling (e.g. vite build) - authoritative compile check
  typecheck: PhaseResult; // vue-tsc - advisory (type tooling noise is common)
  test: PhaseResult & { stats: TestStats };
}

/** Child env: pin node/npm to the runtime executing this CLI, skip Playwright DL. */
function childEnv(repo: RepoInfo): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    CI: "true",
    FORCE_COLOR: "0",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
  };
  const nodeDir = path.dirname(process.execPath);
  const bin = path.join(repo.dir, "node_modules", ".bin");
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  e[pathKey] = bin + path.delimiter + nodeDir + path.delimiter + (process.env[pathKey] ?? "");
  return e;
}

function scriptCmd(repo: RepoInfo, name: string | null): string | null {
  if (!name) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo.dir, "package.json"), "utf8"));
    return pkg.scripts?.[name] ?? null;
  } catch { return null; }
}

async function install(repo: RepoInfo): Promise<PhaseResult> {
  // --ignore-scripts: a heavy devDep tree overflows the Windows lifecycle-script
  // PATH limit (node drops off PATH -> esbuild's postinstall fails). esbuild and
  // friends ship prebuilt platform binaries via optionalDependencies, so the build
  // still works without postinstall hooks.
  const r = await runShell(`${npmCmd()} install --ignore-scripts --no-audit --no-fund`, {
    cwd: repo.dir, timeoutMs: 12 * MIN, env: childEnv(repo), inherit: true,
  });
  return { ran: true, ok: r.ok, durationMs: r.durationMs, note: r.timedOut ? "install timed out" : r.ok ? "installed" : `install exit ${r.code}` };
}

async function script(repo: RepoInfo, name: string | null, label: string): Promise<{ phase: PhaseResult; out: string }> {
  const cmd = scriptCmd(repo, name);
  if (!cmd) return { phase: { ran: false, ok: false, durationMs: 0, note: `no ${label} script` }, out: "" };
  const r = await runProjectScript(repo.dir, cmd, { cwd: repo.dir, timeoutMs: 8 * MIN, env: childEnv(repo), inherit: true });
  return {
    phase: { ran: true, ok: r.ok, durationMs: r.durationMs, note: r.timedOut ? `${label} timed out` : r.ok ? `${label} ok (${name})` : `${label} exit ${r.code}` },
    out: r.stdout + "\n" + r.stderr,
  };
}

export async function takeSnapshot(repo: RepoInfo, step: "baseline" | "verify", doInstall: boolean): Promise<Snapshot> {
  const inst = doInstall
    ? await install(repo)
    : { ran: false, ok: true, durationMs: 0, note: "install skipped (reused)" };
  let build: PhaseResult = { ran: false, ok: false, durationMs: 0, note: "skipped (install failed)" };
  let typecheck: PhaseResult = { ran: false, ok: false, durationMs: 0, note: "skipped (install failed)" };
  let test: PhaseResult = { ran: false, ok: false, durationMs: 0, note: "skipped (install failed)" };
  let testOut = "";
  if (inst.ok) {
    build = (await script(repo, repo.buildScript, "build")).phase;
    typecheck = (await script(repo, repo.typecheckScript, "typecheck")).phase;
    const t = await script(repo, repo.testScript, "test");
    test = t.phase; testOut = t.out;
  }
  return {
    step, install: inst, build, typecheck,
    test: { ...test, stats: parseTestOutput(testOut) },
  };
}
