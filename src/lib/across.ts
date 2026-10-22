/* Where a card on another wall counts its paths from.
 *
 * Every surface that draws an agent's words asks one question before it turns
 * a path into anything: whose directory does this count from (`scopeFiles`,
 * `paths.svelte.ts`). For a card here that is a directory on this disk. For a
 * card on another wall it used to be *nothing* — and nothing is also what a
 * chat card says — so a remote card's pictures, its prose paths and its tool
 * calls' files all stopped at the machine boundary, each surface having
 * decided so for itself (Lyss, 2026-10-22: *"Things that work locally should
 * work accross the flyway by construction, with no omission possible"*).
 *
 * So a remote card has a root like any other — a string, so every surface
 * that carries a root (a `FileLinks`, a `data-root` on an element, the menu's
 * listener) carries this one unchanged — and the few places that *act* on a
 * root ask `readAfar` first: the path classifier and the name resolver
 * (`paths.svelte.ts`), the picture source (`showing.ts`), and opening a file
 * (`App.svelte::goToPath`). Each of those sends the question to the wall the
 * card runs on (`flyway/seeing.rs`) instead of to this disk. Nothing else
 * needs to know, and `test/across.test.ts` holds that nothing else does.
 *
 * **It must never be read as a directory here.** A path written on one
 * machine that happens to exist on this one — the same repository cloned on
 * both laptops is the ordinary case — would open the wrong file of the right
 * name. So the mark is a spelling no Windows path can have (`volery-afar:` is
 * no drive and no share), and Rust refuses a root that is not absolute
 * (`find::rooted`) so a forgotten branch fails closed rather than reading
 * this disk.
 *
 * Pure, and tested directly. */

const MARK = "volery-afar:";

/** A card on another wall, as a root names it. */
export type Afar = { host: string; card: string };

/** The root a card on `host` counts its paths from. */
export function afarRoot(host: string, card: string): string {
  return `${MARK}${encodeURIComponent(host)}/${encodeURIComponent(card)}`;
}

/** The card a root names on another wall, or `null` for a root on this disk
 *  — or for nothing that is a root at all. */
export function readAfar(root: string | null | undefined): Afar | null {
  if (!root || !root.startsWith(MARK)) return null;
  const parts = root.slice(MARK.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return { host: decodeURIComponent(parts[0]), card: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/** Whether a root is one this wall reads from its own disk. Asked of the mark
 *  rather than of `readAfar`, so a mangled remote root is neither: not a card
 *  to ask, and not a directory to read. */
export const isHere = (root: string | null | undefined): root is string => !!root && !root.startsWith(MARK);
