/* What a message from another card looks like once it is in a transcript.
 *
 * The recipient's CLI replays a relayed prompt as a plain `user` message —
 * exactly the shape of something you typed — so the panel has one job here and
 * it is not cosmetic: say that this was not you. Left alone it would be drawn
 * in your register, in your card, with nothing on the page distinguishing an
 * instruction another agent gave from one you gave.
 *
 * Recognised off the words themselves, the way `rousing.ts::isResumePrompt`
 * recognises a resume and for the same reason: the live fold and the one that
 * reads a session back off disk share nothing but the text. Nothing on the wire
 * carries a flag, and a column would not survive `--resume` reading the
 * transcript from the CLI's own file.
 *
 * `relay.rs::envelope` writes what this reads. Pure — no runes — so both ends
 * of the round trip can be asserted directly.
 */

/** The first line of every relayed message. Must match `relay::RELAY_MARK`. */
export const RELAY_MARK = "[skein relay]";

/** The first line of a wake. Must match `later::WAKE_MARK`.
 *
 *  Its own string rather than a relay envelope, and `later.rs` is right about
 *  why: there is nobody at the other end of a wake, so a header naming a sender
 *  would be a lie. What was missing was this end. Nothing in `src/` knew the
 *  string, so a wake fell through to the plain `user` arm and was drawn in your
 *  own register, in your own card, with nothing on the page saying you had not
 *  typed it — the exact bug this file exists to prevent, wearing the one dress
 *  it did not check for.
 *
 *  It is recognised *here*, beside the relay, rather than as a sixth line kind
 *  in the panel: the panel's job is identical in every case and it is to say
 *  this was not you. Only the cap and the hint differ, and both are one
 *  function each. And the mark is not being changed to a relay one, however
 *  tidy that would be — every transcript already on this machine carries
 *  `[skein wake]`, and `history.ts` reads those back off disk. */
export const WAKE_MARK = "[skein wake]";

/** Who a message came from, as far as the envelope says. */
export type RelayFrom = {
  /** The sender's title when it was sent, which is not necessarily its title
   *  now — cards are renamed as the work clarifies, and what the transcript
   *  keeps is what was true. */
  name: string;
  handle: string;
  project: string | null;
  /** Only on a wake: how long it was armed before it fired, in seconds. */
  waitedS?: number;
};

/** What a wake calls itself — the card's own note, never "you". "You" means
 *  the person at the keyboard everywhere else on the wall, and a note the
 *  agent left itself drawn under that word reads as an instruction from them. */
export const WAKE_NAME = "note to self";

/** "8 minutes ago" / "45 seconds ago" / "3 hours ago" → seconds, or null. */
function phraseSeconds(phrase: string): number | null {
  const m = /^(\d+) (second|minute|hour)s? ago$/.exec(phrase.trim());
  if (!m) return null;
  return Number(m[1]) * { second: 1, minute: 60, hour: 3600 }[m[2] as "second" | "minute" | "hour"];
}
/* Four shapes. A sender can be closed between writing a message and its
 * recipient waking up to read it, so the second keeps the handle — still the
 * only thing that identifies what said it. The third is not a message at
 * all: a standing notice off the billboard, which came to find this card
 * because it edited a file the notice covers (`board.rs::on_touch`). And the
 * fourth has no author anywhere — the wall telling a parent that cards it
 * opened have stopped (`spawn::envelope`), which is a fold over an event rather
 * than anything anybody wrote.
 *
 * One mark and one recogniser for all four, deliberately — the panel's job is
 * the same in every case, which is to say this was not you. The alternative for
 * the last two was a mark apiece, and `later.rs` took it: `[skein wake]` is its
 * own string, and for a fortnight the front end did not know it, so a wake was
 * drawn as something you typed. A shape under a mark that is already recognised
 * cannot go wrong that way — which is the argument, and it is an argument about
 * cost rather than about correctness. The fifth shape below is under the second
 * mark and is read correctly now (sink af952612); what it cost was a constant,
 * a regex, a predicate and a branch in `transcript.ts`, none of which the first
 * four needed. */
const HEADED =
  /^\[skein relay\] from "(.*?)" \(([0-9a-f]{4,36})\)(?: in (.+?))? —\s*$/;
const ORPHANED =
  /^\[skein relay\] from a card that has since been closed \(([0-9a-f]{4,36})\) —\s*$/;
