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

import { textOf } from "./classify";

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

/** The most one prompt may cost on the wire to a card on another wall: its
 *  words as JSON and every picture's base64, together. `attach::CARRY_MOST` in
 *  Rust, held equal by `test/attach.test.ts`.
 *
 *  The frame's number rather than the API's: a prompt to another wall rides
 *  one sealed frame, a frame is at most 8 MB, and a wall that is sent a larger
 *  one fails the whole exchange — the sink and the cards beside it. A megabyte
 *  under, for the rest of the request and the seal. One picture at `MAX_BYTES`
 *  fits; several full-size screenshots together may not, and are refused with
 *  the draft kept (`handle.ts::carriesTo`). A card on this wall has no such
 *  ceiling — the one difference a picture to another wall has. */
export const CARRY_MOST = 7 * 1024 * 1024;

/* A prompt with pictures is held like any other when every account is at its
   limit, pictures and all — and that is the one place a picture is ever
   written to disk. Until 2026-10-16 it was refused instead (`PICTURES_NOT_HELD`,
   "a prompt with pictures is not held"), because the hold kept text alone and
   the rule here is that an attachment never touches the disk. Lyss's call:
   a held message has to survive a restart, so the hold carries its pictures
   into the store and takes them out again in the same write that takes the
   message out (`store::migrate_v54`, `holding.ts`). Nothing else is written. */

/** The one kind of document the API reads inline, which is what a chat card —
 *  no filesystem, no `Read` — can be given beside a picture. Probed with
 *  `tools/probe-document.ts`: a `document` block on stdin reaches the model and
 *  the replay keeps it, so the echo is still its text blocks. */
export const DOCUMENT = "application/pdf";

/** The most one file may be when its bytes have to be *held* rather than
 *  pointed at: a browser drag or a pasted blob, written into the card's folder
 *  at send, or a PDF read inline for a chat card, or a file crossing to another
 *  wall. `look.rs`'s `FILE_MOST` is the same number, since the flyway is what
 *  carries one across, and `attachments.rs` holds it too. */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

/** The most a PDF may be when it goes inline. Below `MAX_FILE_BYTES` because
 *  base64 is a third larger than what it encodes and the API takes 32 MB of
 *  request — a 24 MB PDF would be refused on the wire with a 400 that names
 *  nothing. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Where the draft is going — the one thing about a target that decides what
 *  an attachment becomes on the wire.
 *
 *  `chat`: a chat card has no filesystem (`chat.md`), so a path means nothing
 *  to it, and pictures and PDFs go inline while everything else is refused.
 *  `afar`: a card on another wall, which is handed the bytes and writes them on
 *  its own disk, so nothing is written or read here. */
export type Reach = { chat: boolean; afar: boolean };

/** One image attached to a draft. Sent inline, as an `image` block, to any
 *  card — this is the attachment the dock had from the start. */
export type Picture = {
  kind: "picture";
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

/** A file or folder on this machine, attached by its path.
 *
 *  **Passed as the path, as it is** (Lyss, 2026-10-16): the agent reads it with
 *  its own tools, which is what Claude Code does when a file is dragged into a
 *  terminal, so nothing is copied and nothing is spent up front whatever the
 *  file is. The token in the draft is replaced by the path itself when the turn
 *  is cut (`resolveFiles`) — so to everything past the cut, a file is words. */
export type FileRef = {
  kind: "file";
  id: string;
  name: string;
  path: string;
  /** True for a folder, which is attached the same way (decided 2026-10-18:
   *  a folder dropped *into* an input is its path; on the wall it opens a
   *  card). */
  dir: boolean;
  /** Bytes on disk, when known — drawn under the tile. */
  size: number | null;
};

/** Bytes with no path behind them: a browser drag, a pasted file that is not a
 *  picture. They have to be *written* somewhere before a project card can read
 *  them, and that happens at the send, into the card's own folder
 *  (`attachments.rs`) — so an unsent draft never touches the disk. A PDF among
 *  them goes inline to a chat card instead. */
export type Bytes = {
  kind: "bytes";
  id: string;
  name: string;
  /** What the file says it is; empty when nothing said. */
  mediaType: string;
  /** base64, no data-URL preamble. */
  data: string;
  bytes: number;
};

/** Anything attached to a draft. */
export type Attachment = Picture | FileRef | Bytes;

/** One block of a user turn, exactly as `supervisor::user_envelope` writes it. */
export type Block =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: MediaType; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: typeof DOCUMENT; data: string };
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
  /** The pictures themselves, by name, for a card on another wall — whose
   *  wall is handed the sentence with its tokens and these, and cuts it again
   *  with `turnOf` exactly as this one did. Not kept past the send: a `Line`
   *  takes `shots`, never this. */
  carried: Carried[];
  /** The sentence as it goes: picture tokens kept (another wall cuts at them,
   *  and a held message is re-cut at them), and every file token already
   *  replaced by its path — so past this point a file is words, and nothing
   *  downstream (the hold, a combined round, the echo) has to know files
   *  exist. For another wall the file tokens stay, and `files` says what they
   *  are, because a path here means nothing there. */
  text: string;
  /** Files the sentence still names that were *not* resolved to a path: only
   *  ever non-empty for a card on another wall, whose wall is handed their
   *  bytes and writes them on its own disk (`elsewhere.md`). */
  files: (FileRef | Bytes)[];
};

