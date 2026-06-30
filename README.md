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

For Next.js, the binding is the part that standard tools get wrong. A Client component
needs `useTranslations()`; a Server component needs `await getTranslations()` and has to
become async. The agent injects the right one for the common component shapes
(block-bodied function or arrow components) and leaves the rest — arrow expression
bodies, files that already wire their own `t`, copy that lives outside a component — in
the review queue, untouched. Messages are written nested, because next-intl resolves a
dotted key against a nested object and silently returns the key itself for a flat one.

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

The build-and-test gate is the trust mechanism, and it earns it: in testing it caught a
malformed edit that a lightweight in-process parse check missed entirely. A single-file
parse is a useful pre-filter but not a substitute for the real compile. So the honest
shape of the tool is a safe subset behind a build gate: extract, classify, write the
catalog, rewrite the call sites it is sure about, wire the binding for the common
component shapes, and hand everything else — prose that needs splitting, unusual
component shapes, the framework config and provider wiring, and the Japanese itself — to
a review queue.

## License

MIT.
