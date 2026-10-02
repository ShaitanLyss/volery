/* Something to draw.
 *
 * The fourth unlock toy, and the one with an outside: a reference on the
 * screen, a pencil and paper in front of you, and a button that says you are
 * done. Nothing marks it — that is the point, and it is the only toy here with
 * no right answer.
 *
 * Lyss's reasoning: *"i want real photographs to sketch, and I also want
 * sometimes pieces from artists I like … to copy style in order to build on my
 * drawing knowledge … basically I want to get better at drawing and find my own
 * style"*. So this is not decoration, it is a practice tool, and two things
 * follow from that:
 *
 * - **It has to work offline.** A morning with no network is still a morning
 *   you wanted to draw, so references are cached ahead of time and the gate
 *   draws from the cache. The fetching is the background job; the toy only ever
 *   reads what is already on disk.
 * - **The list is yours.** What a reference *is* depends on what you are
 *   working on this month — gesture, drapery, faces, one painter's line — so
 *   the terms are a setting, and a source is a named thing you can switch off.
 *
 * ## The four sources, and why the fourth exists
 *
 * Two are **open-access collections** — the Art Institute of Chicago and the
 * Met both publish public-domain works with an API and no key, which is how
 * Hokusai, Mucha, Klimt and Sargent are one search term away. One is Picsum,
 * for photographs, which is a different exercise: value and foreshortening
 * rather than somebody else's line.
 *
 * The fourth is **an image search**, and it is here because the first three
 * cannot answer the question that was actually asked. Lyss: *"about Amano, I
 * understand there's copyright, but I'm not asking to steal his work, just show
 * it like a normal Google search would so that I can look at it and sketch it,
 * that's no copyright infringement"*. That is right, and the first version of
 * this file was wrong to refuse on those grounds: fetching an image to *look
 * at* is what every browser does on every page, and drawing from a reference is
 * what every art student has always done. What copyright would bear on is
 * publishing or selling the result, and nothing here does either — the picture
 * is cached locally, shown to one person, and deleted when they say they have
 * drawn it.
 *
 * So a living artist is reachable now, and `folder` is still here for the one
 * thing a search is bad at: a set of references you have chosen deliberately
 * and want to come back to.
 *
 * The network half is `sketch.rs`, which fetches and caches and knows nothing
 * about what a source is. This file holds every source's shape, which is the
 * same arrangement `azdo.ts` has with `azdo.rs` and for the same reason: the
 * vocabulary of a service belongs beside the code that reads it.
 */

/** One thing to draw, as it is stored. */
export type Reference = {
  /** Stable, and the cache file's name. Derived from the source and its own id
   *  so that re-finding the same work twice does not store it twice. */
  id: string;
  title: string;
  /** Empty for a photograph, which has a photographer rather than an artist —
   *  `credit` is what gets drawn, and it is built to say the right thing for
   *  both. */
  artist: string;
  /** The line shown under the picture. Required: a reference with no
   *  attribution is one you cannot go and look up afterwards, which is half of
   *  what studying a painter is. */
  credit: string;
  /** Where the image itself is. A remote URL before it is cached, a local path
   *  after. */
  url: string;
  source: SourceId;
};

export type SourceId = "artic" | "met" | "photo" | "search" | "folder";

export type Fetcher = (url: string) => Promise<string>;

export type Source = {
  id: SourceId;
  label: string;
  /** One line in the settings, saying what this is and what it may be asked
   *  for. */
  about: string;
  /** Whether a search term means anything here. A photograph source that
   *  ignored "Hokusai" and quietly returned a beach would be worse than one
   *  that says it takes no terms. */
  takesTerm: boolean;
  find(get: Fetcher, roll: number, term: string | null): Promise<Reference | null>;
};

/* ── what to ask for ──────────────────────────────────────────────────────── */

/** What the museums are asked for when nothing else is set.
 *
 *  Chosen as *things to draw* rather than as famous names: a reference is
 *  useful when it has a figure, a fold or a face in it, and "Monet" mostly
 *  returns haystacks. The painters that are here are here for their line —
 *  which is the thing you can actually steal. */
export const DEFAULT_TERMS: readonly string[] = [
  /* The ones that are here for their *line*, which is the thing you can
     actually steal. Amano is first because he is the case this list was
     rewritten for — the image search reaches him where the museums cannot. */
  "Yoshitaka Amano",
  "Yoshitaka Amano watercolour",
  "Hokusai",
  "Mucha",
  "Sargent portrait",
  "Dürer drawing",
  "Japanese woodblock figure",
  "Klimt drawing",
  "Rembrandt etching",
  "Greek sculpture",
  /* And the ones that are a *thing to draw* rather than somebody to copy. A
     reference earns its place by having a figure, a fold or a face in it. */
  "drapery study",
  "hands study",
  "horse",
  "bird study",
];

