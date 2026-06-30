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
## react-i18next path (2026-07-01 — plain React, NOT Next.js)
The same classify/extract/rewire core now drives a third scaffold target: a plain React app
(Vite or Create React App) with react-i18next. The mechanism is framework-agnostic, so only
the binding and the scaffold are React-specific.

Findings (verified on real apps, not assumed):
- **Works on plain React.** Three unmodified English-only Vite/CRA apps with no i18n reached a
  green build after the full pass, zero corruptions each: `codescandy/dash-ui` (Vite+TS,
  1466 keys / 55 files / 45.7% auto), `ayoubhayda/react-admin-dashboard` (Vite+JS, 7 / 7.5%),
  and the stock `create-vite` react-ts template (7 / 43.8%). Both build shapes were exercised
  (`tsc -b && vite build` and `vite build`). A 4th, `Daaviddev/vite-dashboard-starter`, was
  dropped: its baseline build was already red (`TS5101`, deprecated `baseUrl` in tsconfig vs.
  current TypeScript) — the build gate refuses to claim a green it did not cause.
- **How it differs from next-intl.** No server/client split: there is no async server
  component, so the binding is always the single client-side hook `useTranslation()` (next-intl
  has to choose between `useTranslations()` and `await getTranslations()` on async-ness).
  Entry wiring replaces layout wiring: instead of wrapping the App-Router `<body>` in
  `<NextIntlClientProvider>`, the agent finds the `createRoot(...).render(...)` /
  `ReactDOM.render(...)` call at the app entry and wraps the mounted root element in
  `<I18nextProvider i18n={i18n}>` plus `import './i18n'`. Locales stay FLAT (react-i18next can
  resolve flat dotted keys with `keySeparator:false`; next-intl needs `nestLocale()`).
- **The resolveJsonModule trap (React-specific).** A TS app without `resolveJsonModule` fails
  to typecheck a `import en from './locales/en.json'`. The scaffold reads the project's tsconfig
  and, when a JSON import would not typecheck, inlines the resources into the init module
  instead (JS apps and resolveJsonModule-on TS apps keep the JSON import). This is what kept the
  TS apps green; the build gate is still the authority. `useSuspense:false` is set because the
  inlined resources init synchronously.

## Drift-gate false-positive suppression (2026-07-01 — making the gate enforceable)
The PoC found the gate clean in incremental (diff) mode but noisy whole-codebase, so a
suppression layer (`suppress.ts`) now runs after the classifier and demotes a HIGH flag to
a soft note in five buckets: brand/handle, decorative (aria-hidden + decorative `alt`),
code identifier (camel/Pascal/kebab/SCREAMING/dotted/variant-enum/breakpoint), dev-only
path (OG-image + metadata routes, config, stories, tests, scripts, viewport indicators),
and an inline `// i18n-ignore` directive. Lists are user-extensible via
`i18n-swarm.config.json` (`brands` / `enums` / `ignorePaths`). The decorative bucket needed
element context, so the JSX and Vue extractors now stamp text candidates that sit inside an
`aria-hidden` / `role="presentation"` element (classifier decisions are unchanged).

