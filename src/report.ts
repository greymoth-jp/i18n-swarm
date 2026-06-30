// The product report surface: turn a run into (1) a structured review queue, (2) a
// born-to-share verdict card (SVG), and (3) a zine-styled HTML report.
//
// The card/HTML reuse the greymoth visual identity from @greymoth/tokens +
// @greymoth/sharecard (warm paper, ink + oxblood, the distressed verdict stamp, a
// faint risograph grain). The token VALUES and the card composition are vendored here
// on purpose: i18n-swarm ships as a single zero-runtime-dependency `npx` tool, so it
// cannot pull an unpublished workspace package at install time. This is the same look,
// self-contained — not a new design.

import path from "node:path";
import type { Snapshot } from "./snapshot.ts";
import type { VerifyDecision } from "./verdict.ts";
import type { JsxOutput } from "./react-pipeline.ts";

// --- greymoth tokens (verbatim from @greymoth/tokens) --------------------------------
const C = {
  paper: "#f1ead8",
  paper2: "#e9e0c9",
  ink: "#211c14",
  inkSoft: "#4a4233",
  rule: "#cfc4a6",
  oxblood: "#9c3a2c",
  ok: "#2e5e3a",
  amber: "#a8761a",
  crit: "#c8341e",
};
const FONT_MONO = "'IBM Plex Mono','DM Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const FONT_SERIF = "'Fraunces','Didot','Bodoni MT',Georgia,'Times New Roman',serif";
const INKBLEED = `<filter id="gm-inkbleed" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="1" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2" xChannelSelector="R" yChannelSelector="G"/></filter>`;
const GRAIN_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
const base = (f: string) => path.basename(f);

// --- review queue --------------------------------------------------------------------

export interface ReviewItem { file: string; text: string; reason: string; }
export interface ReviewQueue {
  prose: ReviewItem[]; // AMBIGUOUS: mixed sentences, interpolated phrases, component props
  unusualComponents: ReviewItem[]; // HIGH strings in binding-blocked component shapes
  providerWiring: string[]; // next.config plugin / layout provider warnings
  translations: { key: string; en: string }[]; // ja values awaiting a human/MT pass
  counts: { prose: number; unusual: number; wiring: number; translations: number; total: number };
}

/** Assemble the four review buckets from a JSX analysis + the scaffold warnings. */
export function buildReviewQueue(out: JsxOutput, scaffoldWarnings: string[]): ReviewQueue {
  const prose: ReviewItem[] = out.candidates
    .filter((c) => c.cls === "AMBIGUOUS")
    .map((c) => ({ file: c.file, text: c.text, reason: c.reason }));

  const unusualComponents: ReviewItem[] = [];
  for (const f of out.repo.sfcFiles) {
    const plan = out.fileBinding.get(f);
    if (!plan || plan.safe) continue;
    const highs = out.candidates.filter((c) => c.file === f && c.cls === "HIGH");
    if (highs.length === 0) continue;
    for (const c of highs) unusualComponents.push({ file: f, text: c.text, reason: plan.reason });
  }

  const translations = out.locales.translationTodo;
  const counts = {
    prose: prose.length,
    unusual: unusualComponents.length,
    wiring: scaffoldWarnings.length,
    translations: translations.length,
    total: prose.length + unusualComponents.length + scaffoldWarnings.length + translations.length,
  };
  return { prose, unusualComponents, providerWiring: scaffoldWarnings, translations, counts };
}

// --- normalized run summary (framework-agnostic) -------------------------------------

export interface ProductSummary {
  repoName: string;
  framework: string;
  autoCount: number; // strings actually auto-localized (rewrite edits applied)
  reviewCount: number; // everything in the review queue
  autoHandledPct: number; // HIGH / localizable (classifier-level)
  effectivePct: number; // strings rewired / localizable (end-to-end)
  uniqueKeys: number;
  filesRewired: number;
  corruptions: number;
  buildGreen: boolean;
  verdict: string;
  trust: boolean;
}

interface StampStyle { label: string; color: string; }
function stampFor(s: ProductSummary): StampStyle {
  if (s.buildGreen && s.verdict === "AUTO-VERIFIED") return { label: "BUILD GREEN", color: C.ok };
  if (s.verdict === "FAILED") return { label: "BUILD RED", color: C.crit };
  return { label: "NEEDS HUMAN", color: C.amber };
}

// --- born-to-share verdict card (1200x630 SVG) ---------------------------------------

