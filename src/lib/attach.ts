/** Images attached to a prompt, and where they sit inside it.
 *
 *  Until now the only way to show an agent a picture was to write a path in the
 *  draft and hope it reached for `Read`. That works and costs a tool call, a
 *  round trip and the agent's willingness — and it fails outright for the case
 *  that comes up most, which is a screen capture: Windows' capture tools put a
 *  bitmap on the clipboard and write nothing to disk, so there is no path to
 *  write. The wall already knew this (`store::paste_image` exists for exactly
 *  that reason) and answered it by pinning the picture *beside* the card, where
 *  the agent cannot see it.
 *
 *  ## The image goes where you were typing
 *
 *  An attachment is not a tray bolted onto the end of the draft. It is a token
 *  sitting in the sentence — `look at [shot 1], make it more like [shot 2]` —
 *  and the whole design follows from that being literally true on the wire.
 *  `compose` cuts the draft at its tokens and hands back alternating blocks,
 *  which is exactly the shape the CLI's stdin takes.
 *
 *  **Probed before any of it was built** (`tools/probe-image.ts`, claude
 *  2.1.x, opus-5): a `user` envelope whose `content` is
 *  `[text, image, text, image, text]` is accepted, and a model asked to
 *  describe each picture named all seven colours of two generated images in the
 *  right two groups. Position survives the wire — which is the only thing that
 *  makes "this one, more like that one" mean anything, and it is not something
 *  the schema alone promised.
 *
 *  ## Which is why the echo is a second string
 *
 *  The same probe answered the question that would otherwise have cost a card
 *  its acknowledgement. `--replay-user-messages` echoes the envelope back with
 *  its blocks intact, and `Conversation.#echoOf` matches a pending line on
 *  **text** — so what comes back to be matched is the concatenation of the
 *  *text* blocks, with the tokens gone:
 *
 *      drawn:   "Here is the first picture: [a] and here is the second: [b]."
 *      replayed: "Here is the first picture:  and here is the second: ."
 *
 *  Left alone, no image prompt would ever be claimed: the line would keep
 *  `awaited` for the life of the process, the card would read *sent, not picked
 *  up*, and every following `result` would schedule a nudge until the budget
 *  was gone — which is precisely the leak `/model` caused and `turns.md`
 *  records. So `echoOf` derives the matchable string from **the same block list
 *  that goes on the wire**, and the line carries it beside the text it draws.
 *  Two strings, because they answer two questions — the same split `state` and
 *  `awaited` already made for the same reason.
 *
 *  Pure, per the purity boundary: everything here is a fold over a draft and a
 *  list. `attach.svelte.ts` owns the bytes, the decoding and the scaling, which
 *  need a DOM. */

/** What the API will take. Anything else is refused at the door rather than
 *  sent and rejected — a 400 out of a prompt you typed reads as the card being
 *  broken, and names nothing. */
export const MEDIA = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type MediaType = (typeof MEDIA)[number];

/** How many images one prompt may carry.
 *
 *  The API's own ceiling is 100. This is far below it on purpose: twenty
 *  pictures in one sentence is not a thing anybody means to do, and the case
 *  the cap is really for is a folder dragged onto the dock by accident. The
 *  refusal says how many were taken and how many were left. */
export const MAX_ATTACHED = 20;

/** The longest edge an image is sent at.
 *
 *  Anthropic scales anything larger than this down before the model sees it, so
 *  sending more is paying upload and tokens for pixels that are discarded on
 *  arrival. A 4K screen capture is ~8 MB of PNG and ~2.5× this on its long
 *  edge; scaled here it is a few hundred KB, which also keeps it clear of the
 *  per-image ceiling below without anything having to think about it. */
export const MAX_SIDE = 1568;

/** The per-image ceiling, in bytes of the encoded file.
 *
 *  The API's limit is 5 MB and this is the same number: `MAX_SIDE` means
 *  nothing reaches it in practice, so this is a backstop against a pathological
 *  file rather than a budget anybody spends. It is checked *after* scaling,
 *  which is the only measurement that describes what will actually be sent. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** The long edge of the thumbnail kept for the chip and the transcript.
 *
 *  Deliberately a small **data URL** rather than an object URL over the full
 *  bytes. An object URL pins the whole blob alive until something revokes it,
 *  and a line lives for as long as its card does — so a wall left up for a week
 *  would be holding every screenshot ever sent at full size, with the revoke
 *  owed by whichever of four call sites happened to have dropped the last
 *  reference. At this size a thumbnail is a few kilobytes, it survives being
 *  copied into a `Line`, and there is nothing to release. */
export const THUMB_SIDE = 160;

/** One image attached to a draft. */
export type Attachment = {
  /** Identity for the list — never shown, never on the wire. */
  id: string;
  /** What it is called in the draft, and therefore what the token spells. Unique
   *  within one draft; see `uniqueName`. */
  name: string;
  mediaType: MediaType;
  /** The payload as the wire wants it: base64, no data-URL preamble. */
  data: string;
  /** A small data URL, for the chip in the dock and the strip in the panel. */
  thumb: string;
  /** What it came out at, after any scaling — drawn under the chip so a
   *  scaled-down capture says so rather than looking like the original. */
  w: number;
  h: number;
  /** Encoded size in bytes, after scaling. What `MAX_BYTES` is measured in. */
  bytes: number;
  /** True when this was scaled on the way in, so the dock can say so. */
  scaled: boolean;
};

