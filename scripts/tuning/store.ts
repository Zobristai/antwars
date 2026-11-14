// Reading and writing the shared store. The harness trusts processes running as its own user; anything else that can
// write to the store is not trusted, so the store holds data only and every access here is careful with it:
// - a write creates a fresh file exclusively in the target directory and renames it over the final name, so it never
//   writes through a link and no reader sees a partial file;
// - a read, or an existence check, refuses a symbolic link at the file or at any directory between the store root and it.
import { randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

function inside(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is not inside the store ${root}`);
  return rel.split(sep);
}

/** Make sure every directory from the root down to dir exists and is a real directory, creating missing ones. */
export function storeDir(root: string, dir: string): string {
  if (dir === root) return dir;
  let at = root;
  for (const part of inside(root, dir)) {
    at = join(at, part);
    try { mkdirSync(at); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
    const st = lstatSync(at);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`store path ${at} is not a plain directory; refusing it`);
  }
  return dir;
}

function checkParents(root: string, file: string): void {
  inside(root, file);
  const dir = dirname(file);
  if (dir === root) return;
  let at = root;
  for (const part of inside(root, dir)) {
    at = join(at, part);
    const st = lstatSync(at);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`store path ${at} is not a plain directory; refusing it`);
  }
}

/** True when a plain file exists at this store path; a link or any other kind of entry is refused. */
export function storeHas(root: string, file: string): boolean {
  try { checkParents(root, file); } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
  let st;
  try { st = lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
  if (!st.isFile()) throw new Error(`store path ${file} is not a plain file; refusing it`);
  return true;
}

/** Read a plain file from the store, refusing links. */
export function storeRead(root: string, file: string): Buffer {
  checkParents(root, file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!lstatSync(file).isFile()) throw new Error(`store path ${file} is not a plain file; refusing it`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export const storeReadText = (root: string, file: string) => storeRead(root, file).toString("utf8");

/** Names in a store directory, leaving out in-progress temporary files. */
export function storeList(root: string, dir: string): string[] {
  try {
    checkParents(root, join(dir, "x"));
    return readdirSync(dir).filter(n => !n.startsWith(".")).sort();
  } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}

function stage(root: string, file: string, data: string | Uint8Array): string {
  const tmp = join(storeDir(root, dirname(file)), `.tmp-${randomUUID()}`);
  writeFileSync(tmp, data, { flag: "wx" });
  return tmp;
}

/** Write a store file whole, replacing whatever is at its name (a link is replaced, never written through). */
export function storeWrite(root: string, file: string, data: string | Uint8Array): void {
  const tmp = stage(root, file, data);
  try { renameSync(tmp, file); } catch (e) { unlinkSync(tmp); throw e; }
}

/** Write a store file whole unless something already has its name; true when this call created it. */
export function storeWriteOnce(root: string, file: string, data: string | Uint8Array): boolean {
  const tmp = stage(root, file, data);
  try { linkSync(tmp, file); return true; } catch (e: any) { if (e.code === "EEXIST") return false; throw e; } finally { unlinkSync(tmp); }
}
