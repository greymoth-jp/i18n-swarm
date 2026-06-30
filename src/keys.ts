import path from "node:path";
import type { Candidate } from "./types.ts";

export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
  return s || "t";
}

export function namespaceOf(file: string): string {
  return slug(path.basename(file).replace(/\.[a-z]+$/i, ""));
}

/**
 * Assign a stable key to every HIGH candidate. Identical text inside the same file
 * collapses to one shared key (dedupe); slug collisions on different text get a
 * numeric suffix. Mutates candidates in place and returns the catalog map.
 */
export function assignKeys(candidates: Candidate[]): void {
  // group by file so keys are namespaced and dedupe is per-file
  const byFile = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.cls !== "HIGH") continue;
    (byFile.get(c.file) ?? byFile.set(c.file, []).get(c.file)!).push(c);
  }
  for (const [file, list] of byFile) {
    const ns = namespaceOf(file);
    const textToKey = new Map<string, string>();
    const usedSlugs = new Map<string, string>(); // slug -> text that owns it
    for (const c of list) {
      const existing = textToKey.get(c.text);
      if (existing) {
        c.key = existing;
        continue;
      }
      let base = slug(c.text);
      // resolve slug collision against a DIFFERENT text
      if (usedSlugs.has(base) && usedSlugs.get(base) !== c.text) {
        let i = 2;
        while (usedSlugs.has(`${base}_${i}`)) i++;
        base = `${base}_${i}`;
      }
      usedSlugs.set(base, c.text);
      const key = `${ns}.${base}`;
      textToKey.set(c.text, key);
      c.key = key;
    }
  }
}
