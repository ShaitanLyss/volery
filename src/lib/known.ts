/* The pure half of what `paths.svelte.ts` remembers about the disk.
 *
 * **An absence is a reading of a moment, not a fact.** The cache used to keep
 * `null` — "the disk does not have this" — for the life of the window, and an
 * agent names a file before it creates it all the time ("I'll write
 * docs/spec.md", then writes it). The string was rendered once, asked once,
 * answered *absent*, and stayed text for ever after the file existed. A
 * presence can stay cached, because files that exist are rarely un-made inside
 * a session; an absence has to be re-asked whenever there is evidence the disk
 * changed. This file is that evidence and the question it licenses.
 */

/** Tools whose result may have changed what is on disk. A shell can do
 *  anything, so both spellings of it count (`hooks.md`: `Bash` and
 *  `PowerShell` are live at once). */
const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]);

export function mayWriteDisk(tool: string | undefined): boolean {
  return !!tool && WRITERS.has(tool);
}

/** The key a path is cached under — the root as well, since one relative path
 *  is two files in two cards. */
export function keyOf(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

export function splitKey(key: string): { root: string; path: string } {
  const at = key.indexOf("\u0000");
  return { root: key.slice(0, at), path: key.slice(at + 1) };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Whether one directory is the other or sits inside it, in either direction.
 *  A card's cwd and the root a surface counts from are usually equal, but the
 *  viewer's root may be a subfolder of a card's, or a worktree's parent. */
export function related(root: string, cwd: string): boolean {
  const a = norm(root);
  const b = norm(cwd);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/** The paths under `root` the disk was last said not to have: the only answers
 *  a changed disk can falsify. `undefined` (unknown) is not here, because it is
 *  already being asked, and a kind is not, because it is kept. */
export function negatives<T>(known: Record<string, T | null>, root: string): string[] {
  const prefix = `${root}\u0000`;
  const out: string[] = [];
  for (const k in known) if (k.startsWith(prefix) && known[k] === null) out.push(k.slice(prefix.length));
  return out;
}

/** Roots holding at least one absence, narrowed to the ones a change at `cwd`
 *  could concern (all of them when `cwd` is null — a focus, which says nothing
 *  about where). */
export function rootsToReask(
  maps: Array<Record<string, unknown>>,
  cwd: string | null,
): string[] {
  const roots = new Set<string>();
  for (const m of maps) {
    for (const k in m) {
      if (m[k] !== null) continue;
      roots.add(splitKey(k).root);
    }
  }
  return [...roots].filter((r) => cwd === null || related(r, cwd));
}

/** Split a list so one ask never exceeds the Rust side's cap
 *  (`CLASSIFY_CAP` in `find.rs`). A path past it comes back unanswered, which is
 *  indistinguishable from absent — so the front end never sends more than the
 *  cap, and nothing is silently cut. */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One answer folded into the cache: what to write for `path`, or `undefined`
 *  to leave it alone. A kind is always written; absence is written only for an
 *  answered batch — a batch whose ask failed says nothing. */
export function settle(
  answer: Record<string, string> | null,
  path: string,
): "file" | "dir" | null | undefined {
  if (answer === null) return undefined;
  const kind = answer[path];
  return kind === "dir" || kind === "file" ? kind : null;
}

/* The evidence: a tool result that may have written something. Conversation
 * says it; `paths.svelte.ts` listens. A bus rather than an import because
 * `conversation.svelte.ts` never talks to Rust, and a module-level one rather
 * than a field because a card is built at two sites and a field is a hook a
 * third would forget. */
type Listener = (cwd: string) => void;
const listeners = new Set<Listener>();

export function onDiskMayHaveChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function diskMayHaveChanged(cwd: string): void {
  for (const fn of listeners) fn(cwd);
}
