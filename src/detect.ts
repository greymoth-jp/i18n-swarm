import fs from "node:fs";
import path from "node:path";

export interface RepoInfo {
  dir: string;
  name: string;
  framework: "vue" | "unknown";
  srcDir: string;
  sfcFiles: string[];
  hasI18n: boolean;
  i18nDep: string | null;
  buildScript: string | null; // pure bundling (vite build) when available
  typecheckScript: string | null;
  testScript: string | null; // unit tests, no browser/e2e
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "e2e", "playwright-report", "coverage"]);

function walkSfc(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkSfc(path.join(dir, ent.name), out);
    } else if (ent.isFile() && ent.name.endsWith(".vue")) {
      out.push(path.join(dir, ent.name));
    }
  }
}

/** Prefer a script from a priority list (exact name match). */
function pick(scripts: Record<string, string>, names: string[]): string | null {
  for (const n of names) if (scripts[n]) return n;
  return null;
}

export function detectRepo(dir: string): RepoInfo {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework: RepoInfo["framework"] = deps.vue ? "vue" : "unknown";
  const i18nKey = Object.keys(deps).find((k) => /(^|[/])(vue-i18n|react-i18next|i18next|@nuxtjs[/]i18n|svelte-i18n|intlify)/.test(k));
  const srcDir = ["src", "app", "."].map((s) => path.join(dir, s)).find((d) => fs.existsSync(d)) ?? dir;
  const sfcFiles: string[] = [];
  walkSfc(srcDir, sfcFiles);
  const scripts: Record<string, string> = pkg.scripts ?? {};
  return {
    dir,
    name: path.basename(dir),
    framework,
    srcDir,
    sfcFiles: sfcFiles.sort(),
    hasI18n: !!i18nKey,
    i18nDep: i18nKey ?? null,
    buildScript: pick(scripts, ["build-only", "build:only", "vite-build", "build"]),
    typecheckScript: pick(scripts, ["type-check", "typecheck", "tsc"]),
    testScript: pick(scripts, ["test:unit", "test-unit", "test:vitest", "vitest", "test"]),
  };
}