export function pick<T>(from: readonly T[], roll: number): T | null {
  if (!from.length) return null;
  const i = Math.min(from.length - 1, Math.max(0, Math.floor(roll * from.length)));
  return from[i];
}

/* ── the sources ──────────────────────────────────────────────────────────── */

/** The Art Institute of Chicago. One request, open access, and the only one of
 *  the three whose search answers with everything needed in one go. */
const artic: Source = {
  id: "artic",
  label: "art institute of chicago",
  about: "public-domain painting and drawing, searchable by artist or subject",
  takesTerm: true,
  async find(get, roll, term) {
    const q = encodeURIComponent(term ?? "drawing");
    const body = await get(
      `https://api.artic.edu/api/v1/artworks/search?q=${q}&limit=30` +
        `&fields=id,title,artist_title,image_id,is_public_domain`,
    );
    const json = safeParse(body);
    const data = Array.isArray(json?.data) ? json.data : [];
    const usable = data.filter(
      (d: Record<string, unknown>) =>
        typeof d.image_id === "string" && d.is_public_domain !== false,
    );
    const got = pick(usable, roll) as Record<string, unknown> | null;
    if (!got) return null;
    const artist = str(got.artist_title);
    const title = str(got.title) || "untitled";
    return {
      id: `artic-${str(got.id)}`,
      title,
      artist,
      credit: `${title}${artist ? ` · ${artist}` : ""} · art institute of chicago`,
      /* 843px on the long edge: enough to draw from at arm's length, and small
         enough that topping a cache up to a dozen is a few megabytes rather
         than a hundred. */
      url: `https://www.artic.edu/iiif/2/${str(got.image_id)}/full/843,/0/default.jpg`,
      source: "artic",
    };
  },
};

/** The Met's open access. Two requests, because its search answers with ids
 *  and nothing else — which is also why it is second in the rotation rather
 *  than first. */
const met: Source = {
  id: "met",
  label: "the met",
  about: "the Met's open-access collection, searchable the same way",
  takesTerm: true,
  async find(get, roll, term) {
    const q = encodeURIComponent(term ?? "drawing");
    const found = safeParse(
      await get(
        `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${q}`,
      ),
    );
    const ids = Array.isArray(found?.objectIDs) ? found.objectIDs : [];
    /* Only the first ninety are considered. The Met's search answers with
       thousands of ids and the tail is mostly things with a thumbnail and no
       picture worth drawing; taking a roll over the whole list would mostly
       cost a second request for nothing. */
    const id = pick(ids.slice(0, 90), roll);
    if (id === null || id === undefined) return null;
    const obj = safeParse(
      await get(
        `https://collectionapi.metmuseum.org/public/collection/v1/objects/${String(id)}`,
      ),
    );
    const image = str(obj?.primaryImageSmall) || str(obj?.primaryImage);
    if (!image) return null;
    const artist = str(obj?.artistDisplayName);
    const title = str(obj?.title) || "untitled";
    return {
      id: `met-${String(id)}`,
      title,
      artist,
      credit: `${title}${artist ? ` · ${artist}` : ""} · the met`,
      url: image,
      source: "met",
    };
  },
};

/** Photographs. A different exercise from a painting — value and foreshortening
 *  rather than somebody else's line — so it is its own source rather than a
 *  search term. */
const photo: Source = {
  id: "photo",
  label: "photographs",
  about: "photographs, for value and proportion rather than somebody's line",
  takesTerm: false,
  async find(get, roll) {
    const page = 1 + Math.floor(roll * 30);
    const list: unknown = safeParse(
      await get(`https://picsum.photos/v2/list?page=${page}&limit=30`),
    );
    const items = Array.isArray(list) ? list : [];
    const got = pick(items, (roll * 7) % 1) as Record<string, unknown> | null;
    if (!got) return null;
    const author = str(got.author);
    return {
      id: `photo-${str(got.id)}`,
      title: "photograph",
      artist: author,
      credit: `photograph${author ? ` · ${author}` : ""} · picsum`,
      url: `https://picsum.photos/id/${str(got.id)}/1200/900`,
      source: "photo",
    };
  },
};