const NOTICE = /^\[skein relay\] from the billboard —/;
const WALL = /^\[skein relay\] from the wall —/;
/* A sixth, and the one whose author is the card itself, earlier: the note a
   card wrote before renewing (`renew.rs::compose`), which its fresh session
   opens on. Under the relay mark for the reason the comment above gives. Its
   own predicate because the thread draws it as a divider — a session
   boundary inside one card — rather than as a message among messages. */
const RENEWED = /^\[skein relay\] renewed —/;
/* A seventh, and the first that is not somebody talking to this card: the
   brief it was handed to start with (`handOver`). A spawned card's first
   prompt, the plan a maker card is opened with, and the check a card gets on
   arriving from another wall are all free prose about work to do — nearly
   always an agent's, and the wall's own for a move-in — so off disk they were
   indistinguishable from something you typed. `own.ts` has the whole of that
   gap. Under the relay mark so both folds can tell they are not yours at all,
   and with a shape of its own so the panel can say *what* they are. A probe
   settled that the wire itself cannot carry a mark (`tools/probe-mark.ts`), so
   the words have to. */
const HANDED = /^\[skein relay\] handed over —\s*$/;

/** What the cap calls a handover. */
export const HANDOVER_NAME = "handed over";

/** Whether this line is a handover: a spawned card's brief, a plan handover,
 *  or the check a card is handed when it arrives on another wall (`handOver`).
 *  The last is not an opening brief and not an agent's words, which is why the
 *  note under the header is a parameter rather than a constant. */
export function isHandoverPrompt(text: string): boolean {
  const head = text.trimStart().split("\n", 1)[0] ?? "";
  return HANDED.test(head);
}

/** The brief, without the header or the note under it — what the prompt
 *  actually says, and what the panel draws in the prompt's own register. */
export function handoverBody(text: string): string {
  return relayBody(text);
}

/** One of the wall's briefs, enveloped for the wire and the session file.
 *
 *  The panel draws `handoverBody` of what goes on the wire, so what is read is
 *  the brief; the envelope is what the two folds and the child are given. It
 *  travels inside the text because a field on the user envelope is dropped by
 *  the CLI before either the replay or the session record (probed).
 *
 *  The note is a parameter because the three handovers are not the same kind of
 *  thing. A spawn's brief and a plan handover are what the card started with;
 *  the one a moved card gets (`moving::confirm_prompt`) is a check that its
 *  history arrived, and calling that an opening brief is a sentence the model
 *  can read and be misled by on the one turn that decides whether the move is
 *  accepted. */
export function handOver(brief: string, note: string = HANDOVER_NOTE): string {
  return `${RELAY_MARK} handed over —\n\n${brief.trim()}\n\n${note}`;
}

/** The paragraph under an opening brief, addressed to the model: whose words
 *  these are. Not the relay's "answer to its handle" note — there is nothing
 *  here to answer, and a child told to reply to a brief would spend its first
 *  turn replying to its own instructions.
 *
 *  "Written for this card" rather than "written by an agent", which would be
 *  false of the check a moved card receives: the wall composes that. Who *did*
 *  write a brief is the child's own provenance, which its system prompt
 *  already carries. */
export const HANDOVER_NOTE =
  "(This is the brief this card started with, written for it rather than typed here by the person at the keyboard.)";

/** The paragraph under the check a card is handed on arriving at another wall
 *  (`openMoved`). Not a brief and not something the card started with: it is a
 *  cloze question about its own history, and the move is refused if the answer
 *  does not show it arrived. */
export const MOVED_NOTE =
  "(This is the wall's check that this card arrived with its history, not something the person at this keyboard typed.)";

/** The name the cap gives a renewal's note. */
export const RENEW_NAME = "renewed";

/** Whether this line is the note a renewed card's fresh session opened on. */
export function isRenewPrompt(text: string): boolean {
  return RENEWED.test(text.trimStart());
}
/* The fifth shape, and the only one under the other mark. `later::envelope`
   writes "…woken about this 5 minutes ago, and it is now:"; the elapsed phrase
   is the one thing in that header worth keeping, so it is lifted into the name
   and ends up in the fold cap rather than being stripped with the line. */
const WAKE = /^\[skein wake\] you asked to be woken about this (.+?), and it is now:\s*$/;

