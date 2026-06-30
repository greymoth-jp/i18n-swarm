import fs from "node:fs";
import path from "node:path";

export type Framework = "vue" | "next" | "react" | "unknown";

export interface RepoInfo {
  dir: string;
  name: string;
  framework: Framework;
  srcDir: string;
  sfcFiles: string[]; // component files: .vue (vue) or .tsx/.jsx (react/next)
  hasI18n: boolean;
  i18nDep: string | null;
  buildScript: string | null;
  typecheckScript: string | null;
  testScript: string | null;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "e2e", "playwright-report", "coverage", ".next", "out", "build", "storybook-static"]);

function walkExt(dir: string, exts: string[], out: string[]): void {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkExt(path.join(dir, ent.name), exts, out);
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) {
      // skip declaration / test / story / config files
      if (/\.(d\.ts|test\.|spec\.|stories\.)/.test(ent.name)) continue;
      out.push(path.join(dir, ent.name));
    }
  }
}

function pick(scripts: Record<string, string>, names: string[]): string | null {
  for (const n of names) if (scripts[n]) return n;
  return null;
}

export function detectRepo(dir: string): RepoInfo {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  let framework: Framework = "unknown";
  if (deps.next) framework = "next";
  else if (deps.vue) framework = "vue";
  else if (deps.react) framework = "react";

  const i18nKey = Object.keys(deps).find((k) => /(^|[/])(vue-i18n|react-i18next|i18next|next-intl|@nuxtjs[/]i18n|svelte-i18n|@intlify|use-intl)/.test(k));
  // Next.js app dir lives at app/ or src/app/; React/Vue under src/.
  const srcDir = ["src", "app", "."].map((s) => path.join(dir, s)).find((d) => fs.existsSync(d)) ?? dir;
  const exts = framework === "vue" ? [".vue"] : [".tsx", ".jsx"];
  const sfcFiles: string[] = [];
  // for Next/React, scan both src/ and app/ and components/ from repo root to catch all
  const scanRoots = framework === "vue" ? [srcDir] : ["app", "src", "components", "."].map((s) => path.join(dir, s)).filter((d) => fs.existsSync(d));
  const seen = new Set<string>();
  for (const root of scanRoots) walkExt(root, exts, sfcFiles);
  const unique = sfcFiles.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));

  const scripts: Record<string, string> = pkg.scripts ?? {};
  return {
    dir,
    name: path.basename(dir),
    framework,
    srcDir,
    sfcFiles: unique.sort(),
    hasI18n: !!i18nKey,
    i18nDep: i18nKey ?? null,
    buildScript: pick(scripts, ["build-only", "build:only", "vite-build", "build"]),
    typecheckScript: pick(scripts, ["type-check", "typecheck", "tsc", "check-types"]),
    testScript: pick(scripts, ["test:unit", "test-unit", "test:vitest", "vitest", "test"]),
  };
}
