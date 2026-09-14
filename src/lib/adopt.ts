/** Ordering and searching the catalogue of recorded sessions.
 *
 *  Pure, and split out of `Import.svelte` because the searching is the half of
 *  that panel with a right answer. The panel used to match a query against the
 *  title, the folder and the branch, which sounds like three fields and is
 *  usually one: most transcripts carry no title of their own (316 of the 503 on
 *  this machine), and 216 of those sessions sit on the same branch — so no
 *  query narrowed anything, and no word anybody remembered saying matched at
 *  all. See `sessions.rs`, which is where a row gets a name to search.
 */

/** What this file needs of a session, structurally.
 *
 *  Not `Session` itself: that type lives in `skein.svelte.ts` beside the runes,
 *  and the point of a pure module is that its tests can construct one of these
 *  by hand without the app in the room. Every field is one the panel either
 *  draws or searches. */
export type Listed = {
  id: string;
  cwd: string;
  branch: string | null;
  /** What the row reads: the transcript's own name, the wall's name for it, or
   *  its first prompt — resolved in `sessions::settle_titles`, so by the time a
   *  row is here the three sources have already been put in order. */
  title: string | null;
  /** The first thing said in it, clipped. Searched even when the row is reading
   *  something else, which is the case that makes a remembered phrase find a
   *  conversation that named itself after something else. */
  prompt: string | null;
  last_at: string | null;
};

/** Newest activity first.
 *
 *  Sorted here rather than trusted to the walk that filled the list. The order
 *  is not decoration: this panel opens showing everything, so what is at the
 *  top *is* the answer to "what was I just doing", and the filter is for
 *  narrowing a list you can already read rather than a query you have to write
 *  before anything appears.
 *
 *  A session with no last activity sorts last, which is where a transcript that
 *  never said when it was belongs. ISO strings compare correctly as text, which
 *  is why nothing here parses a date. */
export function newestFirst<T extends Listed>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
}

/** Every word of a row a query may match, lowercased and run together.
 *
 *  Deliberately the text the row is *showing* plus the first prompt — a picker
 *  whose search cannot find a conversation by anything the user remembers
 *  saying is not a picker. The id is in here too and costs nothing: it is the
 *  one handle somebody arriving from a `--resume` line or a log already has.
 *
 *  Joined on a newline, and that choice is load-bearing twice over. A term can
 *  never contain one — `narrow` splits the query on whitespace — so no term
 *  can match across the seam between two fields and report a row that holds it
 *  in neither. And it is a newline rather than the NUL that first stood here:
 *  `crate::clean` exists to take exactly that character out of any text an
 *  agent will read, because a NUL reaching a tool result makes the reading
 *  card's next request a 400 (see `repair.rs`), and `haystack` is exported.
 *  Written into a source file it is worse still — git classifies the file as
 *  binary, and `diff`, `blame` and textual merge go silent on it for good. */
export function haystack(s: Listed): string {
  return [s.title, s.prompt, s.cwd, s.branch, s.id].filter(Boolean).join("\n").toLowerCase();
}

/** The rows matching `query`, in the order they were given.
 *
 *  Every whitespace-separated term has to appear somewhere, in any field and in
 *  any order — so "skein adopt" finds the adoption work in the skein folder
 *  without anybody having to know which of the two words is the title and which
 *  is the path. A single term behaves exactly as the old substring match did.
 *
 *  Fields are joined on a newline rather than a space, so a term cannot match
 *  across the join of two of them — "main c:" would otherwise find a row whose
 *  branch happens to end where its path begins. See `haystack`. */
export function narrow<T extends Listed>(sessions: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...sessions];
  return sessions.filter((s) => {
    const hay = haystack(s);
    return terms.every((t) => hay.includes(t));
  });
}