export function verdictCardSvg(s: ProductSummary): string {
  const W = 1200, H = 630, m = 64;
  const stamp = stampFor(s);
  const hero = `${s.effectivePct}%`;
  const heroSize = hero.length <= 3 ? 240 : hero.length <= 6 ? 168 : 120;
  const heroY = 300;
  const kicker = `I18N-SWARM · CODE-SIDE I18N`;
  const title = esc(s.repoName);
  const subtitle = `${s.autoCount} auto-localized · ${s.reviewCount} to review · ${s.corruptions} corruptions`;
  const stampW = stamp.label.length * 33 * 0.62 + 48;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title} code-side i18n: ${stamp.label}">`);
  p.push(`<defs>${INKBLEED}<pattern id="gm-grain" width="220" height="220" patternUnits="userSpaceOnUse"><image href="${GRAIN_URI}" width="220" height="220"/></pattern></defs>`);
  p.push(`<rect width="${W}" height="${H}" fill="${C.paper}"/>`);
  p.push(`<rect x="18" y="18" width="${W - 36}" height="${H - 36}" fill="none" stroke="${C.ink}" stroke-width="2.5"/>`);
  p.push(`<rect x="27" y="27" width="${W - 54}" height="${H - 54}" fill="none" stroke="${C.oxblood}" stroke-width="1.25"/>`);
  p.push(`<text x="${m}" y="96" font-family="${FONT_MONO}" font-size="22" letter-spacing="5" fill="${C.oxblood}">${kicker}</text>`);
  p.push(`<line x1="${m}" y1="116" x2="${m + 150}" y2="116" stroke="${C.oxblood}" stroke-width="3"/>`);
  // hero with risograph off-register ghost
  p.push(`<text x="${m + 6}" y="${heroY + 6}" font-family="${FONT_MONO}" font-weight="700" font-size="${heroSize}" letter-spacing="-6" fill="${C.oxblood}" opacity="0.26">${hero}</text>`);
  p.push(`<text x="${m}" y="${heroY}" font-family="${FONT_MONO}" font-weight="700" font-size="${heroSize}" letter-spacing="-6" fill="${C.ink}">${hero}</text>`);
  p.push(`<text x="${m + (heroSize * hero.length * 0.62) + 24}" y="${heroY}" font-family="${FONT_SERIF}" font-weight="900" font-size="40" fill="${C.inkSoft}">of localizable</text>`);
  p.push(`<text x="${m + (heroSize * hero.length * 0.62) + 24}" y="${heroY - 52}" font-family="${FONT_SERIF}" font-weight="900" font-size="40" fill="${C.inkSoft}">auto-wired</text>`);
  // verdict stamp upper-right (distressed double border)
  const sx = W - 60 - stampW / 2, sy = 150, sh = 33 + 24;
  p.push(`<g transform="translate(${sx} ${sy}) rotate(-7)" filter="url(#gm-inkbleed)" opacity="0.92">`);
  p.push(`<rect x="${-stampW / 2}" y="${-sh / 2}" width="${stampW}" height="${sh}" fill="none" stroke="${stamp.color}" stroke-width="2.2"/>`);
  p.push(`<rect x="${-stampW / 2 + 4}" y="${-sh / 2 + 4}" width="${stampW - 8}" height="${sh - 8}" fill="none" stroke="${stamp.color}" stroke-width="1.6"/>`);
  p.push(`<text x="0" y="11" text-anchor="middle" font-family="${FONT_MONO}" font-weight="700" font-size="33" letter-spacing="2" fill="${stamp.color}">${stamp.label}</text></g>`);
  // title + subtitle
  p.push(`<text x="${m}" y="430" font-family="${FONT_SERIF}" font-weight="900" font-size="50" fill="${C.ink}">${title}</text>`);
  p.push(`<text x="${m}" y="474" font-family="${FONT_MONO}" font-size="22" letter-spacing="0.5" fill="${C.inkSoft}">${esc(subtitle)}</text>`);
  // footer
  const fy = H - 48;
  p.push(`<line x1="${m}" y1="${fy - 26}" x2="${W - m}" y2="${fy - 26}" stroke="${C.rule}" stroke-width="1.5"/>`);
  p.push(`<text x="${m}" y="${fy}" font-family="${FONT_SERIF}" font-weight="900" font-size="26" fill="${C.ink}">greymoth</text>`);
  p.push(`<text x="${W - m}" y="${fy}" text-anchor="end" font-family="${FONT_MONO}" font-size="16" letter-spacing="2" fill="${C.inkSoft}">${esc(s.framework)} · build ${s.buildGreen ? "GREEN" : "RED"}</text>`);
  p.push(`<rect width="${W}" height="${H}" fill="url(#gm-grain)" opacity="0.16" style="mix-blend-mode:multiply"/>`);
  p.push(`</svg>`);
  return p.join("\n");
}

