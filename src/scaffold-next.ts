import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { nestLocale, type Locales } from "./catalog.ts";

export interface ScaffoldResult {
  steps: string[];
  warnings: string[];
}

interface Edit { start: number; end: number; text: string; }

/** Apply offset edits end->start; returns the new source. */
function applyEdits(src: string, edits: Edit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Parse-clean guard: true when `src` has no new syntactic diagnostics. */
function parsesClean(file: string, src: string): boolean {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.length === 0;
}

function requestConfigSource(messagesRel: string): string {
  return `import { getRequestConfig } from 'next-intl/server';

// Single-locale setup (no locale routing): the agent localizes the code and seeds the
// messages; negotiating / switching the active locale is left to the team.
export default getRequestConfig(async () => {
  const locale = 'en';
  return {
    locale,
    messages: (await import(\`${messagesRel}/\${locale}.json\`)).default,
  };
});
`;
}

/**
 * Wrap next.config.* with the next-intl plugin. Locates the export via the TS AST
 * (`module.exports = X` for CJS, `export default X` for ESM/TS) and wraps exactly that
 * expression with `withNextIntl(...)`. createNextIntlPlugin() takes no argument: next-intl
 * finds `./(src/)i18n/request.{ts,tsx,js,jsx}` by default, which is where we write it.
 * If the export shape is unexpected, the wrap is skipped and surfaced for review.
 */
function wireNextConfig(repoDir: string, steps: string[], warnings: string[]): void {
  const cfg = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"]
    .map((n) => path.join(repoDir, n)).find((f) => fs.existsSync(f));
  if (!cfg) { warnings.push("no next.config.* found - add createNextIntlPlugin manually"); return; }
  const raw = fs.readFileSync(cfg, "utf8");
  if (/next-intl\/plugin/.test(raw)) { steps.push("next.config already wraps next-intl"); return; }

  const sf = ts.createSourceFile(cfg, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let exportExpr: ts.Expression | null = null;
  let mode: "esm" | "cjs" | null = null;
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals) { exportExpr = st.expression; mode = "esm"; break; }
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)
      && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(st.expression.left)
      && st.expression.left.getText(sf) === "module.exports") {
      exportExpr = st.expression.right; mode = "cjs"; break;
    }
  }
  if (!exportExpr || !mode) {
    warnings.push(`could not locate the next.config export in ${path.basename(cfg)} - wrap it with createNextIntlPlugin manually (left for review)`);
    return;
  }
  const header = mode === "esm"
    ? "import createNextIntlPlugin from 'next-intl/plugin';\nconst withNextIntl = createNextIntlPlugin();\n\n"
    : "const createNextIntlPlugin = require('next-intl/plugin');\nconst withNextIntl = createNextIntlPlugin();\n\n";
  const s = exportExpr.getStart(sf), e = exportExpr.getEnd();
  const wrapped = raw.slice(0, s) + "withNextIntl(" + raw.slice(s, e) + ")" + raw.slice(e);
  const out = header + wrapped;
  if (!parsesClean(cfg, out)) {
    warnings.push(`next-intl plugin wrap of ${path.basename(cfg)} did not parse cleanly - left for review`);
    return;
  }
  fs.writeFileSync(cfg, out, "utf8");
  steps.push(`wrapped ${path.basename(cfg)} with createNextIntlPlugin (${mode})`);
}

/** Find the default-exported component function in a root layout. */
function findLayoutComponent(sf: ts.SourceFile): ts.FunctionLikeDeclaration | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body
      && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return st;
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const ex = st.expression;
      if ((ts.isArrowFunction(ex) || ts.isFunctionExpression(ex)) && ex.body && ts.isBlock(ex.body)) return ex;
    }
  }
  return null;
}

function findBodyElement(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): ts.JsxElement | null {
  let found: ts.JsxElement | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === "body" && n.closingElement) { found = n; return; }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/**
 * Wrap the root layout's <body> contents in <NextIntlClientProvider messages={messages}>,
 * inject `const messages = await getMessages()`, make the component async if needed, and add
 * the imports. Wrapping the whole <body> (not just {children}) keeps any client components
 * the layout itself renders (header/footer) inside the provider. Anything the agent cannot
 * edit safely - a client-component layout, an unusual shape, or a missing <body> - is left
 * for review instead of risking the app.
 */
