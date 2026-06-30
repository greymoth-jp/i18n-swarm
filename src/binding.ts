import ts from "typescript";
import { detectScope, fileI18nState, type ComponentScope } from "./extract-jsx.ts";

export type Target = "next-intl" | "react-i18next";

export interface Edit { start: number; end: number; text: string; }

export interface BindingPlan {
  scope: ComponentScope;
  /** safe = every rewired component got a t binding through a supported code shape. */
  safe: boolean;
  reason: string;
  edits: Edit[]; // import + const t injections; merged with rewrite edits by caller
}

const COMPONENT_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
]);

interface CompFn {
  bodyOpenBrace: number; // offset just AFTER the opening "{" of the block body
  isAsync: boolean;
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
  const p: ts.Node | undefined = node.parent;
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
        out.push({ bodyOpenBrace: body.getStart(sf) + 1, isAsync, start: fn.getStart(sf), end: fn.getEnd() });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

type Kind = "use" | "get"; // useTranslations (sync, client-safe) | getTranslations (async server)

/**
 * Which binding a component needs. The right axis is async-ness, NOT the file-level
 * 'use client' directive: next-intl's `useTranslations()` works in Client Components AND
 * in synchronous Server Components, so it is the safe choice even for a shared/leaf
 * component that a Client Component imports (where the file has no 'use client' of its own
 * yet runs on the client). `getTranslations()` is reserved for components that are already
 * async (those are server-only by construction, so it is safe there). This is what fixes
 * the "getTranslations is not supported in Client Components" prerender failure.
 */
function bindingKind(target: Target, isAsync: boolean): Kind {
  if (target === "react-i18next") return "use";
  return isAsync ? "get" : "use";
}

function importTextFor(target: Target, kind: Kind): string {
  if (target === "react-i18next") return "import { useTranslation } from 'react-i18next';\n";
  return kind === "use"
    ? "import { useTranslations } from 'next-intl';\n"
    : "import { getTranslations } from 'next-intl/server';\n";
}

function alreadyImported(target: Target, kind: Kind, source: string): boolean {
  if (target === "react-i18next") return /import\s*\{[^}]*\buseTranslation\b[^}]*\}\s*from\s*['"]react-i18next['"]/.test(source);
  if (kind === "use") return /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*['"]next-intl['"]/.test(source);
  return /import\s*\{[^}]*\bgetTranslations\b[^}]*\}\s*from\s*['"]next-intl\/server['"]/.test(source);
}

function bindingLine(target: Target, kind: Kind): string {
  if (target === "react-i18next") return "\n  const { t } = useTranslation();";
  return kind === "use" ? "\n  const t = useTranslations();" : "\n  const t = await getTranslations();";
}

/**
 * Plan the binding edits for a file that has HIGH candidates at `highOffsets`.
 * Returns safe=true only when every component function that owns a rewired string is a
 * supported shape (block-body component) that can receive a `t` binding. Anything else
 * (arrow expression-body component, HOC-wrapped, copy outside any component fn, a file
 * already wiring its own `t`) is reported safe=false with a reason for the review queue.
 * Bindings never make a component async; a non-async component gets the client-safe
 * `useTranslations()` hook, an already-async one gets `await getTranslations()`.
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
  // react-i18next is a hook only; an async component can never receive it.
  if (target === "react-i18next" && [...owning].some((c) => c.isAsync)) {
    return { scope, safe: false, reason: "async component cannot receive the react-i18next hook - manual binding", edits: [] };
  }

  const edits: Edit[] = [];
  const kinds = new Set<Kind>([...owning].map((c) => bindingKind(target, c.isAsync)));
  const m = /^\s*(['"])use client\1;?[^\n]*\n/.exec(source);
  const at = m ? m.index + m[0].length : 0;
  let importText = "";
  for (const k of kinds) if (!alreadyImported(target, k, source)) importText += importTextFor(target, k);
  if (importText) edits.push({ start: at, end: at, text: importText });
  for (const c of owning) edits.push({ start: c.bodyOpenBrace, end: c.bodyOpenBrace, text: bindingLine(target, bindingKind(target, c.isAsync)) });

  const usedGet = [...owning].some((c) => bindingKind(target, c.isAsync) === "get");
  const usedUse = [...owning].some((c) => bindingKind(target, c.isAsync) === "use");
  const reason = target === "react-i18next"
    ? "react-i18next: useTranslation() injected"
    : usedGet && usedUse ? "mixed: useTranslations() for sync components, await getTranslations() for async ones"
      : usedGet ? "async server component: await getTranslations() injected"
        : "useTranslations() injected (client + synchronous server safe)";
  return { scope, safe: true, reason, edits };
}