// --- zine-styled HTML report ---------------------------------------------------------

function phaseCell(p: { ran: boolean; ok: boolean; note: string }): string {
  if (!p.ran) return `<span style="color:${C.inkSoft}">n/a</span>`;
  const col = p.ok ? C.ok : C.crit;
  return `<span style="color:${col};font-weight:700">${p.ok ? "OK" : "FAIL"}</span> <span style="color:${C.inkSoft};font-size:12px">${esc(p.note)}</span>`;
}

function beforeAfter(baseline: Snapshot, after: Snapshot): string {
  const row = (label: string, b: { ran: boolean; ok: boolean; note: string }, a: { ran: boolean; ok: boolean; note: string }) =>
    `<tr><th>${label}</th><td>${phaseCell(b)}</td><td>${phaseCell(a)}</td></tr>`;
  const tstat = (s: Snapshot) =>
    s.test.ran ? `${s.test.stats.passed}/${s.test.stats.total} pass (${esc(s.test.stats.runner)})` : "no tests";
  return `<table class="ba">
    <thead><tr><th></th><th>BEFORE (baseline)</th><th>AFTER (i18n applied)</th></tr></thead>
    <tbody>
      ${row("install", baseline.install, after.install)}
      ${row("build", baseline.build, after.build)}
      ${row("typecheck", baseline.typecheck, after.typecheck)}
      <tr><th>test</th><td>${tstat(baseline)}</td><td>${tstat(after)}</td></tr>
    </tbody>
  </table>`;
}

function queueSection(id: string, title: string, n: number, body: string): string {
  return `<section class="q">
    <h3><span class="num">${n}</span> ${esc(title)}</h3>
    ${n === 0 ? `<p class="empty">none</p>` : body}
  </section>`;
}

function itemList(items: ReviewItem[], cap = 40): string {
  const shown = items.slice(0, cap);
  const rows = shown
    .map((i) => `<li><code>${esc(base(i.file))}</code> <span class="t">${esc(i.text.length > 90 ? i.text.slice(0, 90) + "…" : i.text)}</span> <span class="r">${esc(i.reason)}</span></li>`)
    .join("\n");
  const more = items.length > cap ? `<li class="more">+ ${items.length - cap} more</li>` : "";
  return `<ul class="items">${rows}${more}</ul>`;
}

