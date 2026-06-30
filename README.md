# i18n-swarm

A localization drift gate for web apps that ship in English. The job it does over and
over is a CI check: `check` fails a pull request the moment someone adds a new hardcoded
user-facing string outside the translation runtime, and prints the keyed fix as a
ready-to-apply patch, so a localization regression never reaches production. It runs on
the diff, not the whole tree, so it flags only the string the PR just added.

Before that gate can judge your code it has to learn your keys, and that is the one-time
retrofit: point it at a repository and it finds the hardcoded UI strings, writes the
locale files, rewrites the components to use translation keys, wires the framework's
translation runtime, then installs, builds and tests the project to prove it did not
break anything. The verdict is backed by a real `next build`, not a self-graded parse,
which is the part most tools leave to you.

The primary target is Next.js (App Router) with next-intl, which is where the
Server-vs-Client split makes a general-purpose translation tool struggle. It also
handles Vue 3 with vue-i18n and plain React with react-i18next. The classifier core is
the same across all three; only the rewrite syntax, the binding, and the scaffold differ.

It shares its run-and-verify engine with `vue2-eol-guard`: the same shell runner, the
same test-output parser, and the same idea that a change is only trustworthy once the
build and the existing tests survive it.

## Versus i18next-cli

The obvious objection: isn't this i18next-cli's `instrument`? The wrapping does overlap,
and i18next-cli is the official, free, broader, better-maintained tool. If you are on
react-i18next and Locize, use it. i18n-swarm's edge is narrower and specific. After it
rewrites it runs your real `next build` and reverts any edit that won't re-parse, where
i18next-cli writes the transform unconditionally and, in its own README, is "not an
automated compiler". It scaffolds the next-intl server/client wiring that `instrument`
explicitly leaves for you to fix by hand. And its CI gate is diff-scoped, so it fails on
the newly added string rather than on every hardcoded string already in the tree. There
is no CJK technical edge on either side; both only handle multibyte offsets, and
i18n-swarm's one Japanese-specific move is to refuse to machine-translate `ja`.

## What it actually does

The hard part is not translating words. It is deciding which strings are real UI copy,
rewriting the markup without corrupting it, and proving the app still works. The agent
parses each component into a real AST (`@vue/compiler-sfc` for Vue, the TypeScript
compiler for JSX/TSX) and sorts every text node, attribute and prop into three buckets:

- **HIGH** — a clean label, a user-facing attribute (`placeholder`, `alt`, `title`,
  `aria-label`), or a display-copy prop on a component (`label`, `heading`, `description`,
  `caption`, ...) whose value reads like prose. Safe to rewrite, so it does.
- **AMBIGUOUS** — natural-language copy that cannot be rewritten safely on its own: a
  sentence with an inline link in it, an interpolated phrase (`{count} items`), or a
  string prop whose name and value leave it genuinely unclear whether it is copy.
  Extracted to a review list, never touched.
- **SKIP** — not copy at all: interpolations, numbers and percentages, version and id
  tokens, icon-font ligatures (`material-icons`/`material-symbols`, where the text *is*
  the glyph), the contents of `<code>`/`<pre>` blocks, and component config that only
  looks like a string — style enums (`variant="primary"`, `size="sm"`), `data-*` slots,
  class lists, urls and css values, recharts data keys. These never carry localizable
  copy, so they stay out of the review queue instead of cluttering it.

Rewrites are offset-surgical. Each edit is checked against the live source before it is
applied, and the rewritten file is re-parsed, so a bad edit is reverted rather than
allowed to mangle the file.

For Next.js, the binding is the part that standard tools get wrong, and the trap is the
`'use client'` directive. A file with no directive of its own is not necessarily a Server
component: when a Client component imports it, it runs on the client, and the server-only
`await getTranslations()` crashes the prerender there. So the agent binds on async-ness
instead. `useTranslations()` works in Client components and in synchronous Server
components, so it is the safe binding everywhere; only an already-async component gets
`await getTranslations()`. Nothing is made async. It injects this for the common component
shapes (block-bodied function or arrow components) and leaves the rest — arrow expression
bodies, files that already wire their own `t`, copy that lives outside a component — in
the review queue, untouched. Messages are written nested, because next-intl resolves a
dotted key against a nested object and silently returns the key itself for a flat one.

The framework wiring is scaffolded, not left as a note: the `createNextIntlPlugin` wrap in
`next.config` (CommonJS or ESM), the `i18n/request.ts` request config, and the
`NextIntlClientProvider` around the root layout's `<body>`. Each is AST-located and
reparse-verified, and an unexpected config or layout shape is left for review rather than
edited blind.

Plain React — a Vite or Create React App project with no server/client split — is the
simpler case. There is no async server component, so every binding is the one client-side
hook: `useTranslation()`, injected into each block-bodied component that owns a rewritten
string. The runtime is wired at the app entry the same surgical way as the Next layout: the
agent finds the `createRoot(...).render(...)` (or `ReactDOM.render`) call, adds
`import './i18n'` so the init module runs, and wraps the mounted root element in
`<I18nextProvider i18n={i18n}>`. The init module disables `keySeparator`/`nsSeparator` so the
agent's flat dotted keys resolve as literal lookups, and turns `useSuspense` off because the
locale resources are inlined and load synchronously. One detail decides how the locales are
emitted: a TypeScript project that does not enable `resolveJsonModule` would fail to typecheck
a JSON import, so for those the resources are written directly into the init module instead;
everywhere else the standard `en.json` / `ja.json` import is used. An entry whose render shape
the agent does not recognise is left for review with the init still scaffolded.

