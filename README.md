# i18n-swarm

A localization agent for English-only web apps. Point it at a repository and it does
the code-side i18n on its own: it finds the hardcoded UI strings, writes the locale
files, rewrites the components to use translation keys, wires the framework's
translation runtime, then installs, builds and tests the project to check it did not
break anything.

The primary target is Next.js (App Router) with next-intl, which is where the
Server-vs-Client split makes a general-purpose translation tool struggle. It also
handles Vue 3 with vue-i18n and plain React with react-i18next. The classifier core is
the same across all three; only the rewrite syntax, the binding, and the scaffold differ.

It shares its run-and-verify engine with `vue2-eol-guard`: the same shell runner, the
same test-output parser, and the same idea that a change is only trustworthy once the
build and the existing tests survive it.

## What it actually does

The hard part is not translating words. It is deciding which strings are real UI copy,
rewriting the markup without corrupting it, and proving the app still works. The agent
parses each component into a real AST (`@vue/compiler-sfc` for Vue, the TypeScript
compiler for JSX/TSX) and sorts every text node, attribute and prop into three buckets:

- **HIGH** — a clean label or a user-facing attribute (`placeholder`, `alt`, `title`,
  `aria-label`). Safe to rewrite, so it does.
- **AMBIGUOUS** — natural-language copy that cannot be rewritten safely on its own: a
  sentence with an inline link in it, an interpolated phrase (`{count} items`), or a
  string prop on a child component. Extracted to a review list, never touched.
- **SKIP** — not copy at all: interpolations, numbers and percentages, version and id
  tokens, icon-font ligatures (`material-icons`/`material-symbols`, where the text *is*
  the glyph), and the contents of `<code>`/`<pre>` blocks.

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

Translation quality is deliberately out of scope. `ja.json` is seeded with the English
source as a fallback and a `translation-todo.json` manifest is written for a human or an
MT pass to fill in. Auto-translating Japanese is the one place this should not be
trusted without review.

## Commands

```
node src/cli.ts detect  <dir>   inspect framework / components / scripts / existing i18n
node src/cli.ts extract <dir>   classify the UI strings and write the catalog (no changes)
node src/cli.ts apply   <dir>   rewire the components and scaffold the i18n runtime (mutates)
node src/cli.ts verify  <dir>   install + build + test the current state
node src/cli.ts run     <dir>   the full pass: baseline, apply, verify, verdict
```

Requires Node 22.6+ (the source runs as TypeScript directly). `npm run selfcheck` runs
the test suite; `npm run typecheck` type-checks the tool.

## What generalizes, and what does not

Run across five real English-only apps with no i18n — three Next.js, one Vue 3, one
React — the classifier and the rewrite held up: zero corruptions in every app, and the
already-localized app was correctly refused. What does not generalize is a single
auto-handled number. The share of localizable strings the agent can wire on its own
ranges from about 35% to 85% per app, depending on how much of the copy is clean labels
versus prose with inline markup and interpolation. The conservative call — never split a
mixed sentence, never auto-wrap an interpolated phrase — is what keeps corruptions at
zero, and it is also what caps the auto-handled share.

The build gate is the trust mechanism, and it earns it: in testing it caught a malformed
edit that a lightweight in-process parse check missed entirely, and it caught the binding
bug above that every static check passed. A single-file parse is a useful pre-filter but
not a substitute for the real compile. For the common next-intl App-Router case (single
locale, no routing, a standard root layout) the full pass now lands green and merge-ready:
on `cruip/open-react-template` (99 strings, 13 files, 84.6%, 0 corruptions) and
`shadcn-ui/next-template` (12, 4, 66.7%, 0) the build is green, the prerendered HTML shows
real English on every route, and what is left for a human is only prose that needs
splitting and the Japanese itself. App-specific shapes — i18n routing, a client-component
layout, an unusual export — still fall to the review queue by design.

## License

MIT.
