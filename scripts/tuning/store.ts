// Reading and writing the shared store. The harness trusts processes running as its own user; anything else that can
// write to the store is not trusted, so the store holds data only and every access here is careful with it:
// - every store directory, from the root down, must be owned by the harness's user and not writable by group or
//   others, so no other user can replace a directory between a check and its use. The harness creates its directories
//   itself with that mode, and refuses any directory that fails the check, or is a link, before reading or writing;
// - the one exception is a shared directory other participants add files to (the noise check): it is sticky
//   (mode 1777) under an owned parent, so others can add files there but cannot rename or remove anyone else's;
// - a write creates a fresh file exclusively in the target directory and renames it over the final name, so it never
//   writes through a link and no reader sees a partial file;
// - every final component is opened without following links, and a file read must be a plain file owned by the
//   harness's user.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const SHARED_MODE = 0o1777;

function user(): number {
  if (process.getuid === undefined) throw new Error("the tuning store needs a system with user ids");
  return process.getuid();
}

function inside(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is not inside the store ${root}`);
  return rel.split(sep);
}

/** Why a store directory is refused, or null when it is acceptable. `shared` admits the sticky shared mode. */
export function directoryProblem(st: Pick<Stats, "uid" | "mode"> & { isDirectory(): boolean; isSymbolicLink(): boolean }, uid: number, shared = false): string | null {
  if (st.isSymbolicLink() || !st.isDirectory()) return "is not a plain directory";
  if (st.uid !== uid) return "is not owned by the user running the harness";
  if ((st.mode & 0o022) !== 0 && !(shared && (st.mode & 0o7777) === SHARED_MODE)) return "is writable by group or others";
  return null;
}

function checkDir(path: string, shared = false): void {
  const problem = directoryProblem(lstatSync(path), user(), shared);
  if (problem !== null) throw new Error(`store directory ${path} ${problem}; refusing it`);
}

/**
 * Open the store root: create it if missing, then refuse it unless it is owned by this user and not writable by group or
 * others, and its parent cannot be used by another user to replace it.
 */
export function openStore(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const parent = statSync(dirname(root));
  if (parent.uid !== user() && parent.uid !== 0) throw new Error(`the directory holding the store ${root} is owned by another user; refusing it`);
  if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) throw new Error(`the directory holding the store ${root} is writable by group or others; refusing it`);
  checkDir(root);
  return root;
}

/** Check every directory from the root down to dir, creating missing ones with the store's mode. */
function walk(root: string, dir: string, create: boolean, sharedLeaf: boolean): void {
  checkDir(root);
  if (dir === root) return;
  const parts = inside(root, dir);
  let at = root;
  parts.forEach((part, i) => {
    at = join(at, part);
    const shared = sharedLeaf && i === parts.length - 1;
    if (create) {
      let made = true;
      try { mkdirSync(at, { mode: 0o755 }); } catch (e: any) { if (e.code !== "EEXIST") throw e; made = false; }
      // The umask may have removed the shared bits; the parent is ours, so nobody else can have replaced this entry.
      if (made && shared) chmodSync(at, SHARED_MODE);
    }
    checkDir(at, shared);
  });
}

/** Make sure every directory from the root down to dir exists and passes the store's checks. */
export function storeDir(root: string, dir: string): string { walk(root, dir, true, false); return dir; }

/** The same for a shared directory other participants add files to: it is created sticky (mode 1777). */
export function storeSharedDir(root: string, dir: string): string { walk(root, dir, true, true); return dir; }

export interface StoreOptions {
  /** The file's directory is a shared directory made by storeSharedDir. */
  readonly shared?: boolean;
}

/** True when a plain file exists at this store path; a link or any other kind of entry is refused. */
export function storeHas(root: string, file: string, options: StoreOptions = {}): boolean {
  inside(root, file);
  try { walk(root, dirname(file), false, options.shared === true); } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
  let st;
  try { st = lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
  if (!st.isFile()) throw new Error(`store path ${file} is not a plain file; refusing it`);
  return true;
}

/** Read a plain file owned by this user from the store, refusing links. */
export function storeRead(root: string, file: string, options: StoreOptions = {}): Buffer {
  inside(root, file);
  walk(root, dirname(file), false, options.shared === true);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`store path ${file} is not a plain file; refusing it`);
    if (st.uid !== user()) throw new Error(`store file ${file} is not owned by the user running the harness; refusing it`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export const storeReadText = (root: string, file: string, options: StoreOptions = {}) => storeRead(root, file, options).toString("utf8");

/** Names of the plain files owned by this user in a store directory, leaving out in-progress temporary files. */
export function storeList(root: string, dir: string, options: StoreOptions = {}): string[] {
  try { walk(root, dir, false, options.shared === true); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  const uid = user();
  return readdirSync(dir).filter(n => {
    if (n.startsWith(".")) return false;
    try { const st = lstatSync(join(dir, n)); return st.isFile() && st.uid === uid; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; }
  }).sort();
}

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function stage(root: string, file: string, data: string | Uint8Array, options: StoreOptions): string {
  inside(root, file);
  const dir = dirname(file);
  if (options.shared === true) walk(root, dir, false, true); else storeDir(root, dir);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(tmp, CREATE, 0o644);
  try { writeFileSync(fd, data); } finally { closeSync(fd); }
  return tmp;
}

/** Write a store file whole, replacing whatever is at its name (a link is replaced, never written through). */
export function storeWrite(root: string, file: string, data: string | Uint8Array, options: StoreOptions = {}): void {
  const tmp = stage(root, file, data, options);
  try { renameSync(tmp, file); } catch (e) { unlinkSync(tmp); throw e; }
}

/** Write a store file whole unless something already has its name; true when this call created it. */
export function storeWriteOnce(root: string, file: string, data: string | Uint8Array, options: StoreOptions = {}): boolean {
  const tmp = stage(root, file, data, options);
  try { linkSync(tmp, file); return true; } catch (e: any) { if (e.code === "EEXIST") return false; throw e; } finally { unlinkSync(tmp); }
}
