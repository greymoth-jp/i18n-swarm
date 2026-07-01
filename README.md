# i18n-swarm

A CI gate that fails a pull request the moment it adds a new hardcoded user-facing
string without a translation key. It runs on the diff, not the whole tree, so it points
at the one string the PR just added and prints the keyed fix as a ready-to-apply patch.
Works on Next.js (App Router, next-intl), Vue 3 (vue-i18n), and plain React (react-i18next).

The job it does over and over is that gate: a localization regression never reaches
production because the check fails the build first. Before the gate can judge your code
it has to learn your keys, which is the one-time retrofit below. The gate is the point;
the retrofit is the on-ramp.

## The drift gate

Drop this workflow in and a PR that introduces an un-keyed UI string fails CI:

```yaml
# .github/workflows/i18n-drift-gate.yml
name: i18n drift gate
on: pull_request

jobs:
  i18n-swarm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # the gate diffs base..head, so both commits must be present
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: i18n drift gate
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: npx i18n-swarm@0.1.0 check "$BASE..$HEAD"
```

`fetch-depth: 0` matters: the gate asks "what strings did this PR add?", so it needs the
base commit as well as the head. A shallow checkout leaves the base absent and the diff
cannot be computed. To make the gate a hard release-blocker, mark the `i18n-swarm` job as
a required status check in branch protection.

The repo also ships a composite action (`action.yml`) that derives the diff range from
the event for you, so once it is published to the Marketplace the whole step collapses to
`uses: greymoth-jp/i18n-swarm@v1`. The raw `npx` workflow above works today, with nothing
to install.

### What a failing run looks like

`check` exits non-zero and shows the keyed fix, scoped to the newly-added string only:

```
--------------------------------------------------------------------
i18n-swarm check   0e30e8c..09592f9   (1 UI file(s) in diff)
--------------------------------------------------------------------
FAIL  src/pricing.tsx
   line 8  <button>  "Start free trial"   -> key pricing.start_free_trial
   suggested fix (keyed, scoped to the new strings only):
   | --- a/src/pricing.tsx
   | +++ b/src/pricing.tsx
   | @@ -5,7 +5,7 @@
   |    return (
   |      <section>
   |        <h2>{t('pricing.simple_pricing')}</h2>
   | -      <button>Start free trial</button>
   | +      <button>{t('pricing.start_free_trial')}</button>
   |      </section>
   |    );
   |  }
--------------------------------------------------------------------
FAIL - 1 new hardcoded UI string(s) landed un-keyed. Apply the suggested diff or wrap them in t()/$t().
--------------------------------------------------------------------
```

The `<h2>` above is already keyed, and it was added in an earlier commit, so the gate
leaves it alone. Only the `<button>` that this diff introduced fails. A green diff (every
new string keyed) exits 0 and prints `PASS`.

### Running it locally

The action wraps the same CLI you can run by hand. From the repo root:

```
npx i18n-swarm check                        working tree vs HEAD (a pre-commit catch)
npx i18n-swarm check <base>..<head>          a specific range
npx i18n-swarm check --files=a.tsx,b.vue     explicit files (whole file treated as new)
npx i18n-swarm check --json                  machine-readable result (same exit code)
npx i18n-swarm check --no-suppress           show the raw classifier with no FP-suppression
```

Exit code is 0 on pass, 1 on a new un-keyed string, so any CI that fails on a non-zero
step works, not just GitHub Actions. Needs Node 22.6+.

### Why it does not cry wolf

Run on a diff, the classifier alone is enough: a developer adds one string and the gate
points at it. Run across a whole codebase the raw set is noisier (brand names, code
identifiers, decorative image alt, enum tokens, strings in files that never ship as
product copy), and a gate that fires on those gets turned off. So a suppression pass runs
after the classifier and demotes a flag from a hard failure to a soft note when it falls
into one of five buckets:

- **brand / proper noun**: the whole string is a product name or a social handle
  (`GitHub`, `Stripe`, `@mdo`). A sentence that merely mentions a brand (`Deploy to
  Vercel`) stays a real flag.
- **decorative**: text inside an `aria-hidden` / `role="presentation"` element, or an
  image `alt` that is a filename, an illustration or shape descriptor, or a logo.
