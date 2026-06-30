import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCheck, unifiedDiff } from "../src/check.ts";

let n = 0;
function check(name: string, fn: () => void) { fn(); n++; process.stdout.write(Buffer.from(`  ok  ${name}\n`, "utf8")); }

// ---------------------------------------------------------------------------
// 1. unifiedDiff: a keyed-fix replacement produces a valid single-line hunk
// ---------------------------------------------------------------------------
check("unifiedDiff: in-line replacement yields one - / + pair", () => {
  const a = "line one\n<h1>Welcome</h1>\nline three\n";
  const b = "line one\n<h1>{t('p.welcome')}</h1>\nline three\n";
  const d = unifiedDiff(a, b, "Page.tsx");
  assert.match(d, /^--- a\/Page\.tsx$/m);
  assert.match(d, /^\+\+\+ b\/Page\.tsx$/m);
  assert.match(d, /^-<h1>Welcome<\/h1>$/m);
  assert.match(d, /^\+<h1>\{t\('p\.welcome'\)\}<\/h1>$/m);
  assert.ok(!/^[-+]line three$/m.test(d), "unchanged context line is not marked changed");
});
check("unifiedDiff: identical input -> empty diff", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "x.tsx"), "");
});

// ---------------------------------------------------------------------------
// 2. end-to-end on a throwaway git repo (real diffs, real git plumbing)
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "i18nswarm-check-"));
const g = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
function write(rel: string, body: string) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
}
try {
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("config", "commit.gpgsign", "false");

  // baseline: a properly-keyed client component (already i18n'd) + one pre-existing
  // hardcoded string we will leave untouched (must NOT be flagged later).
  write("src/Page.tsx",
    "'use client'\n" +
    "import { useTranslations } from 'next-intl';\n" +
    "export default function Page() {\n" +
    "  const t = useTranslations();\n" +
    "  return (\n" +
    "    <div>\n" +
    "      <h1>{t('page.title')}</h1>\n" +
    "      <button>Existing Save</button>\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();

  // HEAD-A: a developer adds a NEW hardcoded UI string + edits an unrelated line.
  g("checkout", "-qb", "feat-bad");
  write("src/Page.tsx",
    "'use client'\n" +
    "import { useTranslations } from 'next-intl';\n" +
    "export default function Page() {\n" +
    "  const t = useTranslations();\n" +
    "  return (\n" +
    "    <div>\n" +
    "      <h1>{t('page.title')}</h1>\n" +
    "      <p>Welcome to our store</p>\n" +   // NEW hardcoded UI string
    "      <button>Existing Save</button>\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n");
  g("add", "-A");
  g("commit", "-qm", "add hardcoded string");
  const headBad = g("rev-parse", "HEAD").trim();

  check("FAIL: a new hardcoded UI string is flagged with a keyed-fix diff", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headBad}` });
    assert.equal(res.pass, false, "gate must fail");
    assert.equal(res.totalFlags, 1, "exactly the one new string");
    const fl = res.files[0].flags[0];
    assert.equal(fl.text, "Welcome to our store");
    assert.equal(fl.tag, "p");
    assert.match(res.files[0].suggestedDiff, /\+\s*<p>\{t\('page\.welcome_to_our_store'\)\}<\/p>/);
  });

  check("the PRE-EXISTING hardcoded string ('Existing Save') is NOT flagged", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headBad}` });
    const texts = res.files.flatMap((f) => f.flags.map((x) => x.text));
    assert.ok(!texts.includes("Existing Save"), "only newly-added lines fail, not old debt");
  });

  // HEAD-B: a developer adds ONLY keyed UI + non-UI strings (const / test / css class).
  g("checkout", "-qf", base);
  g("checkout", "-qb", "feat-good");
  write("src/Page.tsx",
    "'use client'\n" +
    "import { useTranslations } from 'next-intl';\n" +
    "export default function Page() {\n" +
    "  const t = useTranslations();\n" +
    "  const MODE = 'production';\n" +              // non-UI const string
    "  return (\n" +
    "    <div className=\"hero large\">\n" +          // class attr: never copy
    "      <h1>{t('page.title')}</h1>\n" +
    "      <p>{t('page.welcome')}</p>\n" +           // properly keyed new UI
    "      <button>Existing Save</button>\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n");
  write("src/Page.test.tsx", "it('renders', () => { render(<div>Hello test world</div>); });\n");
  g("add", "-A");
  g("commit", "-qm", "keyed + non-ui only");
  const headGood = g("rev-parse", "HEAD").trim();

  check("PASS: keyed strings, const strings, class attrs, and test files raise no failure", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headGood}` });
    assert.equal(res.pass, true, `expected PASS, got flags: ${JSON.stringify(res.files.flatMap((f) => f.flags))}`);
    assert.equal(res.totalFlags, 0);
  });

  check("--files mode: whole file treated as added (flags ALL hardcoded strings, incl. legacy)", () => {
    const res = runCheck({ repo: tmp, files: ["src/Page.tsx"] });
    // no git range: every HIGH in the file fires, so the carried-over legacy button is caught.
    assert.equal(res.totalFlags, 1);
    assert.equal(res.files[0].flags[0].text, "Existing Save");
  });

  // Vue path
  g("checkout", "-qf", base);
  g("checkout", "-qb", "feat-vue");
  write("src/Card.vue",
    "<template>\n" +
    "  <div>\n" +
    "    <span>Brand new label</span>\n" +
    "  </div>\n" +
    "</template>\n");
  g("add", "-A");
  g("commit", "-qm", "vue hardcoded");
  const headVue = g("rev-parse", "HEAD").trim();
  check("Vue FAIL: new SFC hardcoded text flagged with a $t() fix", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headVue}` });
    assert.equal(res.pass, false);
    assert.equal(res.totalFlags, 1);
    assert.equal(res.files[0].flags[0].text, "Brand new label");
    assert.match(res.files[0].suggestedDiff, /\$t\('card\.brand_new_label'\)/);
  });

  // suppression: a diff that adds noise (brand label + code token) next to one real string
  // must fail on ONLY the real string; the noise is demoted to soft notes, not failures.
  g("checkout", "-qf", base);
  g("checkout", "-qb", "feat-noise");
  write("src/Promo.tsx",
    "export default function Promo() {\n" +
    "  return (\n" +
    "    <div>\n" +
    "      <span>GitHub</span>\n" +              // brand -> suppressed
    "      <code className=\"x\">useScroll</code>\n" + // inside <code> -> not even a candidate
    "      <button>primary</button>\n" +          // lower-case enum token -> suppressed (codeish)
    "      <h2>Start your free trial</h2>\n" +     // REAL copy -> the only failure
    "    </div>\n" +
    "  );\n" +
    "}\n");
  // an OG-image route in the same diff: its text is dev-only, never a release-blocker
  write("app/opengraph-image.tsx",
    "export default function OG() { return (<div><h1>My Brand</h1></div>); }\n");
  g("add", "-A");
  g("commit", "-qm", "noise + one real string");
  const headNoise = g("rev-parse", "HEAD").trim();

  check("SUPPRESS: gate fails only on the real string; brand/enum/og-image demoted to soft notes", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headNoise}` });
    assert.equal(res.totalFlags, 1, `only the real string should fail; got ${JSON.stringify(res.files.flatMap((f) => f.flags.map((x) => x.text)))}`);
    const failed = res.files.flatMap((f) => f.flags.map((x) => x.text));
    assert.deepEqual(failed, ["Start your free trial"]);
    assert.ok(res.totalSuppressed >= 3, `brand + enum + og-image suppressed (got ${res.totalSuppressed})`);
    assert.ok(res.suppressedByBucket.brand >= 1 && res.suppressedByBucket.codeish >= 1 && res.suppressedByBucket.devpath >= 1);
    assert.equal(res.pass, false);
  });

  check("SUPPRESS: --no-suppress restores the raw classifier (noise counts as failures again)", () => {
    const res = runCheck({ repo: tmp, range: `${base}..${headNoise}`, noSuppress: true });
    assert.ok(res.totalFlags > 1, "without suppression the brand/enum/og-image strings fail too");
    assert.equal(res.totalSuppressed, 0);
  });
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(Buffer.from(`\nCHECK SELFCHECK PASSED: ${n} checks\n`, "utf8"));
