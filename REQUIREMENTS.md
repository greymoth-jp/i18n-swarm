# i18n-swarm — requirements (Bet B PoC)

## Goal
A deterministic localization agent that takes a real English-only Vue 3 OSS web app
with no i18n and autonomously does the **code-side** i18n: detect framework, extract
hardcoded UI strings, wire vue-i18n, generate `en` + `ja` locale files, rewire the
components to use translation keys, and self-verify that the app still builds and its
tests stay green. Shares the run/verify engine with the Vue2-maintenance bet
(`vue2-eol-guard`): `sh.ts`, `testparse.ts`, the snapshot + trust-verdict pattern.

## Killer question
Can an agent do the code-side i18n at trustworthy quality **without heavy human
review**, or does it break the build / miss strings / mistranslate so badly that a
human must redo it? The verify gate (build + tests green after rewrite) is the trust
mechanism, exactly as in Bet A.

## Pipeline (each step independently runnable + one end-to-end run)
1. **detect** — scan a repo: framework (Vue SFC), candidate component files, existing
   i18n dependency (abort if already localized), build + test scripts.
2. **extract** — parse each SFC with `@vue/compiler-sfc` (real AST, not regex) and
   classify every text node / attribute:
   - `HIGH` — a clean, sole-child UI text node or a user-facing attribute
     (`placeholder`/`title`/`alt`/`aria-label`); safe to auto-rewire.
   - `AMBIGUOUS` — natural-language string that is **not** safe to auto-rewire:
     mixed text + inline elements, component prop strings. Extracted to the catalog
     but flagged for human review, never rewritten.
   - `SKIP` — not a UI string: interpolations `{{ x }}`, numbers/percentages, icon
     ligatures (parent class `material-icons*`/`material-symbols*`), `<code>`/`<pre>`/
     `<script>`/`<style>` content, empty whitespace.
3. **keys** — stable per-file key from a slug of the text; dedupe identical strings
   inside a file to one shared key.
4. **catalog** — build `en.json` (real source strings) and `ja.json` (every key present,
   value = English fallback) + a `translation-todo.json` manifest of strings awaiting
   human/MT translation. Translation **quality** is explicitly out of scope of the
   deterministic agent (see verdict).
5. **rewire** — offset-based surgical edits from the AST: `HIGH` text nodes →
   `{{ $t('key') }}`, `HIGH` attrs → `:attr="$t('key')"`. Each edit is verified against
   the original source slice before applying; a mismatch skips that node (never corrupt
   the file). `AMBIGUOUS`/`SKIP` left untouched.
6. **scaffold** — add `vue-i18n`, emit `src/i18n/index.ts` (`legacy:false`,
   `globalInjection:true` so `$t` works in templates), the locale files, a
   `vue-i18n` type-augmentation `.d.ts`, and wire `app.use(i18n)` into `main.ts`.
7. **verify** — reuse the Bet-A snapshot: `npm install` → build → unit tests, before
   and after. Compare: build still green, test count not regressed.

## Measures
- strings extracted + classification split (HIGH / AMBIGUOUS / SKIP) with reasons.
- coverage / auto-handled% = HIGH / (HIGH + AMBIGUOUS).
- components rewired (files touched) and whether build + unit tests stay green.
- precision/recall sanity check against a hand-read ground truth of this target.

## Verdict (`trustWithoutReview`)
- `AUTO-VERIFIED` only when: rewire applied, build green, unit tests >= baseline, no
  ambiguous strings silently dropped from rendering.
- Translation quality (ja) is reported separately — homograph mistranslation is the
  known #1 ja-locale failure mode (KB §1) and is **not** auto-trustworthy.

## Constraints
- TS/Node, runs `.ts` directly (Node >= 22.6). Faceless. MIT. Local-only PoC; do not
  open a PR to the target unless genuinely high quality + welcomed.
- No mocks: extract/rewire/verify run on a real cloned repo.

## Beachhead update (2026-06-30 experiment) — Next.js App Router + next-intl
The classifier core was factored into `classify-core.ts` (framework-agnostic decisions)
and now drives three frontends: Vue SFC (`extract.ts`), JSX/TSX via the TypeScript
compiler (`extract-jsx.ts`), and a per-file next-intl/react-i18next binding planner
(`binding.ts`). Scaffolds: `scaffold.ts` (vue-i18n), `scaffold-next.ts` (next-intl,
nested messages + request config), `scaffold-react.ts` (react-i18next).

Findings (verified, not assumed):
- **Generalizes on safety, not on coverage.** Across 5 real apps (3 Next, 1 Vue, 1 React)
  zero corruptions; the already-i18n'd app was correctly refused. Auto-handled ranged
  34.6%-84.9% (not a constant 64%) — driven by how much copy is clean labels vs prose +
  interpolation. The conservative rule (never split a mixed sentence / interpolated
  phrase) is what holds corruptions at 0 and also caps coverage.
- **next-intl needs NESTED messages.** A flat `{"a.b": v}` map returns the key itself at
  runtime (silent miss); vue-i18n resolves flat dotted keys fine. Proven with use-intl.
  → `nestLocale()` expands keys for the next-intl scaffold.
- **The build/typecheck gate is the real trust signal.** It caught a malformed
  `async export default function` edit (TS1029 / SWC syntax error) that a lightweight
  in-process parse check (createSourceFile/transpileModule/createProgram syntactic) all
  missed, and it caught the binding bug below that every static check passed. The gate is
  authoritative; nothing is reported safe that the gate has not cleared.
- **Binding is decided by async-ness, not by `'use client'`.** The earlier planner chose
  the server binding (`await getTranslations()` + async conversion) for any file without a
  `'use client'` directive. That over-marks shared/leaf components: a file with no directive
  of its own still runs on the client when a client component imports it (`logo.tsx` pulled
  in by the client `header.tsx`), and `getTranslations` there crashes the prerender
  (`getTranslations is not supported in Client Components`). Fix: `useTranslations()` works
  in Client Components and in synchronous Server Components, so it is the safe binding
  everywhere; only an already-`async` component gets `await getTranslations()`. The planner
  no longer makes anything async. This also removed the async-insert fragility class.
- **The standard next-intl App-Router wiring is now scaffolded, not deferred.**
  `scaffold-next.ts` wraps `next.config.*` with `createNextIntlPlugin` (AST-located export,
  CJS `module.exports` or ESM `export default`), writes `i18n/request.ts` (getRequestConfig,
  message path computed relative to its own location so the `src/` layout works too), and
  wires `<NextIntlClientProvider messages={getMessages()}>` around the root layout's `<body>`
  (making it async if needed). Every edit is offset-surgical and reparse-verified; an
  unexpected config/layout shape is left in the review queue.
- **Green, merge-ready for the common case (verified, not assumed).** Full end-to-end pass
  on two real, unmodified OSS apps: `cruip/open-react-template` (99 strings / 13 files /
  84.6% / 0 corruptions) and `shadcn-ui/next-template` (12 / 4 / 66.7% / 0). Both reach
  `next build` green; the second is `tsc --noEmit` clean too; prerendered HTML shows real
  English on every route, including the three `(auth)` pages, not keys. Two already-i18n'd
  apps (`Skolaczk/next-starter`, `ixartz/Next-js-Boilerplate`) are correctly refused. What
  stays in review is now only genuine human work (prose + ja translations), with no
  framework-wiring debt. App-specific shapes (i18n routing, client-component layout, unusual
  exports) still fall to the queue by design.
