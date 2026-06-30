import fs from "node:fs";
import path from "node:path";
import { nestLocale, type Locales } from "./catalog.ts";

export interface ScaffoldResult {
  steps: string[];
  warnings: string[];
}

const REQUEST_CONFIG = `import { getRequestConfig } from 'next-intl/server';

// Minimal single-locale setup (no locale routing): the agent localizes the code and
// seeds messages; switching the active locale / negotiating it is left to the team.
export default getRequestConfig(async () => {
  const locale = 'en';
  return {
    locale,
    messages: (await import(\`../messages/\${locale}.json\`)).default,
  };
});
`;

/** Best-effort wrap of next.config.* with the next-intl plugin. */
function wireNextConfig(repoDir: string, requestRel: string, steps: string[], warnings: string[]): void {
  const cfg = ["next.config.ts", "next.config.mjs", "next.config.js"].map((n) => path.join(repoDir, n)).find((f) => fs.existsSync(f));
  if (!cfg) { warnings.push("no next.config.* found - next-intl plugin NOT wired (add createNextIntlPlugin manually)"); return; }
  const raw = fs.readFileSync(cfg, "utf8");
  if (/next-intl\/plugin/.test(raw)) { steps.push("next.config already wires next-intl"); return; }
  warnings.push(`next.config (${path.basename(cfg)}) must be wrapped: import createNextIntlPlugin from 'next-intl/plugin'; const withNextIntl = createNextIntlPlugin('${requestRel}'); export default withNextIntl(config) - left for review (config shapes vary too much to edit safely)`);
}

/** Best-effort note for the root layout provider. */
function noteLayout(repoDir: string, steps: string[], warnings: string[]): void {
  const layout = ["app/layout.tsx", "src/app/layout.tsx", "app/layout.jsx"].map((n) => path.join(repoDir, n)).find((f) => fs.existsSync(f));
  if (!layout) { warnings.push("no app/layout found - wrap children in <NextIntlClientProvider> manually"); return; }
  const raw = fs.readFileSync(layout, "utf8");
  if (/NextIntlClientProvider/.test(raw)) { steps.push("layout already has NextIntlClientProvider"); return; }
  warnings.push("app/layout.tsx should wrap {children} in <NextIntlClientProvider> (getMessages()) for client components - left for review");
}

function addDep(repoDir: string, steps: string[]): void {
  const pj = path.join(repoDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  if (!pkg.dependencies["next-intl"]) {
    pkg.dependencies["next-intl"] = "^3.0.0";
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    steps.push("added next-intl@^3 to dependencies");
  } else steps.push("next-intl already present");
}

/**
 * Scaffold next-intl into a Next.js App Router app. Writes NESTED message files
 * (next-intl resolves dotted keys against nested objects only), the request config,
 * and the dependency; the next.config wrap + layout provider are surfaced as review
 * warnings because those shapes vary too much to edit without risking the app.
 */
export function scaffoldNext(repoDir: string, srcDir: string, locales: Locales, write: boolean): ScaffoldResult {
  const steps: string[] = [];
  const warnings: string[] = [];
  // messages/ at repo root (next-intl convention), i18n/request.ts under src or root
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
  fs.writeFileSync(path.join(i18nDir, "request.ts"), REQUEST_CONFIG, "utf8");
  steps.push(`wrote ${usesSrc ? "src/" : ""}i18n/request.ts`);
  const requestRel = usesSrc ? "./src/i18n/request.ts" : "./i18n/request.ts";
  addDep(repoDir, steps);
  wireNextConfig(repoDir, requestRel, steps, warnings);
  noteLayout(repoDir, steps, warnings);
  return { steps, warnings };
}