function wireLayout(repoDir: string, steps: string[], warnings: string[]): void {
  const layout = ["app/layout.tsx", "src/app/layout.tsx", "app/layout.jsx", "src/app/layout.jsx"]
    .map((n) => path.join(repoDir, n)).find((f) => fs.existsSync(f));
  if (!layout) { warnings.push("no app/layout found - wrap children in <NextIntlClientProvider> manually"); return; }
  const raw = fs.readFileSync(layout, "utf8");
  if (/NextIntlClientProvider/.test(raw)) { steps.push("layout already has NextIntlClientProvider"); return; }
  if (/^\s*(['"])use client\1/m.test(raw)) {
    warnings.push("root layout is a client component - getMessages()/<NextIntlClientProvider> wiring left for review");
    return;
  }
  const sf = ts.createSourceFile(layout, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = findLayoutComponent(sf);
  if (!fn || !fn.body || !ts.isBlock(fn.body)) {
    warnings.push(`layout component shape in ${path.basename(layout)} is unsupported - provider wiring left for review`);
    return;
  }
  const body = findBodyElement(fn, sf);
  if (!body || !body.closingElement) {
    warnings.push(`no <body> element found in ${path.basename(layout)} - provider wiring left for review`);
    return;
  }

  const edits: Edit[] = [];
  edits.push({ start: 0, end: 0, text: "import { NextIntlClientProvider } from 'next-intl';\nimport { getMessages } from 'next-intl/server';\n" });
  const isAsync = (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsync) {
    let pos: number;
    if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) {
      const kw = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
      pos = kw ? kw.getStart(sf) : fn.getStart(sf);
    } else pos = fn.getStart(sf);
    edits.push({ start: pos, end: pos, text: "async " });
  }
  const brace = fn.body.getStart(sf) + 1;
  edits.push({ start: brace, end: brace, text: "\n  const messages = await getMessages();" });
  const openEnd = body.openingElement.getEnd();
  edits.push({ start: openEnd, end: openEnd, text: "\n        <NextIntlClientProvider messages={messages}>" });
  const closeStart = body.closingElement.getStart(sf);
  edits.push({ start: closeStart, end: closeStart, text: "</NextIntlClientProvider>\n      " });

  const out = applyEdits(raw, edits);
  if (!parsesClean(layout, out)) {
    warnings.push(`provider wiring of ${path.basename(layout)} did not parse cleanly - left for review`);
    return;
  }
  fs.writeFileSync(layout, out, "utf8");
  steps.push(`wired ${path.basename(layout)}: async + getMessages() + <NextIntlClientProvider> around <body>`);
}

function addDep(repoDir: string, steps: string[]): void {
  const pj = path.join(repoDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  if (!pkg.dependencies["next-intl"]) {
    pkg.dependencies["next-intl"] = "^3.26.0";
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    steps.push("added next-intl@^3.26 to dependencies");
  } else steps.push("next-intl already present");
}

/**
 * Scaffold next-intl into a Next.js App Router app (single-locale, no routing). Writes the
 * NESTED message files (next-intl resolves dotted keys against nested objects only), the
 * request config, then wires the two framework touch-points the standard setup needs:
 * the createNextIntlPlugin wrap in next.config and the <NextIntlClientProvider> in the
 * root layout. Both are AST-driven, offset-surgical, and reparse-verified; an unexpected
 * config / layout shape is left in the review queue rather than risking a broken app.
 */
export function scaffoldNext(repoDir: string, srcDir: string, locales: Locales, write: boolean): ScaffoldResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  const usesSrc = path.basename(srcDir) === "src";
  const messagesDir = path.join(repoDir, "messages");
  const i18nDir = usesSrc ? path.join(repoDir, "src", "i18n") : path.join(repoDir, "i18n");
  if (!write) return { steps: ["dry run - no files written"], warnings };

  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(i18nDir, { recursive: true });
  const en = nestLocale(locales.en);
  const ja = nestLocale(locales.ja);
  fs.writeFileSync(path.join(messagesDir, "en.json"), JSON.stringify(en, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(messagesDir, "ja.json"), JSON.stringify(ja, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(messagesDir, "translation-todo.json"), JSON.stringify(locales.translationTodo, null, 2) + "\n", "utf8");
  steps.push(`wrote messages/en.json (nested, ${Object.keys(locales.en).length} keys) + ja.json + translation-todo.json`);

  // request.ts imports messages by a path relative to its own location (root i18n/ -> ../messages,
  // src/i18n/ -> ../../messages). Compute it so the src-based layout works too.
  const messagesRel = path.relative(i18nDir, messagesDir).split(path.sep).join("/");
  fs.writeFileSync(path.join(i18nDir, "request.ts"), requestConfigSource(messagesRel), "utf8");
  steps.push(`wrote ${usesSrc ? "src/" : ""}i18n/request.ts`);

  addDep(repoDir, steps);
  wireNextConfig(repoDir, steps, warnings);
  wireLayout(repoDir, steps, warnings);
  return { steps, warnings };
}
