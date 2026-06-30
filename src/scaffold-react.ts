import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { jsxParseErrors } from "./rewire-jsx.ts";
import { type Locales } from "./catalog.ts";

export interface ScaffoldResult { steps: string[]; warnings: string[]; }

interface Edit { start: number; end: number; text: string; }

/** Apply offset edits end->start; returns the new source. */
function applyEdits(src: string, edits: Edit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function i18nInitSource(jsonImport: boolean): string {
  // react-i18next resolves dotted keys against nested resources by default; the agent
  // writes flat dotted keys, so keySeparator/nsSeparator are disabled to treat "ns.key"
  // as a single literal lookup. useSuspense is off because the resources are inlined
  // (synchronous init, no async backend) - so a component never suspends on first paint.
  const resources = jsonImport
    ? `import en from './locales/en.json';\nimport ja from './locales/ja.json';\n`
    : "";
  return `import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
${resources}
i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ja: { translation: ja } },
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
`;
}

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

/** A plain-React app is a TS app when it has a tsconfig or a .ts/.tsx entry. */
function usesTypeScript(repoDir: string, entry: string | null): boolean {
  if (entry && (entry.endsWith(".tsx") || entry.endsWith(".ts"))) return true;
  return ["tsconfig.json", "tsconfig.app.json"].some((f) => fs.existsSync(path.join(repoDir, f)));
}

/** Whether the nearest tsconfig enables resolveJsonModule (best-effort, JSONC-tolerant). */
function jsonImportTypechecks(repoDir: string): boolean {
  for (const f of ["tsconfig.app.json", "tsconfig.json"]) {
    const p = path.join(repoDir, f);
    if (!fs.existsSync(p)) continue;
    const parsed = ts.parseConfigFileTextToJson(p, fs.readFileSync(p, "utf8"));
    const co = (parsed.config?.compilerOptions ?? {}) as Record<string, unknown>;
    if (co.resolveJsonModule === true) return true;
    // "bundler" / "node16"+ module resolution with the Vite preset usually allows it,
    // but we cannot prove it from here - be conservative and inline instead.
  }
  return false;
}

/** Locate the app entry that mounts React (Vite: main.tsx; CRA: index.tsx/js). */
function findEntry(repoDir: string, srcDir: string): string | null {
  const names = ["main.tsx", "main.jsx", "main.ts", "main.js", "index.tsx", "index.jsx", "index.ts", "index.js"];
  for (const dir of [srcDir, repoDir]) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      if (/\.render\s*\(/.test(src)) return p; // createRoot(...).render / ReactDOM.render
    }
  }
  return null;
}

/** The first JSX argument of a `.render(...)` call (the mounted root element). */
function findRenderArg(sf: ts.SourceFile): ts.Node | null {
  let arg: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (arg) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === "render" && n.arguments.length >= 1) {
      let a: ts.Node = n.arguments[0];
      if (ts.isParenthesizedExpression(a)) a = a.expression; // .render((<App/>)) -> inner
      if (ts.isJsxElement(a) || ts.isJsxFragment(a) || ts.isJsxSelfClosingElement(a)) { arg = a; return; }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return arg;
}

/**
 * Wire the app entry: `import i18n from './i18n'` (runs init on import) + wrap the mounted
 * root element in <I18nextProvider i18n={i18n}>. AST-located, offset-surgical, and
 * reparse-verified. An entry we cannot find, an unexpected render shape, or an edit that
 * would not parse cleanly is left for review rather than risking the app.
 */
