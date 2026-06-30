// False-positive re-measurement of the drift gate on the 5-repo corpus, whole-codebase mode.
// Run: `node test/fp-corpus-measure.ts` (needs the targets/ checkouts; reads each repo's
// pristine HEAD blobs, so prior tool runs against the targets do not skew the numbers).
//
// GROUND TRUTH = an independent "competent i18n reviewer" oracle written FRESH here (not
// importing the suppressor's predicates) so it can catch BOTH residual FPs the suppressor
// misses AND real copy the suppressor wrongly kills (FN). A flag is a FALSE POSITIVE when
// it is NOT translatable product copy: a brand/handle, a code identifier / enum / breakpoint,
// decorative image/aria-hidden text, a string in a dev-only file, or known demo placeholder
// data. Everything else (Home, Save, Sign In, sentences, real labels) is a TRUE POSITIVE.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectRepo } from "../src/detect.ts";
import { extractFile } from "../src/extract.ts";
import { extractJsxFile } from "../src/extract-jsx.ts";
import { assignKeys } from "../src/keys.ts";
import { classifySuppression, makeConfig, type SuppressConfig } from "../src/suppress.ts";
import type { Candidate, ExtractReport } from "../src/types.ts";

const ROOT = path.join(import.meta.dirname, "..", "targets");
const CORPUS = ["precedent", "dash-ui", "react-admin-dashboard", "open-react-template", "shadcn-next-template"];
const git = (root: string, a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const extractFor = (rel: string, src: string): ExtractReport => rel.endsWith(".vue") ? extractFile(rel, src) : extractJsxFile(rel, src);
const lc = (s: string) => s.toLowerCase();

// ---- independent oracle (human judgment, written fresh) ----------------------------
const ORACLE_BRANDS = new Set(["bootstrap", "vercel", "clerk", "github", "twitter", "precedent", "react", "vue", "cruip", "next.js", "stripe"]);
const ORACLE_DEMO = new Set(["otto", "mark", "jacob", "thornton", "larry", "larry the bird", "the bird", "cell"]); // bootstrap table demo data
const ORACLE_UTILFN = new Set(["capitalize", "truncate"]); // util-fn names listed in precedent's code grid
const ORACLE_VARIANTS = new Set(["primary", "secondary", "success", "danger", "warning", "info", "light", "dark", "muted"]);
const ORACLE_BREAKPOINTS = new Set(["xs", "sm", "md", "lg", "xl", "2xl", "xxl"]);
const oracleDevPath = (rel: string) => /(^|\/)(opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[jt]sx?$/.test(rel)
  || /\.(config|stories|test|spec)\.[jt]sx?$/.test(rel)
  || /(^|\/)(scripts?|stories|tests?|__tests__|e2e|mocks?|fixtures)\//.test(rel)
  || /tailwind-indicator|breakpoint/i.test(rel);
const oracleDecorativeAlt = (attr: string | undefined, t: string) => attr === "alt" && (
  /\.(png|jpe?g|svg|webp|gif)$/i.test(t) || /^(avatar|image description|background|placeholder)$/i.test(t)
  || /\b(illustration|shape)$/i.test(t) || /\blogo$/i.test(t) || /\bslide$/i.test(t));

// STRICT lens: a showcase/docs reviewer also treats single-word component-API names and
// capitalized variant/column-header demo labels as non-copy (this is the lens that pushes
// a component-showcase like dash-ui toward the PoC's ~32%).
const STRICT_LABELS = new Set([
  "modal","popover","tooltip","accordion","accordions","carousel","spinners","spinner","toasts","toast",
  "navs","nav","tabs","pills","pagination","progress","offcanvas","navbar","navbars","dropdown","dropdowns",
  "badges","badge","alerts","alert","cards","card","buttons","button","breadcrumb","collapse","overlays",
  "primary","secondary","success","danger","warning","info","light","dark","default","active","disabled",
  "design","code","heading","handle","first","last","middle","left","right","cell","class","variants",
]);
let STRICT = false;

function oracleIsFP(c: Candidate, rel: string): boolean {
  const t = c.text.trim();
  if (STRICT && !/\s/.test(t) && STRICT_LABELS.has(lc(t))) return true;
  if (oracleDevPath(rel)) return true;
  if (c.decorative) return true;
  if (oracleDecorativeAlt(c.attrName, t)) return true;
  if (/^@[\w.]+$/.test(t)) return true;                                   // handle
  if (ORACLE_BRANDS.has(lc(t))) return true;                              // brand
  if (/^(.+?)\s+logo$/i.test(t) && ORACLE_BRANDS.has(lc(/^(.+?)\s+logo$/i.exec(t)![1]))) return true;
  if (ORACLE_DEMO.has(lc(t))) return true;                                // bootstrap demo placeholder
  if (ORACLE_UTILFN.has(lc(t))) return true;                              // util-fn name
  if (!/\s/.test(t)) {                                                    // single-token shapes
    if (ORACLE_BREAKPOINTS.has(lc(t))) return true;
    if (ORACLE_VARIANTS.has(t) && t === lc(t)) return true;              // lower-case variant only
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return true;                // camelCase id
    if (/^([A-Z][a-z0-9]+){2,}$/.test(t)) return true;                   // multi-hump PascalCase API
    if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(t)) return true;              // kebab/snake
  }
  return false;
}

// ---- run -----------------------------------------------------------------------------
function collect(): { c: Candidate; rel: string; src: string; repo: string }[] {
  const out: { c: Candidate; rel: string; src: string; repo: string }[] = [];
  for (const name of CORPUS) {
    const dir = path.join(ROOT, name);
    const repo = detectRepo(dir);
    const root = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    for (const abs of repo.sfcFiles) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      let src: string; try { src = git(root, ["show", `HEAD:${rel}`]); } catch { continue; }
      const rep = extractFor(rel, src); assignKeys(rep.candidates);
      for (const c of rep.candidates) if (c.cls === "HIGH" && c.key) out.push({ c, rel, src, repo: name });
    }
  }
  return out;
}

