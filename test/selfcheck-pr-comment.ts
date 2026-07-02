import assert from "node:assert/strict";
import { buildPrComment, PR_COMMENT_MARKER } from "../src/pr-comment.ts";
import type { CheckResult, FileCheck } from "../src/check.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }

function fileCheck(over: Partial<FileCheck>): FileCheck {
  return {
    file: "src/Page.tsx",
    flags: [],
    newAmbiguous: [],
    suppressed: [],
    suggestedDiff: "",
    parseError: null,
    ...over,
  };
}

function result(over: Partial<CheckResult>): CheckResult {
  return {
    repoRoot: "/repo",
    base: "abc123",
    head: "def456",
    filesScanned: 1,
    files: [],
    totalFlags: 0,
    totalSuppressed: 0,
    suppressedByBucket: { brand: 0, decorative: 0, codeish: 0, devpath: 0, directive: 0 },
    pass: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. a clean result produces no comment (nothing for a reviewer to read).
// ---------------------------------------------------------------------------
check("clean result (totalFlags 0) -> null, so the caller removes any stale comment", () => {
  const res = result({});
  assert.equal(buildPrComment(res), null);
});

// ---------------------------------------------------------------------------
// 2. a single violation: marker, count, table row, before/after example, attribution.
// ---------------------------------------------------------------------------
const oneFileDiff =
  "--- a/src/pricing.tsx\n" +
  "+++ b/src/pricing.tsx\n" +
  "@@ -5,7 +5,7 @@\n" +
  "    return (\n" +
  "      <section>\n" +
  "        <h2>{t('pricing.simple_pricing')}</h2>\n" +
  "-      <button>Start free trial</button>\n" +
  "+      <button>{t('pricing.start_free_trial')}</button>\n" +
  "      </section>\n" +
  "    );\n" +
  "  }\n";

check("marker is the first line (so the action can find/replace its own comment)", () => {
  const res = result({
    totalFlags: 1,
    pass: false,
    files: [fileCheck({
      file: "src/pricing.tsx",
      flags: [{ file: "src/pricing.tsx", line: 8, kind: "text", tag: "button", text: "Start free trial", key: "pricing.start_free_trial" }],
      suggestedDiff: oneFileDiff,
    })],
  });
  const body = buildPrComment(res)!;
  assert.equal(body.split("\n")[0], PR_COMMENT_MARKER);
});

check("singular count phrasing + file table row + before/after example + attribution link", () => {
  const res = result({
    totalFlags: 1,
    pass: false,
    files: [fileCheck({
      file: "src/pricing.tsx",
      flags: [{ file: "src/pricing.tsx", line: 8, kind: "text", tag: "button", text: "Start free trial", key: "pricing.start_free_trial" }],
      suggestedDiff: oneFileDiff,
    })],
  });
  const body = buildPrComment(res)!;
  assert.match(body, /1 new un-keyed UI string\b/, "singular, no trailing 's'");
  assert.match(body, /\|\s*`src\/pricing\.tsx`\s*\|\s*1\s*\|/, "file/count table row");
  assert.match(body, /-\s*<button>Start free trial<\/button>/, "before line from the suggested diff");
  assert.match(body, /\+\s*<button>\{t\('pricing\.start_free_trial'\)\}<\/button>/, "after line from the suggested diff");
  assert.match(body, /checked by \[i18n-swarm\]\(https:\/\/github\.com\/greymoth-jp\/i18n-swarm\)/, "attribution line");
});

// ---------------------------------------------------------------------------
// 3. multiple files: plural phrasing, one row per file, still one example only.
// ---------------------------------------------------------------------------
check("multiple files: plural phrasing + one table row per flagged file", () => {
  const res = result({
    totalFlags: 3,
    pass: false,
    files: [
      fileCheck({
        file: "src/pricing.tsx",
        flags: [
          { file: "src/pricing.tsx", line: 8, kind: "text", tag: "button", text: "Start free trial", key: "pricing.start_free_trial" },
          { file: "src/pricing.tsx", line: 9, kind: "text", tag: "p", text: "No card required", key: "pricing.no_card_required" },
        ],
        suggestedDiff: oneFileDiff,
      }),
      fileCheck({
        file: "src/Card.vue",
        flags: [{ file: "src/Card.vue", line: 3, kind: "text", tag: "span", text: "Brand new label", key: "card.brand_new_label" }],
      }),
    ],
  });
  const body = buildPrComment(res)!;
  assert.match(body, /3 new un-keyed UI strings\b/, "plural");
  assert.match(body, /\|\s*`src\/pricing\.tsx`\s*\|\s*2\s*\|/);
  assert.match(body, /\|\s*`src\/Card\.vue`\s*\|\s*1\s*\|/);
  // exactly one "example fix" block, not one per file
  const exampleCount = (body.match(/\*\*example fix\*\*/g) ?? []).length;
  assert.equal(exampleCount, 1);
});

// ---------------------------------------------------------------------------
// 4. no suggestedDiff anywhere (e.g. rewrite could not produce one) -> table still
//    renders, just no "example fix" section, and nothing throws.
// ---------------------------------------------------------------------------
check("no suggestedDiff available: table renders, example section is omitted, no crash", () => {
  const res = result({
    totalFlags: 1,
    pass: false,
    files: [fileCheck({
      file: "src/Weird.tsx",
      flags: [{ file: "src/Weird.tsx", line: 1, kind: "attr", attrName: "title", tag: "div", text: "Odd one", key: "weird.odd_one" }],
      suggestedDiff: "",
    })],
  });
  const body = buildPrComment(res)!;
  assert.match(body, /\|\s*`src\/Weird\.tsx`\s*\|\s*1\s*\|/);
  assert.ok(!body.includes("**example fix**"));
});

process.stdout.write(Buffer.from(`\nPR-COMMENT SELFCHECK PASSED: ${n} checks\n`, "utf8"));
