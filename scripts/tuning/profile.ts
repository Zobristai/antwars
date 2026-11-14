// Self and inclusive time per function from a V8 CPU profile (node --cpu-prof). Pure, unit-tested.

export interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number; readonly columnNumber?: number };
  readonly children?: readonly number[];
}
export interface CpuProfile { readonly nodes: readonly CpuProfileNode[]; readonly samples: readonly number[]; readonly timeDeltas: readonly number[] }

export interface FunctionTime { readonly function: string; readonly selfMs: number; readonly inclusiveMs: number; readonly selfShare: number; readonly inclusiveShare: number }

/**
 * Self time is each sample's interval charged to the function on top of the stack; inclusive time charges it once to
 * every distinct function on the stack, so recursion is not counted twice. Functions are named
 * "name file:line:column" (the column when the profile gives one, so functions sharing a line stay apart); `root` is removed from file URLs so names are relative to the timed tree.
 */
export function functionTimes(profile: CpuProfile, root = ""): { readonly totalMs: number; readonly functions: readonly FunctionTime[] } {
  const parent = new Map<number, number>(), key = new Map<number, string>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
    const f = node.callFrame, url = f.url.startsWith("file://") ? f.url.slice(7) : f.url;
    const file = root !== "" && url.startsWith(root) ? url.slice(root.length).replace(/^\/+/, "") : url;
    const column = f.columnNumber === undefined ? "" : `:${f.columnNumber + 1}`;
    key.set(node.id, `${f.functionName === "" ? "(anonymous)" : f.functionName}${file === "" ? "" : ` ${file}:${f.lineNumber + 1}${column}`}`);
  }
  const self = new Map<string, number>(), inclusive = new Map<string, number>();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    if (dt <= 0) continue;
    totalUs += dt;
    let id: number | undefined = profile.samples[i]!;
    const leaf = key.get(id)!;
    self.set(leaf, (self.get(leaf) ?? 0) + dt);
    const seen = new Set<string>();
    while (id !== undefined) {
      const k = key.get(id)!;
      if (!seen.has(k)) { seen.add(k); inclusive.set(k, (inclusive.get(k) ?? 0) + dt); }
      id = parent.get(id);
    }
  }
  const totalMs = totalUs / 1000, round = (x: number) => Math.round(x * 1000) / 1000;
  const functions = [...inclusive.keys()].map(k => {
    const s = (self.get(k) ?? 0) / 1000, inc = inclusive.get(k)! / 1000;
    return { function: k, selfMs: round(s), inclusiveMs: round(inc), selfShare: round(totalMs === 0 ? 0 : s / totalMs), inclusiveShare: round(totalMs === 0 ? 0 : inc / totalMs) };
  });
  return { totalMs: round(totalMs), functions };
}
