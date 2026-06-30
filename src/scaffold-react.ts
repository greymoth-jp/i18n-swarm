import fs from "node:fs";
import path from "node:path";
import { type Locales } from "./catalog.ts";

export interface ScaffoldResult { steps: string[]; warnings: string[]; }

const I18N_INIT = `import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

// react-i18next resolves dotted keys against nested resources by default; the agent
// writes flat dotted keys, so keySeparator is disabled to treat "ns.key" as a literal.
i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ja: { translation: ja } },
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export default i18n;
`;

function addDep(repoDir: string, steps: string[]): void {
  const pj = path.join(repoDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  let added = false;
  for (const [d, v] of [["react-i18next", "^14.0.0"], ["i18next", "^23.0.0"]]) {
    if (!pkg.dependencies[d]) { pkg.dependencies[d] = v; added = true; }
  }
  if (added) { fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf8"); steps.push("added react-i18next + i18next to dependencies"); }
  else steps.push("react-i18next already present");
}

/**
 * Minimal react-i18next scaffold for a plain (non-Next) React app. Writes a flat-key
 * locale set + an i18n init module with keySeparator disabled (so the agent's dotted
 * keys are literal). Importing the init module into the app entry is left for review
 * (entry shapes vary: main.tsx / index.tsx / App.tsx).
 */
export function scaffoldReact(repoDir: string, srcDir: string, locales: Locales, write: boolean): ScaffoldResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  if (!write) return { steps: ["dry run"], warnings };
  const i18nDir = path.join(srcDir, "i18n");
  const localeDir = path.join(i18nDir, "locales");
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, "en.json"), JSON.stringify(locales.en, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "ja.json"), JSON.stringify(locales.ja, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "translation-todo.json"), JSON.stringify(locales.translationTodo, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(i18nDir, "index.ts"), I18N_INIT, "utf8");
  steps.push(`wrote i18n/index.ts + locales/en.json (${Object.keys(locales.en).length} keys) + ja.json`);
  addDep(repoDir, steps);
  warnings.push("import './i18n' once in the app entry (main.tsx/index.tsx) to initialize - left for review");
  return { steps, warnings };
}
