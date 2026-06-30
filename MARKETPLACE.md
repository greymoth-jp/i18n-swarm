# i18n-swarm — GitHub Marketplace listing

This file is the prep for a GitHub Action listing. It is not published yet; the
publish steps are at the bottom and are an operator action.

The action (`action.yml` at the repo root) is a thin wrapper around the existing
`i18n-swarm check` drift-gate. It adds no new detection: it runs the same check the
CLI already ships, derives the PR diff range from the event, and fails the job when a
new hardcoded UI string is added without a translation key.

## Listing

- **Name:** i18n-swarm localization drift gate
- **Tagline (one line):** Fail the pull request when a new hardcoded UI string is added without a translation key (Next.js / React / Vue).
- **Categories:** Continuous integration · Code quality
- **Branding:** icon `globe`, color `gray-dark` (set in `action.yml`). `check-circle` is the alternative icon if the gate framing is preferred over the localization framing.

## What a user pastes

```yaml
# .github/workflows/i18n-drift-gate.yml
name: i18n drift gate
on:
  pull_request:

jobs:
  i18n-swarm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the gate diffs base..head, so both commits must be present
      - uses: greymoth-jp/i18n-swarm@v1
        with:
          path: .                 # app root; omit to use the repository root
          # config: i18n-swarm.config.json   # optional brands / enums / ignorePaths
```

`fetch-depth: 0` matters. The gate is diff-scoped: it asks "what strings did this PR
add?", so it needs the base commit as well as the head. With the default shallow
checkout (`fetch-depth: 1`) the base commit is absent and the diff cannot be computed.

To make it a hard release-blocker, mark the `i18n-swarm` job as a required status check
in branch protection.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Directory to check (the app root). |
| `config` | (none) | Path to an `i18n-swarm.config.json` (brands / enums / ignorePaths). If set, it is copied to `<path>/i18n-swarm.config.json` so the check picks it up; otherwise the check auto-discovers one at the repo root. |
| `range` | (derived) | Explicit git range `<base>..<head>`. If empty: `pull_request` -> base..head, `push` -> before..after, otherwise working tree vs HEAD. |
| `version` | `latest` | npm version or dist-tag of `i18n-swarm` to run. Pin it (for example `0.1.0`) for reproducible CI. |

## What it does / does not

- **Does:** run `i18n-swarm check` over the PR diff; exit non-zero on a new un-keyed
  user-facing string; print the keyed fix as a suggested patch. Brand names, code
  identifiers, decorative alt text and config-only strings are demoted to non-blocking
  notes (the same suppression the CLI uses), so it fires on real copy, not on
  `variant="primary"`.
- **Does not:** add any detection the CLI does not already have, translate anything, or
  scaffold an i18n runtime. The one-time retrofit (`npx i18n-swarm ./your-app`) is a
  separate, manual step, not part of this action.

## Operator publish steps (not done here)

Publishing to the GitHub Marketplace is a manual, account-bound step:

1. The action must live in a **public** repository with `action.yml` at the **repository
   root**. Create/point the public repo `greymoth-jp/i18n-swarm` and push this repo's
   contents (the `greymoth-jp/i18n-swarm@v1` reference in the example assumes that name).
2. On the repo's main page, GitHub shows a **"Publish this Action to the GitHub
   Marketplace"** banner. Open it, accept the **GitHub Marketplace Developer Agreement**,
   and pick the categories **Continuous integration** and **Code quality**.
3. The listing validates `action.yml` (name unique across the Marketplace, valid
   `branding.icon` / `branding.color`, description present).
4. **Draft a release with a tag** (for example `v1.0.0`) and tick **"Publish this Action
   to the GitHub Marketplace"** on the release form. The tag is what `@v1` resolves to.
5. After release, move the `v1` major tag to the release commit so `@v1` keeps working:
   `git tag -f v1 v1.0.0 && git push -f origin v1`.

Until step 4, the listing stays a draft and the example workflow above will not resolve.