- **code identifier**: a single token shaped like code, not prose (`camelCase`,
  multi-hump `PascalCase`, `kebab-case`, `SCREAMING_SNAKE`, a dotted member, a CSS variant
  token like `primary`, a breakpoint like `sm`/`2xl`). Bare all-caps words such as `OK` or
  `FAQ` are kept, since they are real copy.
- **dev-only path**: the string lives in an OG-image or other metadata route, a config
  file, a story, a test, a script, or a viewport indicator.
- **inline ignore**: a `// i18n-ignore` (or `{/* i18n-ignore */}`) comment on the line or
  the line above suppresses that one flag.

The pass is deliberately conservative: it only silences a flag it is confident about, so
real labels (`Sign In`, `Save`, `Active Generators`) are never suppressed. Brand, enum and
dev-path lists are extensible per project, so a team can pin its own product nouns and
demo-data tokens without editing code. Drop an `i18n-swarm.config.json` at the repo root:

```json
{
  "brands": ["Acme", "Initech"],
  "enums": ["tertiary"],
  "ignorePaths": ["(^|/)stories/", "\\.fixture\\.tsx$"]
}
```

Measured on a five-repo corpus, whole-codebase, against each repo's pristine HEAD, with an
independent ground-truth oracle written separately from the suppressor: generic suppression
(no per-project config) takes the corpus false-positive rate from 13.7% to 7.1% with zero
false-negatives (no real copy silenced, on every repo). The signal is per-repo: three of the
four genuine product apps land at 0%, and the fourth sits at 25%, which is the product's own
name and two utility-function names shown in a code grid. A one-line `brands` entry closes
those, taking the corpus rate to effectively 0. The residue that survives generic suppression
is a Bootstrap component-showcase repo whose page content genuinely is component names and
demo placeholder data, which the config handles. On real product code, the "a new hardcoded
string is a red check" gate is enforceable as a hard release-blocker without ever silencing
real copy. Re-run the measurement with `node test/fp-corpus-measure.ts`.

## The retrofit (the on-ramp)

Before the gate can judge a codebase it needs the keys to exist. The retrofit is the
one-time pass that creates them: point it at a repository and it finds the hardcoded UI
strings, writes the locale files, rewrites the components to use translation keys, wires
the framework's translation runtime, then installs, builds and tests the project to prove
it did not break anything.

The verdict is backed by a real `next build`, not a self-graded parse. That is the part
most tools leave to you, and it is what earns the "safe to merge" claim: in testing the
build gate caught a malformed edit that a lightweight in-process parse check missed
entirely, and it caught a binding bug that every static check passed.

```
npx i18n-swarm <dir>           the full pass: baseline, apply, verify, verdict
npx i18n-swarm detect  <dir>   inspect framework / components / scripts / existing i18n
npx i18n-swarm extract <dir>   classify the UI strings and write the catalog (no changes)
npx i18n-swarm apply   <dir>   rewire the components and scaffold the i18n runtime (mutates)
npx i18n-swarm verify  <dir>   install + build + test the current state
npx i18n-swarm audit   <dir>   read-only readiness report (no app changes)
```

The full pass writes the catalog, the locale files, a verdict card and an HTML report
under `.i18nswarm/` in the target repo. It aborts on a repo that already has i18n rather
than fight an existing setup.

Across an eight-app Next.js App-Router corpus (popular shadcn / Vercel / Magic UI starters
and dashboards) the share of localizable strings the agent wires on its own runs from about
49% to 95% per app, averaging 76.9%, depending on how much of the copy is clean labels
versus prose with inline markup and interpolation. Corruptions stayed at zero across all ten
apps tested (1447 edits applied), and every build-viable app reached a green `next build`
after the rewrite (8 of 8). The plain-React path was verified the same way on three
unmodified Vite/CRA apps, and the Vue path on a real vue-i18n target. What is left for a
human is genuine human work: prose that needs splitting, and the Japanese itself.

Translation quality is deliberately out of scope. `ja.json` is seeded with the English
source as a fallback and a `translation-todo.json` manifest is written for a human or an MT
pass to fill in. Auto-translating Japanese is the one place this should not be trusted
without review.

## How the retrofit works

The hard part is not translating words. It is deciding which strings are real UI copy,
rewriting the markup without corrupting it, and proving the app still works. The agent
parses each component into a real AST (`@vue/compiler-sfc` for Vue, the TypeScript compiler
for JSX/TSX) and sorts every text node, attribute and prop into three buckets:

- **HIGH**: a clean label, a user-facing attribute (`placeholder`, `alt`, `title`,
  `aria-label`), or a display-copy prop (`label`, `heading`, `description`, `caption`, ...)
  whose value reads like prose. Safe to rewrite, so it does.
- **AMBIGUOUS**: natural-language copy that cannot be rewritten safely on its own, such as
  a sentence with an inline link, an interpolated phrase (`{count} items`), or a string prop
  whose name and value leave it genuinely unclear whether it is copy. Extracted to a review
  list, never touched.
- **SKIP**: not copy at all. Interpolations, numbers and percentages, version and id tokens,
  icon-font ligatures (where the text is the glyph), the contents of `<code>`/`<pre>` blocks,
  and component config that only looks like a string (style enums `variant="primary"`,
  `data-*` slots, class lists, urls, css values, chart data keys). These stay out of the
  review queue instead of cluttering it.

Rewrites are offset-surgical. Each edit is checked against the live source before it is
applied, and the rewritten file is re-parsed, so a bad edit is reverted rather than allowed
to mangle the file. This is the same extract-and-classify engine the gate runs on, which is
why the gate and the retrofit agree on what counts as a user-facing string.

For Next.js, the binding is the part standard tools get wrong, and the trap is the
`'use client'` directive. A file with no directive of its own is not necessarily a Server
component: when a Client component imports it, it runs on the client, and a server-only
`await getTranslations()` crashes the prerender there. So the agent binds on async-ness
instead. `useTranslations()` works in Client components and in synchronous Server
components, so it is the safe binding everywhere; only an already-async component gets
`await getTranslations()`. Nothing is made async. Messages are written nested, because
next-intl resolves a dotted key against a nested object and silently returns the key itself
for a flat one.

The framework wiring is scaffolded, not left as a note: the `createNextIntlPlugin` wrap in
`next.config` (CommonJS or ESM), the `i18n/request.ts` request config, and the
`NextIntlClientProvider` around the root layout's `<body>`. Each is AST-located and
reparse-verified, and an unexpected config or layout shape is left for review rather than
edited blind.

Plain React (a Vite or Create React App project with no server/client split) is the simpler
case. There is no async server component, so every binding is the one client-side hook
`useTranslation()`. The runtime is wired at the app entry: the agent finds the
`createRoot(...).render(...)` (or `ReactDOM.render`) call, adds `import './i18n'`, and wraps
the mounted root element in `<I18nextProvider i18n={i18n}>`. A TypeScript project that does
not enable `resolveJsonModule` would fail to typecheck a JSON import, so for those the locale
resources are inlined into the init module instead; everywhere else the standard
`en.json` / `ja.json` import is used.

## Versus i18next-cli

The obvious objection: isn't this i18next-cli's `instrument`? The wrapping does overlap, and
i18next-cli is the official, free, broader, better-maintained tool. If you are on
react-i18next and Locize, use it. i18n-swarm's edge is narrower and specific. After it
rewrites it runs your real `next build` and reverts any edit that will not re-parse, where
i18next-cli writes the transform unconditionally and, in its own README, is "not an automated
compiler". It scaffolds the next-intl server/client wiring that `instrument` explicitly leaves
for you to fix by hand. And its CI gate is diff-scoped, so it fails on the newly added string
rather than on every hardcoded string already in the tree. There is no CJK technical edge on
either side; both only handle multibyte offsets, and i18n-swarm's one Japanese-specific move
is to refuse to machine-translate `ja`.

## What generalizes, and what does not

Run across real English-only apps with no i18n (Next.js, Vue 3, and plain React on Vite and
CRA) the classifier and the rewrite held up: zero corruptions in every app, and the
already-localized apps were correctly refused. What does not generalize is a single
auto-handled number. The conservative call, never split a mixed sentence and never auto-wrap
an interpolated phrase, is what holds corruptions at zero, and it is also what caps the share
the agent can handle on its own. App-specific shapes still fall to the review queue by design
rather than risk a broken app: `[locale]` routing, a client-component root layout (where the
safe next-intl wiring needs a server boundary the agent will not invent), an unusual export,
and HIGH strings that live in react-table column callbacks or module-level icon objects where
a translation hook cannot go.

## License

MIT. Author: greymoth. Issues and source: https://github.com/greymoth-jp/i18n-swarm