Translation quality is deliberately out of scope. `ja.json` is seeded with the English
source as a fallback and a `translation-todo.json` manifest is written for a human or an
MT pass to fill in. Auto-translating Japanese is the one place this should not be
trusted without review.

## Commands

```
npx i18n-swarm <dir>           the full pass: baseline, apply, verify, verdict
npx i18n-swarm detect  <dir>   inspect framework / components / scripts / existing i18n
npx i18n-swarm extract <dir>   classify the UI strings and write the catalog (no changes)
npx i18n-swarm apply   <dir>   rewire the components and scaffold the i18n runtime (mutates)
npx i18n-swarm verify  <dir>   install + build + test the current state
```

Needs Node 22.6+. The full pass writes the catalog, the locale files, a verdict card and
an HTML report under `.i18nswarm/` in the target repo.

## The drift gate

The full pass is a one-time migration. `check` is what keeps a codebase localized after
it: a CI step that fails a diff which adds a new hardcoded user-facing string outside the
translation runtime, with the keyed fix printed as a ready-to-apply patch. It reuses the
same extract-and-classify engine, so the gate and the migration agree on what counts.

```
npx i18n-swarm check                       working tree vs HEAD
npx i18n-swarm check <base>..<head>         a specific range
npx i18n-swarm check --files=a.tsx,b.vue    explicit files (whole file treated as new)
```

Run on a diff, the classifier alone is enough — a developer adds one string and the gate
points at it. Run across a whole codebase the raw HIGH set is noisier: brand names, code
identifiers, decorative image alt, enum tokens and strings that live in files that never
ship as product copy. A gate that fires on those gets turned off, so a suppression pass
runs after the classifier and demotes a flag from a hard failure to a soft note when it
falls into one of five buckets:

- **brand / proper noun** — the whole string is a product name or a social handle
  (`GitHub`, `Stripe`, `@mdo`, `Clerk logo`). A sentence that merely mentions a brand
  (`Deploy to Vercel`) is left as a real flag.
- **decorative** — text inside an `aria-hidden` / `role="presentation"` element, or an
  image `alt` that is a filename, an illustration or shape descriptor, a carousel slide
  label, or a logo.
- **code identifier** — a single token shaped like code, not prose: `camelCase`,
  multi-hump `PascalCase`, `kebab-case`, `SCREAMING_SNAKE`, a dotted member, a CSS
  variant token (`primary`), or a breakpoint (`sm`, `2xl`). Bare all-caps words such as
  `OK` or `FAQ` are kept — they are real copy.
- **dev-only path** — the string lives in an OG-image or other metadata route, a config
  file, a story, a test, a script, or a viewport indicator.
- **inline ignore** — a `// i18n-ignore` (or `{/* i18n-ignore */}`) comment on the line
  or the line above suppresses that one flag.

The pass is deliberately conservative: it only silences a flag it is confident about, so
real labels (`Sign In`, `Save`, `Active Generators`) are never suppressed. Run
`--no-suppress` to see the raw classifier output.

Brand, enum and dev-path lists are extensible per project, so a team can pin its own
product nouns and demo-data tokens without editing code. Drop an `i18n-swarm.config.json`
at the repo root:

```json
{
  "brands": ["Acme", "Initech"],
  "enums": ["tertiary"],
  "ignorePaths": ["(^|/)stories/", "\\.fixture\\.tsx$"]
}
```

## What generalizes, and what does not

Run across real English-only apps with no i18n — Next.js, Vue 3, and plain React on Vite
and CRA — the classifier and the rewrite held up: zero corruptions in every app, and the
already-localized apps were correctly refused. What does not generalize is a single
auto-handled number. Across an eight-app Next.js App-Router evidence corpus (the popular
shadcn/Vercel/Magic UI starters and dashboards) the share of localizable strings the agent
wires on its own runs from about 49% to 95% per app, averaging 76.9%, depending on how much
of the copy is clean labels versus prose with inline markup and interpolation. The
conservative call — never split a mixed sentence, never auto-wrap an interpolated phrase —
is what keeps corruptions at zero, and it is what caps the share. The classifier also keeps
component configuration out of the count entirely: style enums (`variant`, `size`), `data-*`
slots, class lists, urls, css values and chart data keys are not localizable copy, so they
are neither rewritten nor parked in the review queue.

The plain-React path was verified the same way: a full pass on three unmodified Vite/CRA
apps with no i18n reached a green build after the rewrite, with zero corruptions in each.
A large React-Bootstrap dashboard took 1466 keys across 55 files (45.7% auto-handled); a
Material UI admin app, which is mostly interpolated prose, took 7 (7.5%); the stock Vite
react-ts template took 7 (43.8%). Two ran the TypeScript build (`tsc -b && vite build`) and
one the JavaScript build, exercising both the inlined-resources path and the JSON-import
path. A fourth candidate was dropped because its own baseline build was already red on a
deprecated `tsconfig` option — the gate refuses to claim a green it did not produce.

The build gate is the trust mechanism, and it earns it: in testing it caught a malformed
edit that a lightweight in-process parse check missed entirely, and it caught the binding
bug above that every static check passed. A single-file parse is a useful pre-filter but
not a substitute for the real compile. For the common next-intl App-Router case (single
locale, no routing, a standard root layout) the full pass lands green and merge-ready: every
one of the eight build-viable corpus apps reaches a green `next build` after the rewrite,
with zero corruptions across all of them (1447 edits applied, none skipped), and what is left
for a human is only prose that needs splitting and the Japanese itself. App-specific shapes —
i18n routing, a client-component root layout (where the safe next-intl wiring needs a server
boundary the agent will not invent), an unusual export — still fall to the review queue by
design rather than risk a broken app.

## License

MIT.
