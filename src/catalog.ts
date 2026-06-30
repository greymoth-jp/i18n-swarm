import type { Candidate } from "./types.ts";

export interface Locales {
  en: Record<string, string>;
  ja: Record<string, string>;
  /** strings the deterministic agent wired but that still need a human/MT ja value */
  translationTodo: { key: string; en: string }[];
}

/**
 * Build locale objects from the keyed HIGH candidates. `en` holds the real source
 * strings; `ja` is seeded with the English fallback for every key (a valid, building
 * locale that a translator then fills in). The deterministic agent deliberately does
 * NOT machine-translate: ja-locale homograph mistranslation is the #1 ja failure mode
 * and is not trustworthy without human review (see verdict).
 */
export function buildLocales(candidates: Candidate[]): Locales {
  const en: Record<string, string> = {};
  for (const c of candidates) {
    if (c.cls !== "HIGH" || !c.key) continue;
    en[c.key] = c.text;
  }
  // stable key order
  const ordered = Object.fromEntries(Object.entries(en).sort(([a], [b]) => a.localeCompare(b)));
  const ja = { ...ordered };
  const translationTodo = Object.entries(ordered).map(([key, v]) => ({ key, en: v }));
  return { en: ordered, ja, translationTodo };
}

/** Expand flat dotted keys ("a.b.c") into a nested object. next-intl (use-intl)
 *  resolves a dotted lookup against NESTED messages only — a flat `{"a.b": v}` map
 *  returns the key itself at runtime (a silent miss that compile-green never catches).
 *  vue-i18n resolves flat dotted keys directly, so this is next-intl-specific. */
export function nestLocale(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [dotted, val] of Object.entries(flat)) {
    const parts = dotted.split(".");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = val;
  }
  return root;
}

export interface ReviewItem {
  file: string;
  kind: string;
  tag: string;
  text: string;
  reason: string;
}

/** The strings a human must look at: every AMBIGUOUS candidate, grouped flat. */
export function buildReview(candidates: Candidate[]): ReviewItem[] {
  return candidates
    .filter((c) => c.cls === "AMBIGUOUS")
    .map((c) => ({ file: c.file, kind: c.kind + (c.attrName ? `:${c.attrName}` : ""), tag: c.tag, text: c.text, reason: c.reason }));
}