/** An image search, which is the source that can answer "Amano".
 *
 *  Two requests to DuckDuckGo: a page, because its results endpoint demands a
 *  token (`vqd`) that only appears in the HTML, and then the results
 *  themselves. Probed 2026-10-02 — 58 results for *yoshitaka amano*, each with
 *  a full-size image URL, its dimensions, a title and the page it was found on.
 *
 *  **It is the most fragile thing in this file and that is stated rather than
 *  hidden.** Nothing about those two requests is a published interface, so a
 *  change at the other end breaks this and nothing else; it returns `null`
 *  rather than throwing, `topUp` moves on to another source, and the museums,
 *  the photographs and your own folder go on working. If it ever stops, that is
 *  what has happened — not the cache, and not the network.
 *
 *  Small images are dropped. A thumbnail is not something to draw from, and the
 *  results carry their dimensions, so the filter is free. */
const search: Source = {
  id: "search",
  label: "image search",
  about: "anything you can name — a living artist, a pose, a kind of light",
  takesTerm: true,
  async find(get, roll, term) {
    const q = encodeURIComponent(term ?? "figure drawing");
    const page = await get(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
    /* The bare `vqd=` appears earlier in the document with nothing after it, so
       the token's own shape is part of the pattern rather than an afterthought
       — matching the first `vqd=` finds an empty string and the results request
       then answers nothing. */
    const vqd = /vqd=["']?(4-[0-9]+)/.exec(page)?.[1];
    if (!vqd) return null;
    const body = await get(
      `https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`,
    );
    const json = safeParse(body);
    const results = Array.isArray(json?.results) ? json.results : [];
    const big = results.filter((r: Record<string, unknown>) => {
      const w = typeof r.width === "number" ? r.width : 0;
      const h = typeof r.height === "number" ? r.height : 0;
      return typeof r.image === "string" && Math.max(w, h) >= 700;
    });
    const got = pick(big, roll) as Record<string, unknown> | null;
    if (!got) return null;
    const title = str(got.title).trim() || term || "reference";
    const where = str(got.url);
    return {
      /* The URL rather than an id, because a search has none — hashed so the
         file name is short and stable, which is what stops the same picture
         being fetched twice across two evenings. */
      id: `search-${hash(str(got.image))}`,
      title,
      artist: term ?? "",
      credit: `${title}${where ? ` · ${host(where)}` : ""} · found by search`,
      url: str(got.image),
      source: "search",
    };
  },
};

export const SOURCES: readonly Source[] = [artic, met, photo, search];

export function sourceById(id: string): Source | null {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/* ── choosing what to go and get ──────────────────────────────────────────── */

export type Wanted = { source: Source; term: string | null };

/** What to fetch next, given which sources are on and what you are working on.
 *
 *  Pure, so the rotation is testable: the thing it has to guarantee is that
 *  nothing returns a source that is switched off, and that a source taking no
 *  terms is never handed one — a photograph fetched "for Hokusai" would be a
 *  reference that lies about why it is on your screen. */
export function wanted(
  on: readonly SourceId[],
  terms: readonly string[],
  roll: number,
): Wanted | null {
  const live = SOURCES.filter((s) => on.includes(s.id));
  const source = pick(live, roll);
  if (!source) return null;
  if (!source.takesTerm) return { source, term: null };
  const list = terms.length ? terms : DEFAULT_TERMS;
  return { source, term: pick(list, (roll * 13) % 1) };
}

/** How many references are worth having on disk.
 *
 *  Twelve is about a fortnight of sittings, which is the horizon that matters:
 *  the cache exists so that a week with no network is still a week you can
 *  draw. Past that it is a folder of pictures nobody looks at, and each one is
 *  roughly a quarter of a megabyte. */
export const CACHE_WANT = 12;

/** How long a sketch is, said the way the toy says it.
 *
 *  Counting *up*, never down. A timer running out is a thing you watch, and a
 *  five-minute drawing you spent watching a clock is not a drawing — the same
 *  argument `Rest.svelte` makes about the break screen. The number is here so
 *  you know afterwards how long it took, which is the only thing about it worth
 *  knowing. */
export function drawn(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}m ${String(rest).padStart(2, "0")}s`;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** JSON that may not be. Every one of these answers comes off a network and
 *  through a Rust command, so the failure to plan for is not a malformed API —
 *  it is a captive portal answering an HTML login page with a 200. */
function safeParse(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    /* An array is a perfectly good answer — Picsum's listing is one — and it is
       still indexable by key as far as this file is concerned, since every read
       below goes through `str` or an `Array.isArray` guard. Typing it as a
       record keeps those reads honest without a cast at every call site. */
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short stable name for a URL. Not a security hash — it names a file in a
 *  cache, and what it has to be is the same every time for the same picture. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Where a picture was found, for the credit line. Degrades to the whole string
 *  rather than throwing: a result with a malformed URL is still a picture. */
function host(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, "") : url;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