function measure(label: string, items: ReturnType<typeof collect>, cfg: SuppressConfig | null) {
  const perRepo = new Map<string, { total: number; fp: number; surv: number; survFp: number }>();
  let total = 0, baseFp = 0, surviving = 0, survivingFp = 0, suppressed = 0, fnKilled = 0;
  const byBucket: Record<string, number> = {};
  const residualFP: string[] = [], fnList: string[] = [];
  for (const { c, rel, src, repo } of items) {
    const isFp = oracleIsFP(c, rel);
    total++; if (isFp) baseFp++;
    const r = perRepo.get(repo) ?? { total: 0, fp: 0, surv: 0, survFp: 0 }; perRepo.set(repo, r);
    r.total++; if (isFp) r.fp++;
    const s = cfg ? classifySuppression(c, rel, src, cfg) : { suppressed: false, bucket: null as any, detail: "" };
    if (s.suppressed) {
      suppressed++; byBucket[s.bucket] = (byBucket[s.bucket] ?? 0) + 1;
      if (!isFp) { fnKilled++; if (fnList.length < 25) fnList.push(`${repo}/${rel}: ${JSON.stringify(c.text)} [${s.bucket}]`); }
    } else {
      surviving++; r.surv++; if (isFp) { survivingFp++; r.survFp++; if (residualFP.length < 30) residualFP.push(`${repo}: ${JSON.stringify(c.text)} (${rel})`); }
    }
  }
  const pc = (n: number, d: number) => d ? (Math.round((n / d) * 1000) / 10) : 0;
  console.log(`\n==== ${label} ====`);
  console.log(`baseline: ${total} flags, ${baseFp} FP -> FP=${pc(baseFp, total)}%`);
  if (cfg) {
    console.log(`suppressed: ${suppressed}  [${Object.entries(byBucket).map(([k, v]) => `${k} ${v}`).join(", ")}]`);
    console.log(`surviving (hard-fail): ${surviving}, of which FP=${survivingFp} -> POST-FP=${pc(survivingFp, surviving)}%`);
    console.log(`FN (real copy wrongly suppressed): ${fnKilled}  (FN-rate vs all TP = ${pc(fnKilled, total - baseFp)}%)`);
    console.log(`per-repo POST-FP:`);
    for (const [r, v] of perRepo) console.log(`   ${r}: surviving=${v.surv} survFP=${v.survFp} -> ${pc(v.survFp, v.surv)}%   (baseline ${v.total}f/${v.fp}fp=${pc(v.fp, v.total)}%)`);
    if (fnList.length) { console.log(`FN examples:`); for (const x of fnList) console.log(`   - ${x}`); }
    if (residualFP.length) { console.log(`residual-FP examples (suppressor missed):`); for (const x of residualFP) console.log(`   - ${x}`); }
  }
}

const items = collect();
measure("RAW (no suppression) — conservative oracle", items, null);
STRICT = true;
measure("RAW (no suppression) — STRICT showcase oracle (brackets the PoC ~32%)", items, null);
measure("STRICT oracle + GENERIC suppression", items, makeConfig({}));
STRICT = false;
measure("GENERIC suppression (default config, no app allowlist)", items, makeConfig({}));
measure("WITH app allowlist (1 config: bootstrap demo data + util fns)", items,
  makeConfig({ brands: ["otto", "mark", "jacob", "thornton", "larry", "larry the bird", "the bird", "cell"], enums: ["capitalize", "truncate"] }));
