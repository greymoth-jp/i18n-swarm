// Shared types for the localization pipeline.

export type Klass = "HIGH" | "AMBIGUOUS" | "SKIP";

/** One candidate UI string found in a component, with its classification. */
export interface Candidate {
  file: string; // absolute path of the SFC
  kind: "text" | "attr";
  attrName?: string; // for kind="attr"
  tag: string; // owning element tag
  text: string; // normalized (whitespace-collapsed, trimmed) content
  raw: string; // exact source substring that the offsets cover
  start: number; // absolute offset into the SFC source (inner, trimmed for text)
  end: number;
  cls: Klass;
  reason: string;
  key?: string; // assigned for HIGH candidates
  decorative?: boolean; // enclosing element is aria-hidden / role=presentation|none (screen-reader-hidden)
}

export interface ExtractReport {
  file: string;
  candidates: Candidate[];
  high: number;
  ambiguous: number;
  skip: number;
  parseError: string | null;
}

export interface PhaseResult {
  ran: boolean;
  ok: boolean;
  durationMs: number;
  note: string;
}
