# i18n-swarm

A localization agent for English-only Vue 3 apps. Point it at a repository and it does
the code-side i18n on its own: finds the hardcoded UI strings, wires up vue-i18n,
writes the locale files, rewrites the components to use translation keys, then installs,
builds and tests the project to check it did not break anything.

It shares its run-and-verify engine with `vue2-eol-guard`: the same shell runner, the
same test-output parser, and the same idea that a change is only trustworthy once the
build and the existing tests survive it.

## What it actually does

The hard part is not translating words. It is deciding which strings are real UI copy,
rewriting the markup without corrupting it, and proving the app still works. The agent
parses each `.vue` file into a real template AST (via `@vue/compiler-sfc`) and sorts
every text node and attribute into three buckets:

- **HIGH** — a clean label or a user-facing attribute (`placeholder`, `alt`, `title`,
  `aria-label`). Safe to rewrite, so it does.
- **AMBIGUOUS** — natural-language copy that cannot be rewritten safely on its own: a
  sentence with inline links in it, or a string prop on a child component. Extracted to
  a review list, never touched.
- **SKIP** — not copy at all: interpolations, numbers and percentages, icon-font
  ligatures (`material-icons`/`material-symbols`, where the text *is* the glyph), and
  the contents of `<code>`/`<pre>` blocks.

Rewrites are offset-surgical. Each edit is checked against the live source before it is
applied, so a bad offset is skipped rather than allowed to mangle a file.

Translation quality is deliberately out of scope. `ja.json` is seeded with the English
source as a fallback and a `translation-todo.json` manifest is written for a human or an
MT pass to fill in. Auto-translating Japanese is the one place this should not be
trusted without review.

## Commands

```
node src/cli.ts detect  <dir>   inspect framework / SFCs / scripts / existing i18n
node src/cli.ts extract <dir>   classify the UI strings and write the catalog (no changes)
node src/cli.ts apply   <dir>   rewire the components and wire vue-i18n (mutates the app)
node src/cli.ts verify  <dir>   install + build + test the current state
node src/cli.ts run     <dir>   the full pass: baseline, apply, verify, verdict
```

Requires Node 22.6+ (the source runs as TypeScript directly). `npm run selfcheck` runs
the test suite; `npm run typecheck` type-checks the tool.

## Result on a real app

Run against a real English-only Vue 3 + Vite + Vitest project with no i18n, the agent
classified 126 candidate strings, auto-rewrote 69 of them across three components with
zero corruptions, wired vue-i18n end to end, and the project still built, type-checked
and passed its tests afterwards. The remaining third (prose with inline markup, a couple
of component props) was set aside for review, which is where it belongs.

So the mechanical, code-side work is something an agent can do behind a build-and-test
gate. The two things it cannot hand off are the prose that needs splitting and the
Japanese itself.

## License

MIT.
