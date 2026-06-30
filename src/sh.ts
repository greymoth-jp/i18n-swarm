import { spawn } from "node:child_process";
import path from "node:path";

export interface RunResult {
  cmd: string;
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  ok: boolean; // code === 0 && !timedOut
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** echo child output to our stdout live (for long installs) */
  inherit?: boolean;
}

/**
 * Run a shell command portably. On Windows we must use shell:true because Node
 * refuses to spawn npm.cmd/.bat directly since the CVE-2024-27980 fix. All call
 * sites here pass controlled, space-free tokens (npm/git subcommands + package
 * names), so shell:true is safe for this PoC.
 */
export function runShell(cmd: string, opts: RunOpts = {}): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      if (opts.inherit) process.stdout.write(Buffer.from(s, "utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      if (opts.inherit) process.stderr.write(Buffer.from(s, "utf8"));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        cmd, cwd, code: -1, signal: null,
        stdout, stderr: stderr + "\n[spawn error] " + err.message,
        timedOut, durationMs: Date.now() - started, ok: false,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        cmd, cwd, code, signal,
        stdout, stderr, timedOut,
        durationMs: Date.now() - started,
        ok: code === 0 && !timedOut,
      });
    });
  });
}

export function npmCmd(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Spawn an executable directly (no shell), so we control argv exactly. */
export function runExec(file: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();
  const cmd = `${file} ${args.join(" ")}`;
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, shell: false, env: { ...process.env, ...opts.env }, windowsHide: true,
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { const s = d.toString("utf8"); stdout += s; if (opts.inherit) process.stdout.write(Buffer.from(s, "utf8")); });
    child.stderr?.on("data", (d: Buffer) => { const s = d.toString("utf8"); stderr += s; if (opts.inherit) process.stderr.write(Buffer.from(s, "utf8")); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ cmd, cwd, code: -1, signal: null, stdout, stderr: stderr + "\n[spawn error] " + err.message, timedOut, durationMs: Date.now() - started, ok: false }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ cmd, cwd, code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started, ok: code === 0 && !timedOut }); });
  });
}

/**
 * Run a package.json script's command in a POSIX shell with the project's
 * node_modules/.bin prepended to PATH. On Windows this goes through git-bash
 * (with cygpath to translate the bin path) because npm's own PATH construction
 * fails to expose .bin to scripts in this environment; on Linux/macOS the same
 * shape works natively (and is what a CI runner would do).
 */
export function runProjectScript(repoDir: string, cmdStr: string, opts: RunOpts = {}): Promise<RunResult> {
  const fwd = repoDir.replace(/\\/g, "/");
  if (process.platform === "win32") {
    // The inherited PATH (opts.env) is Windows-format and useless inside bash, so
    // tools that shell out to `node` cannot find it. Prepend the orchestrator's own
    // node dir (process.execPath) in POSIX form so scripts use the same node.
    const nodeDir = path.dirname(process.execPath);
    const script = `cd "${fwd}" && export PATH="$(cygpath -u "${fwd}/node_modules/.bin"):$(cygpath -u "${nodeDir}"):$PATH" && ${cmdStr}`;
    return runExec("bash", ["-lc", script], opts);
  }
  const script = `cd "${fwd}" && export PATH="${fwd}/node_modules/.bin:$PATH" && ${cmdStr}`;
  return runExec("sh", ["-c", script], opts);
}