export function reportHtml(
  summary: ProductSummary,
  baseline: Snapshot,
  after: Snapshot,
  decision: VerifyDecision,
  queue: ReviewQueue,
  cardSvg: string,
): string {
  const stamp = stampFor(summary);
  const translationsBody = `<ul class="items">${queue.translations
    .slice(0, 40)
    .map((t) => `<li><code>${esc(t.key)}</code> <span class="t">${esc(t.en)}</span> <span class="r">ja awaiting human/MT</span></li>`)
    .join("\n")}${queue.translations.length > 40 ? `<li class="more">+ ${queue.translations.length - 40} more</li>` : ""}</ul>`;
  const wiringBody = `<ul class="items">${queue.providerWiring
    .map((w) => `<li><span class="r">${esc(w)}</span></li>`)
    .join("\n")}</ul>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>i18n-swarm · ${esc(summary.repoName)}</title>
<style>
  :root{--paper:${C.paper};--paper2:${C.paper2};--ink:${C.ink};--soft:${C.inkSoft};--rule:${C.rule};--ox:${C.oxblood};--ok:${C.ok};--crit:${C.crit};--amber:${C.amber};--mono:${FONT_MONO};--serif:${FONT_SERIF}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--mono);font-size:14px;line-height:1.55;
    background-image:url("${GRAIN_URI}");background-size:220px}
  .wrap{max-width:920px;margin:0 auto;padding:40px 28px 80px}
  .frame{border:2.5px solid var(--ink);box-shadow:0 0 0 1px var(--paper),0 0 0 3px var(--ox);padding:28px 30px;background:var(--paper)}
  header h1{font-family:var(--serif);font-weight:900;font-size:34px;margin:0 0 2px;letter-spacing:-.01em}
  header .sub{color:var(--ox);letter-spacing:.18em;text-transform:uppercase;font-size:12px}
  .card{margin:26px 0;border:1.5px solid var(--rule)}
  .card img,.card svg{display:block;width:100%;height:auto}
  .verdict{display:flex;align-items:center;gap:18px;margin:8px 0 26px;flex-wrap:wrap}
  .verdict .big{font-size:64px;font-weight:700;line-height:1;color:var(--ink)}
  .stamp{display:inline-block;border:3px double ${stamp.color};color:${stamp.color};padding:7px 15px;
    transform:rotate(-7deg);letter-spacing:.12em;font-weight:700;font-size:15px;text-transform:uppercase;opacity:.92;border-radius:3px}
  .reasons{margin:0;padding-left:18px;color:var(--soft)}
  h2{font-family:var(--serif);font-weight:900;font-size:20px;border-bottom:2px solid var(--ink);padding-bottom:6px;margin:34px 0 14px}
  table.ba{width:100%;border-collapse:collapse;margin:6px 0 8px}
  table.ba th,table.ba td{text-align:left;padding:7px 10px;border:1px solid var(--rule);vertical-align:top}
  table.ba thead th{background:var(--paper2);text-transform:uppercase;letter-spacing:.08em;font-size:11px}
  table.ba tbody th{width:96px;color:var(--soft);font-weight:600}
  .q{margin:18px 0;border-left:3px solid var(--ox);padding:2px 0 2px 16px}
  .q h3{margin:0 0 8px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:10px}
  .q .num{display:inline-flex;min-width:30px;justify-content:center;padding:2px 7px;background:var(--ink);color:var(--paper);font-weight:700}
  .q .empty{color:var(--soft);margin:0;font-style:italic}
  ul.items{list-style:none;margin:0;padding:0}
  ul.items li{padding:5px 0;border-bottom:1px dotted var(--rule)}
  ul.items code{background:var(--paper2);padding:1px 6px;border:1px solid var(--rule);color:var(--ox)}
  ul.items .t{color:var(--ink)}
  ul.items .r{color:var(--soft);font-size:12px;display:block;margin-top:1px}
  ul.items .more{color:var(--soft);font-style:italic;border:0}
  footer{margin-top:40px;color:var(--soft);font-size:12px;display:flex;justify-content:space-between;border-top:1px solid var(--rule);padding-top:10px}
  footer .gm{font-family:var(--serif);font-weight:900;color:var(--ink);font-size:16px}
</style></head>
<body><div class="wrap"><div class="frame">
  <header>
    <div class="sub">i18n-swarm · code-side localization</div>
    <h1>${esc(summary.repoName)}</h1>
  </header>

  <div class="card">${cardSvg}</div>

  <div class="verdict">
    <span class="big" style="color:${summary.buildGreen ? C.ok : C.crit}">${summary.effectivePct}%</span>
    <div>
      <div style="color:var(--soft);font-size:12px;text-transform:uppercase;letter-spacing:.1em">of localizable strings auto-wired</div>
      <div>${summary.autoCount} auto-localized &middot; ${summary.reviewCount} to review &middot; ${summary.corruptions} corruptions</div>
    </div>
    <span class="stamp">${esc(stamp.label)}</span>
  </div>

  <h2>before / after</h2>
  ${beforeAfter(baseline, after)}
  <p style="color:var(--soft);font-size:12px">code-side trust without review:
    <strong style="color:${summary.trust ? C.ok : C.amber}">${summary.trust ? "YES" : "NO"}</strong>
    &middot; verdict ${esc(decision.verdict)} (${esc(decision.confidence)})</p>
  <ul class="reasons">${decision.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>

  <h2>review queue <span style="color:var(--soft);font-weight:400;font-size:13px">— ${queue.counts.total} item(s) the agent will not touch</span></h2>
  ${queueSection("prose", "prose / mixed sentences / interpolated phrases", queue.counts.prose, itemList(queue.prose))}
  ${queueSection("unusual", "unusual component shapes (binding left for review)", queue.counts.unusual, itemList(queue.unusualComponents))}
  ${queueSection("wiring", "framework config & provider wiring", queue.counts.wiring, wiringBody)}
  ${queueSection("translations", "translation items (ja awaiting human/MT)", queue.counts.translations, translationsBody)}

  <footer><span class="gm">greymoth</span><span>${esc(summary.framework)} · build ${summary.buildGreen ? "GREEN" : "RED"} · MIT</span></footer>
</div></div></body></html>`;
}

export function summaryLine(s: ProductSummary): string {
  const stamp = stampFor(s);
  return `${s.autoCount} strings auto-localized · ${s.reviewCount} to review · build ${s.buildGreen ? "GREEN" : "RED"} [${stamp.label}]`;
}
