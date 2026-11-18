/**
 * The render check's verdict and its outputs: report.json, report.md, GitHub annotations and the job summary.
 * A failure counts against the build only when the reviewed held list (held.json) does not already hold it,
 * or holds fewer of it than this run found.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, RuleId } from "./rules.ts";
import type { Typeface } from "./fonts.ts";

export interface Render {
  surface: string;
  url: string;
  width: number;
  typeface: Typeface;
  failures: Finding[];
  tight: Finding[];
  /** Where the marked render was saved, relative to the output directory. */
  image: string;
  fonts: Record<string, number>;
  /** Problems that make this render itself invalid: wrong typeface, unanswered requests, a page that did not load. */
  invalid: string[];
  pageErrors: string[];
  fixtures: string[];
}

export interface HeldEntry { surface: string; width: number; typeface: Typeface; rule: RuleId; element: string; count: number; why: string }
export interface HeldList { note: string; held: HeldEntry[] }

export const heldKey = (e: { surface: string; width: number; typeface: string; rule: string; element: string }): string =>
  [e.surface, e.width, e.typeface, e.rule, e.element].join(" | ");

export async function readHeld(file: string): Promise<HeldList> {
  return JSON.parse(await readFile(file, "utf8")) as HeldList;
}

export interface Judged extends Finding { surface: string; width: number; typeface: Typeface; image: string; held: boolean }
export interface Verdict {
  passed: boolean;
  newFailures: Judged[];
  heldFailures: Judged[];
  tight: Judged[];
  invalid: { surface: string; width: number; typeface: Typeface; problem: string }[];
  /** Held entries this run no longer found, or found fewer of: the list can shrink. */
  heldUnused: { entry: HeldEntry; found: number }[];
}

export function judge(renders: readonly Render[], held: HeldList): Verdict {
  const allowance = new Map(held.held.map(e => [heldKey(e), e.count]));
  const found = new Map<string, number>();
  const newFailures: Judged[] = [], heldFailures: Judged[] = [], tight: Judged[] = [];
  const invalid: Verdict["invalid"] = [];
  for (const r of renders) {
    const at = { surface: r.surface, width: r.width, typeface: r.typeface, image: r.image };
    for (const f of r.failures) {
      const key = heldKey({ ...at, rule: f.rule, element: f.element });
      const n = (found.get(key) ?? 0) + 1;
      found.set(key, n);
      const isHeld = n <= (allowance.get(key) ?? 0);
      (isHeld ? heldFailures : newFailures).push({ ...f, ...at, held: isHeld });
    }
    for (const f of r.tight) tight.push({ ...f, ...at, held: false });
    for (const problem of r.invalid) invalid.push({ surface: r.surface, width: r.width, typeface: r.typeface, problem });
  }
  const heldUnused = held.held.map(entry => ({ entry, found: found.get(heldKey(entry)) ?? 0 })).filter(u => u.found < u.entry.count);
  return { passed: newFailures.length === 0 && invalid.length === 0, newFailures, heldFailures, tight, invalid, heldUnused };
}

/** The held list that would hold exactly this run's failures, keeping each existing entry's reason. */
export function heldFrom(renders: readonly Render[], previous: HeldList, why: string): HeldList {
  const reasons = new Map(previous.held.map(e => [heldKey(e), e.why]));
  const counts = new Map<string, HeldEntry>();
  for (const r of renders) for (const f of r.failures) {
    const entry = { surface: r.surface, width: r.width, typeface: r.typeface, rule: f.rule, element: f.element };
    const key = heldKey(entry);
    const had = counts.get(key);
    counts.set(key, had ? { ...had, count: had.count + 1 } : { ...entry, count: 1, why: reasons.get(key) ?? why });
  }
  return { note: previous.note, held: [...counts.values()].sort((a, b) => heldKey(a).localeCompare(heldKey(b))) };
}

/** Tight fits are listed, not failed; the report shows only the tightest. */
const TIGHT_SHOWN = 40;
const where = (j: { surface: string; width: number; typeface: string }) => `${j.surface} at ${j.width} px in ${j.typeface}`;
const line = (j: Judged) => `${where(j)}: ${j.rule} — ${j.element}${j.text ? ` “${j.text}”` : ""} — ${j.measure}`;
const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(v: Verdict, renders: readonly Render[], context: { build: string; snapshot: string }): string {
  const out: string[] = [];
  out.push(`# Render check: ${v.passed ? "passed" : "FAILED"}`, "");
  out.push(`Build: ${context.build}. Data: ${context.snapshot}.`, "");
  out.push(`${renders.length} renders. ${v.newFailures.length} new failures, ${v.invalid.length} invalid renders, ${v.heldFailures.length} held failures (already on main, reviewed in held.json), ${v.tight.length} tight fits (listed, not failed).`, "");
  if (v.invalid.length) {
    out.push("## Invalid renders", "", ...v.invalid.map(i => `- ${where(i)}: ${i.problem}`), "");
  }
  const table = (title: string, rows: Judged[]) => {
    if (!rows.length) return;
    out.push(`## ${title}`, "", "| Surface | Width | Typeface | Rule | Element | Text | Measure | Render |", "|---|---|---|---|---|---|---|---|");
    for (const j of rows) out.push(`| ${j.surface} | ${j.width} | ${j.typeface} | ${j.rule} | ${cell(j.element)} | ${cell(j.text)} | ${cell(j.measure)} | ${j.image} |`);
    out.push("");
  };
  table("New failures", v.newFailures);
  table("Held failures", v.heldFailures);
  const tightest = [...v.tight].sort((a, b) => (a.spare ?? 1) - (b.spare ?? 1)).slice(0, TIGHT_SHOWN);
  table(v.tight.length > TIGHT_SHOWN ? `Tight fits (the ${TIGHT_SHOWN} tightest of ${v.tight.length}; all are in report.json)` : "Tight fits", tightest);
  if (v.heldUnused.length) {
    out.push("## Held entries no longer found", "", "The held list can shrink by these:", "",
      ...v.heldUnused.map(u => `- ${heldKey(u.entry)}: held ${u.entry.count}, found ${u.found}`), "");
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
