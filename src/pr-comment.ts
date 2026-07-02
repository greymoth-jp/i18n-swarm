// The PR-comment surface: turn a `check` result into the sticky comment body a reviewer
// actually sees on the pull request. The exit-code gate (check.ts) is necessary but silent
// -- CI logs are not where a diff gets read -- so a violation that never becomes a comment
// is a violation nobody discovers the tool from. This module is a pure formatter: it takes
// a CheckResult and returns markdown, with no knowledge of the GitHub API. The composite
// action (action.yml) owns finding/creating/updating/deleting the actual comment; it just
// needs this string (or `null`, meaning "nothing to say, remove any prior comment").

import type { CheckResult } from "./check.ts";

/** Hidden at the top of the comment body so a later run can find and update its own
 *  comment instead of piling up a new one on every push (GitHub renders HTML comments
 *  as nothing, so this never shows up to a reviewer). */
export const PR_COMMENT_MARKER = "<!-- i18n-swarm:pr-comment -->";

const REPO_URL = "https://github.com/greymoth-jp/i18n-swarm";

/** Pull the first removed/added line pair out of a unified diff -- the smallest possible
 *  "here is what changes" example, without dumping the whole hunk into the comment. */
function firstBeforeAfter(diff: string): { before: string; after: string } | null {
  let before: string | null = null;
  let after: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (before === null && line.startsWith("-")) { before = line.slice(1).trim(); continue; }
    if (before !== null && after === null && line.startsWith("+")) { after = line.slice(1).trim(); break; }
  }
  return before !== null && after !== null ? { before, after } : null;
}

/**
 * Build the sticky PR-comment markdown for a `check` result.
 * Returns `null` when the diff is clean (`res.totalFlags === 0`) -- the caller should
 * then delete/collapse any comment a prior, now-fixed run left behind, not post a
 * "you're fine" comment nobody needs.
 */
export function buildPrComment(res: CheckResult): string | null {
  if (res.totalFlags === 0) return null;

  const flagged = res.files.filter((f) => f.flags.length > 0);
  const plural = res.totalFlags === 1 ? "" : "s";

  const rows = flagged.map((f) => `| \`${f.file}\` | ${f.flags.length} |`).join("\n");

  const exampleFile = flagged.find((f) => f.suggestedDiff);
  const example = exampleFile ? firstBeforeAfter(exampleFile.suggestedDiff) : null;

  const lines: string[] = [
    PR_COMMENT_MARKER,
    `### i18n-swarm: ${res.totalFlags} new un-keyed UI string${plural}`,
    "",
    "This PR adds user-facing text with no translation key attached:",
    "",
    "| file | new strings |",
    "| --- | --- |",
    rows,
  ];

  if (example) {
    lines.push(
      "",
      `**example fix** — \`${exampleFile!.file}\`:`,
      "```diff",
      `- ${example.before}`,
      `+ ${example.after}`,
      "```",
    );
  }

  lines.push(
    "",
    "Run `npx i18n-swarm check` locally for the full suggested diff on every flagged string.",
    "",
    `<sub>checked by [i18n-swarm](${REPO_URL})</sub>`,
  );

  return lines.join("\n") + "\n";
}
