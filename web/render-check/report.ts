/**
 * The render check's verdict and its outputs: report.json, report.md, GitHub annotations and the job summary.
 * A failure counts against the build unless the reviewed held list (held.json) holds that very finding: the same
 * rule on the same element and text of the same surface, width, text size and typeface, broken no further than it was
 * held at.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, RuleId } from "./rules.ts";
import { DEFAULT_TEXT_SIZE, type TextSize, type Typeface } from "./fonts.ts";

export interface Render {
  surface: string;
  url: string;
  width: number;
  textSize: TextSize;
  typeface: Typeface;
  failures: Finding[];
  tight: Finding[];
  /** The marked renders saved, relative to the output directory: the first shows the top of the surface. */
  images: string[];
  /** For each failure, the marked render that shows it. */
  failureImages: string[];
  /** For each failure, whether it is in view on its render: false only where no scrolling brings it into view. */
  failureInView?: boolean[];
  fonts: Record<string, number>;
  /** Glyphs drawn for the landing MCP address only. */
  urlFonts?: Record<string, number>;
  /** Problems that make this render itself invalid: wrong typeface, unanswered requests, a page that did not load. */
  invalid: string[];
  /** JSON metadata and comparison-image references, retained for an invalid render. */
  invalidEvidence?: string;
  pageErrors: string[];
  fixtures: string[];
}

/** One finding already on main: held at its extent (lines, px or tiles, as its rule measures it). */
export interface HeldEntry { surface: string; width: number; textSize: TextSize; typeface: Typeface; rule: RuleId; element: string; text: string; extent: number; why: string }
export interface HeldList { note: string; held: HeldEntry[] }

export const heldKey = (e: { surface: string; width: number; textSize: TextSize; typeface: string; rule: string; element: string; text: string }): string =>
  [e.surface, e.width, `${e.textSize}px`, e.typeface, e.rule, e.element, e.text].join(" | ");

/** How much further than its held extent a finding may measure and still be the held one: rounding, not change. */
export const heldSlack = (rule: RuleId): number => rule === "wrap" || rule === "part-uneven" ? 0 : 1;

export async function readHeld(file: string): Promise<HeldList> {
  return JSON.parse(await readFile(file, "utf8")) as HeldList;
}

export interface Judged extends Finding { surface: string; width: number; textSize: TextSize; typeface: Typeface; image: string; held: boolean; outOfView?: boolean }
export interface Verdict {
  passed: boolean;
  newFailures: Judged[];
  heldFailures: Judged[];
  tight: Judged[];
  invalid: { surface: string; width: number; textSize: TextSize; typeface: Typeface; problem: string; evidence?: string }[];
  /** Held entries this run did not match: fixed, or now worse (then also a new failure). The list can shrink. */
  heldUnused: HeldEntry[];
}

export function judge(renders: readonly Render[], held: HeldList): Verdict {
  const open = new Map<string, HeldEntry[]>();
  for (const e of held.held) open.set(heldKey(e), [...(open.get(heldKey(e)) ?? []), e]);
  const newFailures: Judged[] = [], heldFailures: Judged[] = [], tight: Judged[] = [];
  const invalid: Verdict["invalid"] = [];
  for (const r of renders) {
    const at = { surface: r.surface, width: r.width, textSize: r.textSize, typeface: r.typeface };
    // The worst findings take the largest held extents first, so a held finding that worsens is the one left over.
    const order = r.failures.map((f, i) => i).sort((a, b) => r.failures[b]!.extent - r.failures[a]!.extent);
    for (const i of order) {
      const f = r.failures[i]!;
      const candidates = open.get(heldKey({ ...at, rule: f.rule, element: f.element, text: f.text })) ?? [];
      candidates.sort((a, b) => b.extent - a.extent);
      const match = candidates.findIndex(e => f.extent <= e.extent + heldSlack(f.rule));
      const judged = { ...f, ...at, image: r.failureImages[i] ?? r.images[0] ?? "", held: match >= 0, ...(r.failureInView?.[i] === false ? { outOfView: true } : {}) };
      if (match >= 0) { candidates.splice(match, 1); heldFailures.push(judged); continue; }
      const was = candidates[0];
      newFailures.push(was ? { ...judged, measure: `${judged.measure}; held at ${was.extent}, now ${f.extent}` } : judged);
    }
    for (const f of r.tight) tight.push({ ...f, ...at, image: r.images[0] ?? "", held: false });
    for (const problem of r.invalid) invalid.push({ ...at, problem, ...(r.invalidEvidence ? { evidence: r.invalidEvidence } : {}) });
  }
  const heldUnused = [...open.values()].flat();
  return { passed: newFailures.length === 0 && invalid.length === 0, newFailures, heldFailures, tight, invalid, heldUnused };
}