Re-measured on the same 5-repo corpus, whole-codebase, against each repo's pristine HEAD
(so earlier tool runs against the checkouts don't skew it), with an independent ground-truth
oracle written separately from the suppressor (verified, not assumed):

- **Baseline FP depends on the lens, and the aggregate is dominated by one repo.** Of 1618
  whole-codebase flags, 1470 (91%) come from `dash-ui`, a Bootstrap *component showcase*
  whose page content literally is component names, variant tokens and demo data — a worst
  case for any hardcoded-string gate. A conservative oracle (only clear non-copy is a false
  positive; section/label headings are real copy) puts the raw baseline at 13.7%; a strict
  "showcase content is noise" oracle puts it at 44%. The PoC's ~32% sits between the two.
- **Generic suppression (no per-project config): 13.7% → 7.1% corpus-wide, with 0
  false-negatives** (no real copy silenced, on every repo). The real signal is per-repo:
  the four genuine product apps land at 0% / 0% / 0% (react-admin, open-react-template,
  shadcn-next-template) and 25% on `precedent` — where "25%" is 4 flags out of 16, namely
  the product's own name and two utility-function names shown in a code grid. Only the
  `dash-ui` showcase keeps a real residue (7.4%), all of it Bootstrap demo placeholder data
  (`Otto`, `@mdo`, `Cell`).
- **With a one-line per-project allowlist** (the showcase's demo tokens): corpus FP → 0.1%,
  `dash-ui` → 0%, still 0 false-negatives. The last two residual flags are the `precedent`
  product name, which a `brands` entry closes.

Verdict: on real product code — the gate's actual deployment target — generic suppression
already reaches single digits and effectively 0 with a product-name entry, with no real
copy ever suppressed, so "a new hardcoded string is a red check" is enforceable as a hard
release-blocker. A component-showcase repo stays noisy without an allowlist, because its
content genuinely is the component vocabulary; the config handles that case. Re-run the
measurement with `node test/fp-corpus-measure.ts`.

- **Green, merge-ready for the common case (verified, not assumed).** Full end-to-end pass
  on two real, unmodified OSS apps: `cruip/open-react-template` (99 strings / 13 files /
  84.6% / 0 corruptions) and `shadcn-ui/next-template` (12 / 4 / 66.7% / 0). Both reach
  `next build` green; the second is `tsc --noEmit` clean too; prerendered HTML shows real
  English on every route, including the three `(auth)` pages, not keys. Two already-i18n'd
  apps (`Skolaczk/next-starter`, `ixartz/Next-js-Boilerplate`) are correctly refused. What
  stays in review is now only genuine human work (prose + ja translations), with no
  framework-wiring debt. App-specific shapes (i18n routing, client-component layout, unusual
  exports) still fall to the queue by design.

## Attr/prop classification refinement (2026-07-01, re-verified end to end on the 8-app corpus)
The first cut flagged EVERY string prop on a component as AMBIGUOUS ("may not be copy"),
flooding the review queue with config that is not localizable at all. `classifyAttr` now
decides on the prop name + value shape:
- **dropped (not copy, never queued):** `data-*`; name suffixes `*className/*class/*url/*src/
  *color/variant/size/align/mode/position/...`; and enum-shaped values — a single lower-case
  kebab/snake/camel token (`primary`, `sm`, `insideLeft`), a css value (`var(--x)`, `#hex`),
  or a url/path.
- **HIGH (auto-wired):** a display-copy prop (`label`, `heading`, `subtitle`, `description`,
  `caption`, `tooltip`, `text`, `message`, `pageTitle`, `pageDescription`, ...) whose value is
  prose-shaped (`isCopyShaped`: multi-word, or a capitalized real word). A bare lower-case
  token on a copy-ish prop stays in review, never auto-wired.
- **AMBIGUOUS (review):** a multi-word value on an unknown prop name — genuinely unclear.
Result on the eight-app Next corpus (re-run with the packed CLI, fresh install + `next build`):
average auto-handled 42.7% → 76.9% (per-app 49%–95%), review-queue prose 2116 → 422, and +83
strings genuinely newly auto-wired — build-verified type-safe, since adm-dashboard (670 edits),
kiran-dashboard (320) and magicui (242) all still reach a green `next build`. Corruptions stay
0 across all 10 apps; post-i18n build green 8/8. The conservative never-split rule is unchanged
(393 mixed/interpolated fragments stay in review). What genuinely cannot be auto-handled and
stays in review: 137 HIGH strings in react-table column callbacks / HOC render configs /
module-level brand-name icon objects (a translation hook cannot live there); and — absent from
this corpus, so deliberately NOT built ahead — `[locale]` routing and a client-component root
layout, where the safe next-intl wiring needs a server boundary the agent will not invent.