function wireEntry(repoDir: string, srcDir: string, i18nDir: string, steps: string[], warnings: string[]): void {
  const entry = findEntry(repoDir, srcDir);
  if (!entry) {
    warnings.push("no React entry (main.tsx/index.tsx) found - import './i18n' + <I18nextProvider> manually (left for review)");
    return;
  }
  const raw = fs.readFileSync(entry, "utf8");
  if (/I18nextProvider/.test(raw) || /from\s+['"][^'"]*\/i18n['"]/.test(raw)) {
    steps.push(`entry ${path.basename(entry)} already wires i18n`);
    return;
  }
  const sf = ts.createSourceFile(entry, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = findRenderArg(sf);
  if (!node) {
    warnings.push(`could not find the render() root element in ${path.basename(entry)} - wrap it in <I18nextProvider> manually (left for review)`);
    return;
  }
  const rel = (() => {
    const r = path.relative(path.dirname(entry), i18nDir).split(path.sep).join("/");
    return r.startsWith(".") ? r : "./" + r;
  })();
  const s = node.getStart(sf), e = node.getEnd();
  const edits: Edit[] = [
    { start: 0, end: 0, text: `import { I18nextProvider } from 'react-i18next';\nimport i18n from '${rel}';\n` },
    { start: s, end: s, text: "<I18nextProvider i18n={i18n}>" },
    { start: e, end: e, text: "</I18nextProvider>" },
  ];
  const out = applyEdits(raw, edits);
  if (jsxParseErrors(entry, out) > jsxParseErrors(entry, raw)) {
    warnings.push(`<I18nextProvider> wiring of ${path.basename(entry)} did not parse cleanly - left for review`);
    return;
  }
  fs.writeFileSync(entry, out, "utf8");
  steps.push(`wired ${path.basename(entry)}: import './i18n' + <I18nextProvider i18n={i18n}> around the root element`);
}

/**
 * Scaffold react-i18next into a plain (non-Next) React app - Vite or CRA. Writes the flat-key
 * locale set + an i18n init module (keySeparator off, so the agent's dotted keys are literal),
 * then wires the single framework touch-point a plain React app needs: importing the init and
 * wrapping the root element in <I18nextProvider> at the app entry. The init imports the locale
 * JSON only when the project's tsconfig will typecheck a JSON import (resolveJsonModule);
 * otherwise the resources are inlined so the build/typecheck gate stays green either way.
 * The entry edit is AST-driven and reparse-verified; an unusual entry is left in the review queue.
 */
export function scaffoldReact(repoDir: string, srcDir: string, locales: Locales, write: boolean): ScaffoldResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  if (!write) return { steps: ["dry run"], warnings };

  const entry = findEntry(repoDir, srcDir);
  const ts_ = usesTypeScript(repoDir, entry);
  const ext = ts_ ? "ts" : "js";
  // A JS app has no typecheck step, so a JSON import is always safe there; a TS app needs
  // resolveJsonModule, else the JSON import is a typecheck error -> inline the resources.
  const jsonImport = !ts_ || jsonImportTypechecks(repoDir);

  const i18nDir = path.join(srcDir, "i18n");
  const localeDir = path.join(i18nDir, "locales");
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, "en.json"), JSON.stringify(locales.en, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "ja.json"), JSON.stringify(locales.ja, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(localeDir, "translation-todo.json"), JSON.stringify(locales.translationTodo, null, 2) + "\n", "utf8");

  let initSrc = i18nInitSource(jsonImport);
  if (!jsonImport) {
    // Inline the resources directly so a TS app without resolveJsonModule still typechecks.
    const enLit = JSON.stringify(locales.en, null, 2);
    const jaLit = JSON.stringify(locales.ja, null, 2);
    initSrc = initSrc.replace(
      "i18n.use(initReactI18next).init({\n  resources: { en: { translation: en }, ja: { translation: ja } },",
      `const en: Record<string, string> = ${enLit};\nconst ja: Record<string, string> = ${jaLit};\n\ni18n.use(initReactI18next).init({\n  resources: { en: { translation: en }, ja: { translation: ja } },`,
    );
  }
  fs.writeFileSync(path.join(i18nDir, `index.${ext}`), initSrc, "utf8");
  steps.push(`wrote i18n/index.${ext} + locales/en.json (${Object.keys(locales.en).length} keys) + ja.json${jsonImport ? "" : " (resources inlined: no resolveJsonModule)"}`);

  addDep(repoDir, steps);
  wireEntry(repoDir, srcDir, i18nDir, steps, warnings);
  return { steps, warnings };
}