/** One picture as another wall is handed it — `fleet::Picture` in Rust, field
 *  for field. */
export type Carried = { name: string; mediaType: MediaType; data: string };

/** Something that goes on the wire inline, beside the words: a picture, or a
 *  PDF for a card that cannot be given a path. */
type Inline = { name: string; mediaType: string; data: string };

const inline = (a: Attachment): a is Picture | Bytes => a.kind !== "file";

/** The turn a sentence and its attachments make: cut once at the tokens, and
 *  every reading of the cut taken from that one cut.
 *
 *  The draft's own send (`Field.turn`) and a prompt arriving from another wall
 *  (`Elsewhere.#take`) both come here, so a picture sent across is composed on
 *  the wall that sends it exactly as it would have been on the wall it went
 *  to. A second split would be a second thing to get wrong, and its failure is
 *  silent: the line is never claimed, the card reads *sent, not picked up*, and
 *  the nudge budget goes. See the header.
 *
 *  `planFor` comes first for anything but pictures: it says which bytes must
 *  be written and which files read before this list is one a target can take.
 *  What reaches here is cut as it stands. */
export function turnOf(
  text: string,
  list: readonly Attachment[],
  reach: Reach = { chat: false, afar: false },
): Turn {
  const said = reach.afar ? text : resolveFiles(text, list);
  const content = compose(said, list.filter(inline));
  /* Only the ones the sentence still mentions — a picture whose token was
     typed over is one you plainly did not mean to send. */
  const kept = stillIn(said, list.filter((a): a is Picture => a.kind === "picture"));
  return {
    content,
    echo: echoOf(content),
    shots: kept.map((a) => ({ name: a.name, thumb: a.thumb })),
    carried: kept.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data })),
    text: said,
    files: reach.afar
      ? stillIn(said, list.filter((a): a is FileRef | Bytes => a.kind !== "picture"))
      : [],
  };
}

/** A path as it is written into a sentence for an agent to read.
 *
 *  As Claude Code writes one it was handed by a drag: bare, and quoted only
 *  when a space in it would otherwise make it two words. */