/** The held list that would hold exactly this run's failures, keeping the reason of each element already held. */
export function heldFrom(renders: readonly Render[], previous: HeldList, why: string): HeldList {
  const reasons = new Map(previous.held.map(e => [heldKey({ ...e, text: "" }), e.why]));
  const held: HeldEntry[] = [];
  for (const r of renders) for (const f of r.failures) {
    const entry = { surface: r.surface, width: r.width, textSize: r.textSize, typeface: r.typeface, rule: f.rule, element: f.element, text: f.text, extent: f.extent };
    held.push({ ...entry, why: reasons.get(heldKey({ ...entry, text: "" })) ?? why });
  }
  return { note: previous.note, held: held.sort((a, b) => heldKey(a).localeCompare(heldKey(b)) || a.extent - b.extent) };
}

/** Tight fits are listed, not failed; the report shows only the tightest. */
const TIGHT_SHOWN = 40;
const textLabel = (size: TextSize) => size === DEFAULT_TEXT_SIZE ? "default text" : `${size} px text`;
const where = (j: { surface: string; width: number; textSize: TextSize; typeface: string }) =>
  `${j.surface} at ${j.width} px (${textLabel(j.textSize)}) in ${j.typeface}`;
const line = (j: Judged) => `${where(j)}: ${j.rule} — ${j.element}${j.text ? ` “${j.text}”` : ""} — ${j.measure}`;
const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
// A backslash first, so the one written before a pipe is not read as escaping something else.
const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(v: Verdict, renders: readonly Render[], context: { build: string; snapshot: string }): string {
  const out: string[] = [];
  out.push(`# Render check: ${v.passed ? "passed" : "FAILED"}`, "");
  out.push(`Build: ${context.build}. Data: ${context.snapshot}.`, "");
  out.push(`${renders.length} renders. ${v.newFailures.length} new failures, ${v.invalid.length} invalid renders, ${v.heldFailures.length} held failures (already on main, reviewed in held.json), ${v.tight.length} tight fits (listed, not failed).`, "");
  if (v.invalid.length) {
    out.push("## Invalid renders", "", ...v.invalid.map(i => `- ${where(i)}: ${i.problem}${i.evidence ? ` ([evidence](${i.evidence}))` : ""}`), "");
  }
  const table = (title: string, rows: Judged[]) => {
    if (!rows.length) return;
    out.push(`## ${title}`, "", "| Surface | Width | Text size | Typeface | Rule | Element | Text | Measure | Render |", "|---|---|---|---|---|---|---|---|---|");
    for (const j of rows) out.push(`| ${j.surface} | ${j.width} | ${j.textSize} px | ${j.typeface} | ${j.rule} | ${cell(j.element)} | ${cell(j.text)} | ${cell(j.measure)} | ${j.image}${j.outOfView ? " (outside the view: nothing scrolls to it)" : ""} |`);
    out.push("");
  };
  table("New failures", v.newFailures);
  table("Held failures", v.heldFailures);
  const tightest = [...v.tight].sort((a, b) => (a.spare ?? 1) - (b.spare ?? 1)).slice(0, TIGHT_SHOWN);
  table(v.tight.length > TIGHT_SHOWN ? `Tight fits (the ${TIGHT_SHOWN} tightest of ${v.tight.length}; all are in report.json)` : "Tight fits", tightest);
  if (v.heldUnused.length) {
    out.push("## Held entries not matched", "", "Fixed, or now worse (then also listed as new failures). The held list can shrink by the fixed ones:", "",
      ...v.heldUnused.map(e => `- ${heldKey(e)}: held at ${e.extent}`), "");
  }
  return out.join("\n");
}

export async function publish(out: string, v: Verdict, renders: readonly Render[], context: { build: string; snapshot: string }): Promise<void> {
  const md = markdown(v, renders, context);
  await writeFile(join(out, "report.json"), JSON.stringify({ ...context, verdict: v, renders }, null, 1) + "\n");
  await writeFile(join(out, "report.md"), md);
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const i of v.invalid) console.log(`::error title=Render check: invalid render::${escape(`${where(i)}: ${i.problem}`)}`);
    for (const j of v.newFailures) console.log(`::error title=Render check: ${j.rule}::${escape(line(j))}`);
    for (const j of v.heldFailures) console.log(`::warning title=Render check (held): ${j.rule}::${escape(line(j))}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
  for (const i of v.invalid) console.log(`INVALID ${where(i)}: ${i.problem}`);
  for (const j of v.newFailures) console.log(`FAIL ${line(j)}`);
  console.log(`render check ${v.passed ? "passed" : "failed"}: ${v.newFailures.length} new, ${v.invalid.length} invalid, ${v.heldFailures.length} held, ${v.tight.length} tight; report ${join(out, "report.md")}`);
}
