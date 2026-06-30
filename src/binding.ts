import ts from "typescript";
import { detectScope, fileI18nState, type ComponentScope } from "./extract-jsx.ts";

export type Target = "next-intl" | "react-i18next";

export interface Edit { start: number; end: number; text: string; }

export interface BindingPlan {
  scope: ComponentScope;
  /** safe = every rewired component got a t binding through a supported code shape. */
  safe: boolean;
  reason: string;
  edits: Edit[]; // import + (async) + const t injections; merged with rewrite edits by caller
}

const COMPONENT_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
]);

interface CompFn {
  node: ts.FunctionLikeDeclaration;
  bodyOpenBrace: number; // offset just AFTER the opening "{" of the block body
  asyncInsert: number | null; // offset to insert "async " (null if already async / N/A)
  start: number;
  end: number;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isJsxSelfClosingElement(n)) { found = true; return; }
    // do not descend into nested function bodies (their JSX belongs to them)
    if (n !== node && COMPONENT_KINDS.has(n.kind)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function isComponentShaped(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): boolean {
  // named Uppercase function, OR default-exported, OR assigned to an Uppercase const.
  if (ts.isFunctionDeclaration(node)) {
    const name = node.name?.getText(sf);
    const mods = ts.getModifiers(node) ?? [];
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    return isDefault || (!!name && /^[A-Z]/.test(name));
  }
  // arrow / function expr: look at the binding it is assigned to
  let p: ts.Node | undefined = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return /^[A-Z]/.test(p.name.getText(sf));
  if (p && ts.isExportAssignment(p)) return true; // export default () => ...
  return false;
}

function collectComponentFns(sf: ts.SourceFile): CompFn[] {
  const out: CompFn[] = [];
  const visit = (n: ts.Node) => {
    if (COMPONENT_KINDS.has(n.kind)) {
      const fn = n as ts.FunctionLikeDeclaration;
      const body = fn.body;
      if (body && ts.isBlock(body) && isComponentShaped(fn, sf) && containsJsx(fn)) {
        const isAsync = (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        let asyncInsert: number | null = null;
        if (!isAsync) {
          // `async` must sit AFTER export/default modifiers and BEFORE `function`. For a
          // declaration/expression that means the `function` keyword's position; for an
          // arrow it means the start of the (params).  Inserting at fn.getStart() for a
          // modified declaration would wrongly produce `async export default function`.
          if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) {
            const kw = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
            asyncInsert = kw ? kw.getStart(sf) : fn.getStart(sf);
          } else {
            asyncInsert = fn.getStart(sf); // arrow: before "("
          }
        }
        out.push({ node: fn, bodyOpenBrace: body.getStart(sf) + 1, asyncInsert, start: fn.getStart(sf), end: fn.getEnd() });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

function importLineFor(target: Target, scope: ComponentScope): string {
  if (target === "react-i18next") return "import { useTranslation } from 'react-i18next';\n";
  return scope === "client"
    ? "import { useTranslations } from 'next-intl';\n"
    : "import { getTranslations } from 'next-intl/server';\n";
}

function bindingLineFor(target: Target, scope: ComponentScope): string {
  if (target === "react-i18next") return "\n  const { t } = useTranslation();";
  return scope === "client" ? "\n  const t = useTranslations();" : "\n  const t = await getTranslations();";
}

function importEdit(target: Target, scope: ComponentScope, source: string): Edit | null {
  if (target === "react-i18next" && /import\s*\{[^}]*\buseTranslation\b[^}]*\}\s*from\s*['"]react-i18next['"]/.test(source)) return null;
  if (target === "next-intl" && scope === "client" && /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*['"]next-intl['"]/.test(source)) return null;
  if (target === "next-intl" && scope === "server" && /import\s*\{[^}]*\bgetTranslations\b[^}]*\}\s*from\s*['"]next-intl\/server['"]/.test(source)) return null;
  const line = importLineFor(target, scope);
  // insert after a 'use client' directive if present, else at file top
  const m = /^\s*(['"])use client\1;?[^\n]*\n/.exec(source);
  const at = m ? m.index + m[0].length : 0;
  return { start: at, end: at, text: line };
}

/**
 * Plan the next-intl binding edits for a file that has HIGH candidates at `highOffsets`.
 * Returns safe=true only when every component function that owns a rewired string is a
 * supported shape (block-body component) and can receive a `t` binding. Anything else
 * (arrow expression-body component, HOC-wrapped, copy outside any component fn, a file
 * that already wires its own t) is reported safe=false with a reason for the review queue.
 */
export function planBinding(file: string, source: string, highOffsets: number[], target: Target = "next-intl"): BindingPlan {
  // react-i18next has no server variant; everything is a client-style hook.
  const scope: ComponentScope = target === "react-i18next" ? "client" : detectScope(source);
  const state = fileI18nState(source);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  if (state.usesHook) {
    return { scope, safe: false, reason: "file already calls a translation hook (manual merge to avoid a double binding)", edits: [] };
  }
  if (highOffsets.length === 0) return { scope, safe: true, reason: "no rewrites needed", edits: [] };

  const comps = collectComponentFns(sf);
  // every HIGH offset must fall inside exactly one supported component fn
  const owning = new Set<CompFn>();
  for (const off of highOffsets) {
    const owner = comps.find((c) => off >= c.start && off < c.end);
    if (!owner) {
      return { scope, safe: false, reason: "a rewired string lives outside a supported component function (arrow expression-body / HOC / nested render prop)", edits: [] };
    }
    owning.add(owner);
  }

  const edits: Edit[] = [];
  const imp = importEdit(target, scope, source);
  if (imp) edits.push(imp);
  const binding = bindingLineFor(target, scope);
  const serverAsync = target === "next-intl" && scope === "server";
  for (const c of owning) {
    edits.push({ start: c.bodyOpenBrace, end: c.bodyOpenBrace, text: binding });
    if (serverAsync && c.asyncInsert !== null) {
      edits.push({ start: c.asyncInsert, end: c.asyncInsert, text: "async " });
    }
  }
  const reason = target === "react-i18next"
    ? "react-i18next: useTranslation() injected"
    : scope === "client" ? "client component: useTranslations() injected" : "server component: getTranslations() injected (async)";
  return { scope, safe: true, reason, edits };
}
