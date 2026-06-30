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