/** Whether this line is one somebody other than you put in your card.
 *
 *  Six shapes under two marks. The name is what it decides — the `relay` line
 *  kind — rather than what wrote it; a wake is not a relay and is still not
 *  yours, and `isWakePrompt` is what tells them apart afterwards. */
export function isRelayPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(RELAY_MARK) || t.startsWith(WAKE_MARK);
}

/** Whether it is a wake specifically — a note you left yourself, handed back.
 *
 *  Asked by `transcript.ts` for the fold's hint, which is the one place where
 *  "another card sent this" and "you asked for this" are not interchangeable. */
export function isWakePrompt(text: string): boolean {
  return text.trimStart().startsWith(WAKE_MARK);
}

/** Who sent it, or `null` for anything that is not one of ours.
 *
 *  Degrades rather than refuses, the bargain `normalizeAsk` strikes: a message
 *  whose header this build cannot parse is still a message the agent was given
 *  and acted on, so it is drawn as a relay from nobody rather than redrawn as
 *  something you typed. Getting that wrong in the other direction is the whole
 *  bug this file exists to prevent. */
export function relayFrom(text: string): RelayFrom | null {
  if (!isRelayPrompt(text)) return null;
  const head = text.trimStart().split("\n", 1)[0] ?? "";
  /* Before the relay shapes, since it is under the other mark entirely. The
     author of a wake is this card, earlier — which is a real answer and not a
     degradation, so it is named rather than falling through to "another card".
     A header this build cannot parse still says it was a wake. */
  const w = WAKE.exec(head);
  if (w) {
    const waitedS = phraseSeconds(w[1]);
    return { name: WAKE_NAME, handle: "", project: null, ...(waitedS === null ? {} : { waitedS }) };
  }
  if (isWakePrompt(text)) return { name: WAKE_NAME, handle: "", project: null };
  const m = HEADED.exec(head);
  if (m) return { name: m[1], handle: m[2], project: m[3] ?? null };
  const o = ORPHANED.exec(head);
  if (o) return { name: "a closed card", handle: o[1], project: null };
  /* The notice names its own author inside the header rather than in a field,
     because a notice outlives the card that posted it — see `board_envelope`.
     What the cap wants to say is where it came from, and that is the board. */
  if (NOTICE.test(head)) return { name: "the billboard", handle: "", project: null };
  /* No handle and no card, and that is not a degradation — nothing sent this.
     Naming the wall is what stops it reading as "from another card", which
     would be the panel inventing an author for a line that has none. */
  if (WALL.test(head)) return { name: "the wall", handle: "", project: null };
  if (RENEWED.test(head)) return { name: RENEW_NAME, handle: "", project: null };
  if (HANDED.test(head)) return { name: HANDOVER_NAME, handle: "", project: null };
  return { name: "another card", handle: "", project: null };
}

/** The message itself, without the header or the note under it.
 *
 *  The note is addressed to the model — it says who this is from and that
 *  silence is a legitimate reply — and reading it is not the same as reading
 *  the message. Kept out of the drawn body rather than out of the fold: opening
 *  the line shows what the agent was actually handed, which is the point of
 *  having the line at all. */
export function relayBody(text: string): string {
  const t = text.trimStart();
  if (!isRelayPrompt(t)) return text;
  const nl = t.indexOf("\n");
  let body = nl === -1 ? "" : t.slice(nl + 1);
  /* Written by `envelope` as its own trailing paragraph, so it is matched
     whole. A message that happens to end in a parenthesis is untouched. */
  const note = Math.max(
    body.lastIndexOf("\n\n(This came from another agent"),
    body.lastIndexOf("\n\n(This is a standing notice"),
    body.lastIndexOf("\n\n(This came from the wall"),
    body.lastIndexOf("\n\n(This is your own note to yourself"),
    body.lastIndexOf("\n\n(This is the brief this card started with"),
    body.lastIndexOf("\n\n(This is the wall's check that this card arrived"),
  );
  if (note !== -1) body = body.slice(0, note);
  return body.trim();
}

/** What the fold says while it is closed.
 *
 *  Short, because a fold cap is `nowrap` with an ellipsis in a panel a third of
 *  a window wide — the same constraint `RESUME_CAP` is written to. It names the
 *  sender rather than quoting the message, for the reason `askHeadline` does:
 *  a cut-off first sentence names nothing. */
