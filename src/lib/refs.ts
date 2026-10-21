/* Ids in prose, and what each one is.
 *
 * An agent names things by the short id they were given: a card by its handle
 * (`fc5cb712: taking the build`), a sink item by the same eight characters of
 * a uuid (`sink 20422a14`), a billboard notice likewise, and a commit by its
 * abbreviated hash (`93961f1`). Every surface drew them as written — hex that
 * names nothing — so to know what was meant you went and looked it up. Lyss,
 * 2026-10-21: *"the goal is to eliminate all plain ids, even commits"*.
 *
 * This is the shape half and the words half; the finding-out is
 * `refs.svelte.ts`, which asks the store and git. Pure, so what counts as an
 * id and what is said for one are tested directly.
 *
 * **Shape alone never decides.** Eight hex characters is also a colour, a date
 * with its dashes taken out, and a commit prefix; `handlesIn` said so about
 * cards and it holds for everything here. A token is only ever drawn as a
 * thing once something confirmed it names one — a card the wall knows, a row
 * the store holds, a commit the card's repository has — and until then, and
 * forever if nothing does, it is the text it was. */

import { shortHandle } from "./whois";

/** What an id can name. The order is the order they are asked in: a card
 *  outranks a sink item or a notice that shares its eight characters, which is
 *  a 1-in-4-billion collision and decided here rather than left to chance. */
export type RefKind = "card" | "sink" | "notice" | "commit";

/** A candidate in a run of text: where it is, what it says, and the handle a
 *  lookup is keyed on (a uuid's first eight characters, a hash lower-cased). */
export type Candidate = { from: number; to: number; text: string; key: string };

/** `git` accepts seven hex characters as an abbreviation; a full hash is forty.
 *  A sha-256 repository is sixty-four and is not drawn: this wall has none. */
export const SHA_MIN = 7;
export const SHA_MAX = 40;

const UUID = /(?<![0-9A-Za-z_#-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z_-])/gi;
const HEX = /(?<![0-9A-Za-z_#.-])[0-9a-f]{7,40}(?![0-9A-Za-z_-])/gi;

/** Whether a run of hex is worth asking about at all.
 *
 *  Eight characters is the length every handle and every sink id has, and a
 *  card's handle can legitimately be all digits (2% of them), so eight is asked
 *  whatever it holds. Any other length is a commit abbreviation, which a person
 *  never sees without both a letter and a digit in it unless it is long: the
 *  gate is what keeps `defaced`, `1234567` and `20261021` from being queries.
 *  Each of those would only have come back as nothing — this is for the
 *  lookups, not for the drawing. */
export function worthAsking(hex: string): boolean {
  if (hex.length === 8) return true;
  if (hex.length >= 12) return true;
  return /[a-f]/i.test(hex) && /[0-9]/.test(hex);
}

/** Every id-shaped run in `text`, in order and without overlap. A uuid is one
 *  candidate keyed on its first eight characters — a card's full id written in
 *  prose is the same card. */
export function candidatesIn(text: string): Candidate[] {
  const out: Candidate[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(UUID)) {
    out.push({ from: m.index, to: m.index + m[0].length, text: m[0], key: shortHandle(m[0].toLowerCase()) });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(HEX)) {
    const from = m.index;
    const to = from + m[0].length;
    if (taken.some(([a, b]) => from < b && to > a)) continue;
    if (!worthAsking(m[0])) continue;
    out.push({ from, to, text: m[0], key: m[0].toLowerCase() });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Whether a whole code span is exactly one id. */
export function whollyAn(text: string): Candidate | null {
  const t = text.trim();
  if (t !== text) return null;
  const found = candidatesIn(text);
  return found.length === 1 && found[0]!.from === 0 && found[0]!.to === text.length ? found[0]! : null;
}

/** An id that was confirmed to name something. */
export type Ref =
  | { kind: "sink"; key: string; title: string; settled: boolean }
  | { kind: "notice"; key: string; title: string }
  | { kind: "commit"; key: string; short: string; subject: string; author: string; at: number; root: string };

/** The words a chip carries. A sink item and a notice are called what they are
 *  titled; a commit is its subject line — the one sentence its author chose to
 *  say what it was. Never the id. */
export function refText(r: Ref): string {
  switch (r.kind) {
    case "sink":
    case "notice":
      return r.title.trim() || (r.kind === "sink" ? "a sink item" : "a notice");
    case "commit":
      return r.subject.trim() || "a commit";
  }
}

/** The detail under the pointer, which is the one place the id itself is for:
 *  to paste to an agent. */
export function refTip(r: Ref): string {
  switch (r.kind) {
    case "sink":
      return `sink item ${r.key}${r.settled ? " · settled" : ""}`;
    case "notice":
      return `billboard notice ${r.key}`;
    case "commit": {
      const when = r.at > 0 ? ` · ${new Date(r.at * 1000).toISOString().slice(0, 10)}` : "";
      return `commit ${r.short}${r.author ? ` · ${r.author}` : ""}${when}`;
    }
  }
}

/** A commit's id as the store of answers keys it: the repository counts, since
 *  the same seven characters in two repositories are two commits (or one commit
 *  and nothing). */
export function commitKey(root: string, sha: string): string {
  return `${root}\u0000${sha.toLowerCase()}`;
}

/** How long a "no" about a commit is believed before it is asked again.
 *
 *  **An absence is a reading of a moment** — `paths.svelte.ts`'s rule, and it
 *  holds here: a hash is often written the instant it is made and a card's view
 *  of the repository can be a fetch behind, so "no such commit" is true until
 *  the pull that brings it. A presence is kept for the life of the window; a
 *  commit does not stop existing. Cards and sink rows are different: they are
 *  in the store the moment anything names them, so a no there is a no. */
export const COMMIT_RECHECK_MS = 2 * 60 * 1000;

/** Whether a remembered answer is still the answer. */
export function standing(answer: { at: number; yes: boolean }, now: number): boolean {
  return answer.yes || now - answer.at < COMMIT_RECHECK_MS;
}

/** `text` with every id that something can name replaced by that name, and
 *  every other id left exactly as written.
 *
 *  For the places that cannot draw a chip — a button's label, a tooltip, a
 *  plain `<option>` — and where "show the name, it need not be clickable" is
 *  the whole of the ask (Lyss, 2026-10-21). `nameOf` is the surface's question
 *  of what a candidate is, and answers null for "text", which is also what an
 *  id still being looked up is: so a label never flashes an id and then a name
 *  with different widths, it simply gains its name when the answer lands. */
export function say(text: string, nameOf: (c: Candidate) => string | null): string {
  let out = "";
  let from = 0;
  for (const c of candidatesIn(text)) {
    const name = nameOf(c);
    if (!name) continue;
    out += text.slice(from, c.from) + name;
    from = c.to;
  }
  return from === 0 ? text : out + text.slice(from);
}