export function pathText(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** The sentence with every attached file's token replaced by its path.
 *
 *  This is the whole of how a file reaches a project card, and it is done to
 *  the *text*, so the turn, the echo, a held message and a combined round all
 *  carry a file as the words it now is. */
export function resolveFiles(text: string, list: readonly Attachment[]): string {
  let out = text;
  for (const a of stillIn(text, list)) {
    if (a.kind === "file") out = out.split(tokenFor(a.name)).join(pathText(a.path));
  }
  return out;
}

/** What has to happen to a draft's attachments before it can go to this
 *  target, or why it cannot.
 *
 *  - `write`: bytes for a project card here, written into the card's folder at
 *    the send and then attached by the path that gives them;
 *  - `read`: PDFs on disk for a chat card, read in to go inline;
 *  - `refused`: the first reason any of it cannot go, naming the file — said
 *    with the draft kept, never after the words have gone.
 *
 *  A card on another wall needs nothing done here: its own wall is handed the
 *  bytes and does this on its side of the link. */
export function planFor(
  text: string,
  list: readonly Attachment[],
  reach: Reach,
): { write: Bytes[]; read: FileRef[]; refused: string | null } {
  const write: Bytes[] = [];
  const read: FileRef[] = [];
  const used = stillIn(text, list);
  for (const a of used) {
    if (a.kind === "picture") continue;
    if (a.kind === "bytes" && a.bytes > MAX_FILE_BYTES) {
      return { write, read, refused: `${a.name} is ${mb(a.bytes)} — the most one attachment may be is ${mb(MAX_FILE_BYTES)}` };
    }
  }
  if (reach.afar) return { write, read, refused: null };
  for (const a of used) {
    if (a.kind === "picture") continue;
    if (!reach.chat) {
      if (a.kind === "bytes") write.push(a);
      continue;
    }
    /* A chat card: no filesystem, so a path is nothing to it. */
    const pdf = a.kind === "bytes" ? isDocument(a.mediaType, a.name) : !a.dir && isDocument("", a.name);
    if (!pdf) {
      return {
        write: [],
        read: [],
        refused: a.kind === "file" && a.dir
          ? `${a.name} is a folder, and a chat card has no files to open it with — only pictures and PDFs can be given to one`
          : `${a.name} cannot be given to a chat card — it has no files to open it with, and only pictures and PDFs go to one inline`,
      };
    }
    if (a.kind === "bytes" && a.bytes > MAX_DOCUMENT_BYTES) {
      return { write: [], read: [], refused: `${a.name} is ${mb(a.bytes)} — a PDF given inline may be at most ${mb(MAX_DOCUMENT_BYTES)}` };
    }
    if (a.kind === "file") read.push(a);
  }
  return { write, read, refused: null };
}

/** Is this a PDF? The type when one was given, the extension otherwise —
 *  `mediaTypeOf`'s order, for its reason. */
export function isDocument(type: string, name = ""): boolean {
  const t = type.toLowerCase().trim();
  if (t) return t === DOCUMENT;
  return /\.pdf$/i.test(name);
}

function mb(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** What a turn would cost on the wire to another wall, measured exactly as
 *  `attach::carried_fit` measures it — the sentence as JSON in UTF-8, and each
 *  picture's base64 with its name and type — so the dock refuses what the link
 *  would, and never clears a draft the link then turns away. */
export function carriedCost(turn: Turn): number {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  let cost = bytes(JSON.stringify(turn.text));
  for (const c of turn.carried) cost += c.data.length + bytes(c.name) + c.mediaType.length + 48;
  return cost;
}

/** Whether a picture's first bytes are the format its media type names — the
 *  check `attach::carried_fit` makes, asked here too so a refusal keeps the
 *  draft. A file dropped as `photo.png` that is really a JPEG keeps the type
 *  its extension gave it (`read_attachment`), and the API refuses a request
 *  where the two disagree with a 400 that names nothing. */
export function looksLike(c: Carried): boolean {
  let head: string;
  try {
    head = atob(c.data.slice(0, 16));
  } catch {
    return false;
  }
  const at = (s: string, i = 0) => head.slice(i, i + s.length) === s;
  switch (c.mediaType) {
    case "image/png":
      return at("\x89PNG\r\n\x1a\n");
    case "image/jpeg":
      return at("\xFF\xD8\xFF");
    case "image/gif":
      return at("GIF87a") || at("GIF89a");
    case "image/webp":
      return at("RIFF") && at("WEBP", 8);
  }
}


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
export function stillIn<T extends { name: string }>(text: string, list: readonly T[]): T[] {
  return list.filter((a) => text.includes(tokenFor(a.name)));
}

/** Cut the draft at its tokens into the blocks one user turn is made of.
 *
 *  An empty text block is dropped rather than sent: the API refuses one, and
 *  `[a][b]` with nothing between them would otherwise produce one. Whitespace
 *  between two tokens goes the same way, which is why `echoOf` is derived from
 *  what comes out of here rather than from the draft — the two differ, and only
 *  one of them is what the wire will replay. */
export function compose(text: string, list: readonly Inline[]): Block[] {
  const attached = stillIn(text, list);
  /* A picture is an `image` block and a PDF a `document` one. Anything else
     has no inline form: `planFor` refuses it before a turn is cut, and should
     one reach here anyway its token stays in the words — a draft that says
     `[notes.zip]` to the agent is wrong in a way the agent can see, where a
     block quietly left off is wrong in a way nobody can. */
  const block = (a: Inline): Block | null =>
    (MEDIA as readonly string[]).includes(a.mediaType)
      ? { type: "image", source: { type: "base64", media_type: a.mediaType as MediaType, data: a.data } }
      : a.mediaType === DOCUMENT
        ? { type: "document", source: { type: "base64", media_type: DOCUMENT, data: a.data } }
        : null;
  const sendable = attached.filter((a) => block(a) !== null);
  const words = (s: string): Block[] => (s.trim() ? [{ type: "text", text: s }] : []);

  if (!sendable.length) return words(text);

  /* Longest first, so a name that is a prefix of another one cannot claim the
     longer one's token — `[shot]` must not match inside `[shot 2]`. */
  const byToken = new Map(sendable.map((a) => [tokenFor(a.name), a]));
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
    out.push(block(byToken.get(m[0])!)!);
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
export function runsOf(text: string, list: readonly { name: string }[]): Run[] {
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
  /* `textOf` itself, not a second spelling of it. The first version joined the
     text blocks with "" while `textOf` has always joined them with a newline,
     so no prompt with a picture in it was ever claimed: the replay pushed a
     second `you` line and the card was nudged about a prompt it had answered.
     Found 2026-10-15 driving a picture across two lab walls — the first time
     the feature met a running app. */
  return textOf(blocks);
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
  if (a.kind === "file") {
    if (a.dir) return "folder · sent as its path";
    return a.size === null ? "sent as its path" : `${mb(a.size)} · sent as its path`;
  }
  if (a.kind === "bytes") return `${mb(a.bytes)}${isDocument(a.mediaType, a.name) ? " · pdf" : ""}`;
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