export function relayCap(text: string): string {
  const from = relayFrom(text);
  if (from?.name === WAKE_NAME) {
    return from.waitedS === undefined ? WAKE_NAME : `${WAKE_NAME} · waited ${spanWords(from.waitedS)}`;
  }
  if (from?.name === RENEW_NAME) return "renewed · the note this session started from";
  if (from?.name === HANDOVER_NAME) return "handed over · written for this card";
  return from ? `from ${from.name}` : "from another card";
}

/* One more shape under this mark and the comment above the four is still the
   whole argument: a mark apiece is what let `[skein wake]` be written by Rust
   and read by nobody for as long as it took somebody to be in `later.rs` for
   another reason. Anything new that puts words in a card that the user did not
   type belongs in `isRelayPrompt` on the day it is written, not the day it is
   noticed. */

/** "8 minutes", "45 seconds", "2 hours" — the span `later.rs::said` wrote. */
export function spanWords(secs: number): string {
  if (secs < 90) return `${secs} seconds`;
  const mins = Math.floor(secs / 60);
  if (mins < 90) return `${mins} minutes`;
  return `${Math.floor(mins / 60)} hours`;
}

/** The two times a wake carries, said so they cannot be mistaken for each
 *  other: when it was armed, and when the wall handed it back. The envelope's
 *  own "N minutes ago" is the wait, measured at delivery, so the armed time is
 *  that plus however long ago it was delivered. `deliveredAgo` is the coarse
 *  `ageOf` string, "" when the line has no time. */
export function wakeTimes(
  from: RelayFrom,
  deliveredMsAgo: number | null,
  ageOf: (ms: number) => string,
): string {
  const parts: string[] = [];
  if (from.waitedS !== undefined && deliveredMsAgo !== null) {
    parts.push(`armed ${ageOf(from.waitedS * 1000 + deliveredMsAgo)} ago`);
  } else if (from.waitedS !== undefined) {
    parts.push(`waited ${spanWords(from.waitedS)}`);
  }
  if (deliveredMsAgo !== null) parts.push(`delivered ${ageOf(deliveredMsAgo)} ago`);
  return parts.join(" · ");
}

/** What a card is called on the roster, given only its id.
 *
 *  Must agree with `relay::handle_of`. Here so the wall can label a strand
 *  whose endpoint has already been closed, which is the one case where there is
 *  no title left to use. */
export function handleOf(id: string): string {
  return id.slice(0, 8);
}

/** Must agree with `classify.ts::SKEIN_SEND_TOOL`; restated rather than
 *  imported for `chatview.ts::SPAWN_TOOL`'s reason, and held by a test. */
export const SEND_TOOL = "mcp__skein__send";

/** What a `send` call said and to whom, read off its arguments — or null when
 *  the call is something else. `to` is as the agent wrote it: a handle, a
 *  title, `project` or `skein`, or a list of those. `delivered` is null while
 *  no result has landed, then whether the wall took it. */
export function sentOf(call: { name: string; input: unknown; result?: { text: string; failed?: true } } | undefined): {
  to: string[];
  message: string;
  delivered: boolean | null;
  why: string;
  /** What `send_files` carried, read off its receipt; null for a `send`. */
  parcel: Parcel | null;
} | null {
  if (!call || (call.name !== SEND_TOOL && call.name !== SEND_FILES_TOOL)) return null;
  const input = (call.input ?? {}) as { to?: unknown; message?: unknown };
  const files = call.name === SEND_FILES_TOOL;
  const to = (Array.isArray(input.to) ? input.to : [input.to])
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .map((t) => t.trim());
  const message = typeof input.message === "string" && input.message.trim() ? input.message : files ? "Files for you." : "";
  /* A refusal of a send_files arrives as an ordinary result — the call itself
     succeeded — so a parcel that did not go is one whose receipt carries no
     block. */
  const parcel = files && call.result && !call.result.failed ? parcelOf(call.result.text).parcel : null;
  /* Another wall that has not answered yet is not a refusal (`reach.rs::unanswered`). */
  const unknown = files && !!call.result && !call.result.failed && / has not said whether /.test(call.result.text);
  const refused = files && !!call.result && !call.result.failed && !parcel && !unknown;
  const delivered = call.result && !unknown ? !call.result.failed && !refused : null;
  const why = call.result && (call.result.failed || refused) ? (call.result.text.split("\n").find((l) => l.trim()) ?? "").trim() : "";
  return { to, message, delivered, why, parcel };
}

