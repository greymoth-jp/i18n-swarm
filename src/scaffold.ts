import fs from "node:fs";
import path from "node:path";
import type { Locales } from "./catalog.ts";

export interface ScaffoldResult {
  steps: string[];
  warnings: string[];
  i18nEntry: string;
  localeDir: string;
}

const I18N_INDEX = (relLocales: string) => `import { createI18n } from 'vue-i18n'
import en from '${relLocales}/en.json'
import ja from '${relLocales}/ja.json'

// Composition mode + globalInjection so $t works in every template without a
// per-component useI18n() call. Source language (en) is also the fallback.
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en, ja },
})

export default i18n
`;

const SHIM = `// Lets vue-tsc resolve $t and friends in templates under globalInjection.
import 'vue'

declare module 'vue' {
  interface ComponentCustomProperties {
    $t: (key: string, ...args: unknown[]) => string
    $tc: (key: string, ...args: unknown[]) => string
    $te: (key: string) => boolean
    $d: (...args: unknown[]) => string
    $n: (...args: unknown[]) => string
    $tm: (key: string) => unknown
    $rt: (...args: unknown[]) => string
  }
}
`;

function relImport(from: string, to: string): string {
  let r = path.relative(path.dirname(from), to).replace(/\\/g, "/");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
}

/** Add vue-i18n to dependencies if missing. */
function addDep(repoDir: string, steps: string[]): void {
  const pj = path.join(repoDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  if (!pkg.dependencies["vue-i18n"]) {
    pkg.dependencies["vue-i18n"] = "^11.0.0";
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    steps.push("added vue-i18n@^11 to dependencies");
  } else {
    steps.push("vue-i18n already present");
  }
}

/** Ensure resolveJsonModule so JSON locale imports type-check under vue-tsc. */
function ensureJsonModule(repoDir: string, steps: string[], warnings: string[]): void {
  const candidates = ["tsconfig.app.json", "tsconfig.json"];
  for (const name of candidates) {
    const f = path.join(repoDir, name);
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f, "utf8");
      if (/"resolveJsonModule"\s*:/.test(raw)) { steps.push(`resolveJsonModule already set (${name})`); return; }
      // minimal injection into compilerOptions without a full JSON5 parse
      const m = raw.match(/"compilerOptions"\s*:\s*\{/);
      if (m && m.index !== undefined) {
        const at = m.index + m[0].length;
        const out = raw.slice(0, at) + `\n    "resolveJsonModule": true,` + raw.slice(at);
        fs.writeFileSync(f, out, "utf8");
        steps.push(`enabled resolveJsonModule in ${name}`);
        return;
      }
    } catch (e) {
      warnings.push(`could not edit ${name}: ${(e as Error).message}`);
    }
  }
  warnings.push("no tsconfig found to enable resolveJsonModule (JSON imports may need --build flag)");
}

/** Wire app.use(i18n) into the entry file. */
function wireEntry(srcDir: string, i18nEntry: string, steps: string[], warnings: string[]): void {
  const entry = ["main.ts", "main.js"].map((n) => path.join(srcDir, n)).find((f) => fs.existsSync(f));
  if (!entry) { warnings.push("no main.ts/main.js entry found - app.use(i18n) NOT wired"); return; }
  let src = fs.readFileSync(entry, "utf8");
  if (/from ['"].*\/i18n['"]/.test(src)) { steps.push("entry already imports i18n"); return; }
  const rel = relImport(entry, i18nEntry).replace(/\/index$/, "");
  const importLine = `import i18n from '${rel}'\n`;
  // place the import after the App import (or after the first import)
  const appImport = src.match(/^import App from .*$/m);
  if (appImport && appImport.index !== undefined) {
    const at = appImport.index + appImport[0].length + 1;
    src = src.slice(0, at) + importLine + src.slice(at);
  } else {
    src = importLine + src;
  }
  // insert the registration
  if (/\bapp\.mount\s*\(/.test(src)) {
    src = src.replace(/\bapp\.mount\s*\(/, "app.use(i18n)\n\napp.mount(");
  } else if (/\.mount\s*\(/.test(src)) {
    src = src.replace(/\.mount\s*\(/, ".use(i18n)\n  .mount(");
  } else {
    warnings.push("could not find .mount() to register i18n");
  }
  fs.writeFileSync(entry, src, "utf8");
  steps.push(`wired i18n into ${path.basename(entry)}`);
}

export function scaffold(repoDir: string, srcDir: string, locales: Locales, write: boolean): ScaffoldResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  const i18nDir = path.join(srcDir, "i18n");
  const localeDir = path.join(srcDir, "locales");
  const i18nEntry = path.join(i18nDir, "index.ts");
  if (!write) {
    return { steps: ["dry run - no files written"], warnings, i18nEntry, localeDir };
  }
  fs.mkdirSync(i18nDir, { recursive: true });
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, "en.json"), JSON.stringify(locales.en, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "ja.json"), JSON.stringify(locales.ja, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "translation-todo.json"), JSON.stringify(locales.translationTodo, null, 2) + "\n", "utf8");
  steps.push(`wrote en.json (${Object.keys(locales.en).length} keys) + ja.json + translation-todo.json`);
  fs.writeFileSync(i18nEntry, I18N_INDEX(relImport(i18nEntry, localeDir)), "utf8");
  fs.writeFileSync(path.join(srcDir, "shims-vue-i18n.d.ts"), SHIM, "utf8");
  steps.push("wrote src/i18n/index.ts + shims-vue-i18n.d.ts");
  addDep(repoDir, steps);
  ensureJsonModule(repoDir, steps, warnings);
  wireEntry(srcDir, i18nEntry, steps, warnings);
  return { steps, warnings, i18nEntry, localeDir };
}