/** One block of a user turn, exactly as `supervisor::user_envelope` writes it. */
export type Block =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: MediaType; data: string };
    };

/** One user turn, ready to send: what goes on the wire, what the wire will
 *  replay for it, and the thumbnails the transcript keeps.
 *
 *  The three travel together because they are three readings of **one** cut of
 *  the draft. Composing twice is how the drawn line and the matched line drift
 *  apart, and the drift is silent — see the header. */
export type Turn = {
  content: Block[];
  /** What `Conversation.#echoOf` must match this line on. */
  echo: string;
  /** Small data URLs, drawn under the prompt in the panel. */
  shots: { name: string; thumb: string }[];
};

/** The token an attachment wears in the draft.
 *
 *  Brackets because that is how a person writes a placeholder without being
 *  taught to, and because it survives being typed over: backspacing through
 *  `[shot 1]` removes the image, which is the whole editing model and needs no
 *  second gesture. */
export function tokenFor(name: string): string {
  return `[${name}]`;
}

/** Is this something we can send? `type` off a `File` is authoritative when it
 *  is set; a drag from some applications leaves it empty, so the extension is
 *  the fallback rather than the other way round. */
export function mediaTypeOf(type: string, name = ""): MediaType | null {
  const t = type.toLowerCase().trim();
  if ((MEDIA as readonly string[]).includes(t)) return t as MediaType;
  /* `image/jpg` is not a media type and is what half the world writes. */
  if (t === "image/jpg") return "image/jpeg";
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/** A name for a file, short enough to read inside a sentence.
 *
 *  The extension is kept: `[diagram.png]` says what it is, and a draft holding
 *  `[diagram]` beside a `diagram` you also typed is ambiguous to read even
 *  though it is not ambiguous to match. */
export function nameFromFile(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  /* A bracket inside the name would end the token early and split one image
     into two things that match nothing. */
  const safe = base.replace(/[[\]]/g, "").trim();
  if (!safe) return "";
  if (safe.length <= 32) return safe;
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 ? safe.slice(dot) : "";
  return safe.slice(0, 32 - ext.length) + ext;
}

/** A name nothing else in this draft is already using.
 *
 *  Two files called `screenshot.png` from two folders is the ordinary case, and
 *  two tokens spelling the same thing would send the first image twice and the
 *  second never — a silent wrong answer, which is the worst kind here because
 *  the draft looks exactly right. */
export function uniqueName(taken: readonly string[], suggested: string): string {
  const base = suggested || "image";
  if (!taken.includes(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n++) {
    const tried = `${stem} ${n}${ext}`;
    if (!taken.includes(tried)) return tried;
  }
}

/** The name a pasted image gets, which has no file behind it to be named
 *  after.
 *
 *  Numbered from what the draft already holds rather than from a counter, so a
 *  draft cleared and started again begins at one — a counter would have the
 *  first paste of the afternoon come out `[image 47]`. Not `uniqueName`'s job:
 *  that one disambiguates a name somebody else chose, and would answer
 *  `image 1 2` here. */
export function pastedName(taken: readonly string[]): string {
  for (let n = 1; ; n++) {
    const tried = `image ${n}`;
    if (!taken.includes(tried)) return tried;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which attachments the draft still refers to.
 *
 *  Deleting a token is how an image is detached — there is no separate remove
 *  gesture to remember, and an image whose token you typed over is one you
 *  plainly did not mean to send. The dock prunes on this after every keystroke,
 *  so the strip of chips and the sentence can never disagree. */
export function stillIn(text: string, list: readonly Attachment[]): Attachment[] {
  return list.filter((a) => text.includes(tokenFor(a.name)));
}

/** Cut the draft at its tokens into the blocks one user turn is made of.
 *
 *  An empty text block is dropped rather than sent: the API refuses one, and
 *  `[a][b]` with nothing between them would otherwise produce one. Whitespace
 *  between two tokens goes the same way, which is why `echoOf` is derived from
 *  what comes out of here rather than from the draft — the two differ, and only
 *  one of them is what the wire will replay. */
export function compose(text: string, list: readonly Attachment[]): Block[] {
  const attached = stillIn(text, list);
  const image = (a: Attachment): Block => ({
    type: "image",
    source: { type: "base64", media_type: a.mediaType, data: a.data },
  });
  const words = (s: string): Block[] => (s.trim() ? [{ type: "text", text: s }] : []);

  if (!attached.length) return words(text);

  /* Longest first, so a name that is a prefix of another one cannot claim the
     longer one's token — `[shot]` must not match inside `[shot 2]`. */
  const byToken = new Map(attached.map((a) => [tokenFor(a.name), a]));
  const re = new RegExp(
    [...byToken.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join("|"),
    "g",
  );

  const out: Block[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    out.push(...words(text.slice(at, m.index)));
    out.push(image(byToken.get(m[0])!));
    at = m.index + m[0].length;
  }
  out.push(...words(text.slice(at)));
  return out;
}

/** One stretch of the draft as the dock draws it: prose, or a token to be drawn
 *  as a chip. */
export type Run = { text: string; chip: boolean };

/** Cut the draft into runs so the tint layer can draw the tokens as chips.
 *
 *  **The runs must concatenate back to exactly what went in.** The tint is drawn
 *  *behind* a transparent textarea and the caret is the textarea's own, so one
 *  dropped space puts every character after it over the wrong glyph and the
 *  caret lands in the middle of a word. That is not a new rule — `bang.ts`'s
 *  `tokens` carries the same one for the same layer, and the test below is the
 *  same test.
 *
 *  A chip is only ever a *whole* token of an attachment that is really attached,
 *  so `[not an image]` typed by hand is prose and stays prose. Which also means
 *  the drawing cannot disagree with `compose`: both ask `stillIn` the same
 *  question and match the same tokens the same way. */
export function runsOf(text: string, list: readonly Attachment[]): Run[] {
  const attached = stillIn(text, list);
  if (!attached.length) return text ? [{ text, chip: false }] : [];

  const re = new RegExp(
    attached
      .map((a) => tokenFor(a.name))
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join("|"),
    "g",
  );

  const out: Run[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), chip: false });
    out.push({ text: m[0], chip: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), chip: false });
  return out;
}

/** What the wire will replay for these blocks, and therefore what a pending
 *  line has to be matched on.
 *
 *  This is the extractor in `Conversation.ingest`'s `user` arm, run forwards:
 *  the text blocks joined, the image blocks contributing nothing. Derived from
 *  the blocks rather than from the draft on purpose — a second implementation
 *  of the split is a second thing to get wrong, and the failure it produces is
 *  silent (see the header). */
export function echoOf(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Does this turn carry anything at all? A draft that is nothing but a token
 *  for an image that is no longer attached composes to nothing, and sending an
 *  empty `content` is a 400 rather than a quiet no-op. */
export function isEmpty(blocks: readonly Block[]): boolean {
  return blocks.length === 0;
}

/** How big to decode an image, given what it really is.
 *
 *  `null` means "leave it alone", which is the ordinary answer: most things
 *  pasted here are already smaller than the ceiling, and re-encoding one costs
 *  quality for nothing. Only a picture over the long edge is touched. */
export function scaleTo(
  w: number,
  h: number,
  max = MAX_SIDE,
): { w: number; h: number } | null {
  const long = Math.max(w, h);
  if (long <= max || long === 0) return null;
  const k = max / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** What a scaled image should be re-encoded as.
 *
 *  Its own type wherever the canvas can write one, because a PNG screen capture
 *  re-encoded as JPEG picks up ringing on exactly the thing it was captured to
 *  show — text and thin UI lines. GIF is the one that cannot survive the round
 *  trip as itself (a canvas has one frame), so a GIF large enough to need
 *  scaling becomes a PNG and loses its animation; a small one is never
 *  re-encoded at all and keeps it. */
export function encodeAs(source: MediaType): MediaType {
  return source === "image/gif" ? "image/png" : source;
}

/** The reading under a chip: what it is, and whether we changed it. */
export function sizeNote(a: Attachment): string {
  const kb = a.bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(a.bytes / 1024))} KB`
    : `${(a.bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${a.w}×${a.h} · ${kb}${a.scaled ? " · scaled" : ""}`;
}

/** Take an image out of the draft by taking its token out of the sentence.
 *
 *  The `✕` on a chip and backspacing over the token are the *same* act, and
 *  this is why: an attachment exists by being mentioned, so removing one can
 *  only mean editing the text. A remove that dropped the picture and left
 *  `[shot 1]` sitting in the sentence would leave a prompt referring to
 *  something the agent never receives — which is the one failure that reads as
 *  the agent not looking properly.
 *
 *  Every occurrence goes, since a token pasted twice is one image mentioned
 *  twice. The spacing on either side is collapsed back to one, so a sentence
 *  does not end up with a gap where the chip was. */
export function dropToken(text: string, name: string): string {
  const gone = text.split(tokenFor(name)).join("");
  /* Only the gap the removal itself opened is closed: runs of spaces collapse
     and the head and tail are trimmed, but newlines are left alone. A draft
     with a deliberate blank line in it is one somebody laid out, and tidying
     that would be this function having an opinion about prose nobody asked it
     about. */
  return gone
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
}

/** Put a token into the draft where the caret is, with the spacing a person
 *  would have typed.
 *
 *  A token jammed against the previous word reads as part of it, and one that
 *  arrives with a leading space at the start of an empty draft is a draft that
 *  begins with a space. Both are small and both are the sort of thing you
 *  notice every single time. */
export function insertAt(
  text: string,
  caret: number | null,
  token: string,
): { text: string; caret: number } {
  const at = caret === null ? text.length : Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  const put = lead + token + tail;
  return { text: before + put + after, caret: at + lead.length + token.length };
}