/* ── a parcel: files that came with a message ─────────────────────────────
 *
 * `send_files` (`parcel.rs`) appends a block to the message it sends: a header
 * line opening with `PARCEL_MARK`, one line per top-level thing sent (`+`) and
 * per thing left out (`-`), fields split on ` · `, then a blank line and a note
 * addressed to the model. The block is for the agent; the plate drawn under the
 * message (`Parcel.svelte`) is the same lines read back, so a person sees what
 * the agent was told it has. Read off the text, as everything about a relay is,
 * because the live fold and a transcript read back share nothing but the text.
 */

/** `parcel.rs::PARCEL_MARK`. Held equal by `test/relay.test.ts`. */
export const PARCEL_MARK = "[skein parcel]";

export const SEND_FILES_TOOL = "mcp__skein__send_files";

export type ParcelSent = { name: string; dir: boolean; detail: string; secret: boolean };
export type ParcelLeft = { path: string; why: string };
export type Parcel = {
  files: string;
  size: string;
  landed: string;
  /** The wall this parcel is going to, on the wall that sent it — the pending
   *  plate's "target", before the far wall says where it landed. */
  to?: string;
  /** The wall a *person* sent this from, when it arrived on this one — read
   *  out of the manifest's own header (`parcel::manifest_signed`). It is the
   *  direction, in the words, and that is the whole point of it being here:
   *  the flyway event knows which way a parcel went, and a session read back
   *  off disk knows only the text, so without this a restored transcript drew
   *  a received parcel as *sent with it*. */
  from?: string;
  sent: ParcelSent[];
  left: ParcelLeft[];
  /** Past what the block spells out: `+ … · N more` and `- … · N more left out`. */
  sentMore: number;
  leftMore: number;
};

const SECRET_SAID = "secret-shaped, sent because it was named";

/** The message with its parcel block taken out, and the block read — or the
 *  text unchanged and `null` when nothing was sent with it. Degrades rather
 *  than refuses: a line this build cannot read is left out of the plate, never
 *  a reason to draw no plate at all. */
export function parcelOf(text: string): { body: string; parcel: Parcel | null } {
  if (!text.includes(PARCEL_MARK)) return { body: text, parcel: null };
  const lines = text.split("\n");
  /* The last block, since the one Volery appends is at the end of the body;
     a quoted one is unmarked by the sending wall (`parcel::unmark`), and this
     is the second half of that guard for a transcript from before it. */
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at === -1; i--) if (lines[i].startsWith(PARCEL_MARK)) at = i;
  if (at === -1) return { body: text, parcel: null };
  const head = lines[at].slice(PARCEL_MARK.length).trim().split(" · ");
  /* `from <wall>` sits before `in <path>` on purpose, so a reader that does
     not know the field still reads the landing path the same way — it is the
     rest of the line from `in` onward. */
  const fromAt = head.findIndex((f) => f.startsWith("from "));
  const landedAt = head.findIndex((f) => f.startsWith("in "));
  const parcel: Parcel = {
    files: head[0] ?? "",
    size: landedAt > 1 ? head[1] : "",
    landed: landedAt === -1 ? "" : head.slice(landedAt).join(" · ").slice(3),
    ...(fromAt === -1 ? {} : { from: head[fromAt]!.slice(5) }),
    sent: [],
    left: [],
    sentMore: 0,
    leftMore: 0,
  };
  let end = at + 1;
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (l.trim() === "") break;
    const fields = l.slice(2).split(" · ");
    const more = fields[0] === "…" ? Number.parseInt(fields[1] ?? "", 10) : NaN;
    if (Number.isFinite(more)) {
      if (l.startsWith("+ ")) parcel.sentMore = more;
      else if (l.startsWith("- ")) parcel.leftMore = more;
      continue;
    }
    if (l.startsWith("+ ")) {
      const rest = fields.slice(1);
      const secret = rest.includes(SECRET_SAID);
      parcel.sent.push({
        name: fields[0],
        dir: fields[0].endsWith("/"),
        detail: rest.filter((f) => f !== SECRET_SAID).join(" · "),
        secret,
      });
    } else if (l.startsWith("- ")) {
      parcel.left.push({ path: fields[0], why: fields.slice(1).join(" · ") });
    }
  }
  return { body: lines.slice(0, at).join("\n").trim(), parcel };
}
