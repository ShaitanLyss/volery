/* The cards on other walls, and this wall's cards as the others see them.
 *
 * Both halves of `shadow.ts`, with the runes and the wire attached. What a
 * digest is, why the front end makes it, why a shadow is not a card and how a
 * prompt to one is drawn are all argued there; this file is the plumbing.
 *
 * ### Publishing is folded, not polled
 *
 * The snapshot is an `$effect` over the wall's cards, and every field it reads
 * is already state or a derived over the event fold — so it re-runs when a card
 * actually changes and at no other time. The one field that changes with no
 * event behind it, how long a card has rested, is shipped as the moment it came
 * to rest rather than as a count, and `steadyDoing` drops the two countdowns
 * `doing` carries for the same reason. CLAUDE.md names three places this app
 * goes and looks; this is deliberately not a fourth.
 *
 * What is bounded is the *send*, which is the expensive half: a snapshot is
 * offered to Rust at most once a second, and only when it would draw
 * differently from the last one offered. A wall with ten working cards changes
 * many times a second and is published once.
 *
 * ### Nothing is published before the wall has loaded
 *
 * A snapshot replaces the last one wholesale and a card missing from it reads
 * as closed. `Skein.load` paints from SQLite before any card has a process, so
 * a snapshot taken in that window would flash every card not yet read as gone
 * on every other wall. `skein.loaded` gates it — a version number stops an
 * *older* snapshot from winning, not a premature one.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clock } from "./conversation.svelte";
import type { Conversation, Job, Line, PendingAsk } from "./conversation.svelte";
import { blankAnswers, composeAnswer, normalizeAsk, type AskQuestion } from "./asking";
import type { Skein } from "./skein.svelte";
import { spanOf, type Tier } from "./classify";
import { Listeners } from "./listeners";
import { hereAt, readWaiting, type Waiting } from "./waiting";
import {
  advance,
  asLines,
  askedAt,
  askHere,
  carryAnswers,
  DIGEST_V,
  digestOf,
  faceOf,
  idleOf,
  keepHost,
  placedOf,
  spotsOf,
  NO_SPOTS,
  promptRefusal,
  readSnapshot,
  readTail,
  sameCards,
  shadowKey,
  shows,
  stickShadow,
  tailOf,
  weave,
  type WireLine,
  type CardDigest,
  type DigestAsk,
  type Sent,
  type SentEvent,
  type Placed,
  type Spots,
} from "./shadow";
import type { Spot } from "./glass";
import type { Effort } from "./commands";
import { actRefusal, panelNotes, type Remote, type Said, type Verb } from "./handle";
import { usable } from "./accounts";
import { waterfall } from "./waterfall.svelte";
import { kinAcross, type Asked } from "./lineage";
import { DEFER_ANSWER, closingHere, confirmHere, noticeAnswer, noticeHere, NOTICE_AFAR_ACK, removalHere } from "./afar";
import type { Notice } from "./notice";
import { Attachments, attachedIn, turnFrom } from "./attach.svelte";
import { MANIFEST, manifestEntry, readManifest, type Carried, type FileRef, type Turn } from "./attach";

const SECTIONS_KEY = "skein.sections.v1";
function loadSections(): Placed {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    return raw ? placedOf(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** How many times a question's design or files are asked for before the
 *  sentence saying why they could not be is left standing. */
const LOOK_TRIES = 3;

/** The least time between two snapshots offered to the link. */
const PUBLISH_EVERY_MS = 1_000;

/** How many taken prompt ids to remember. The link refuses anything older than
 *  the fleet's TTL, so only the last few minutes' worth can ever repeat. */
const TAKEN_KEPT = 500;

/** One other wall's last word about its cards. */
type Wall = {
  /** The owning wall's clock when it made the snapshot. */
  at: number | null;
  /** This wall's estimate of the same moment: arrival less the link's age. */
  madeAt: number;
  cards: CardDigest[];
  /** The accounts it can put a card on, by label (`Snapshot.accounts`). */
  accounts: string[];
};

/** What became of a gesture asked of another wall (`Elsewhere.act`). */
export type ActOutcome = { outcome: "taken" | "refused"; why?: string; text?: string };

/** What the link says about a wall's roster entry. Only `quietMs` is read here;
 *  the rest is carried for the panel. */
export type RosterRow = {
  host: string;
  /** The row is this wall's own. */
  me?: boolean;
  quietMs: number;
  standing?: string;
  reason?: string;
  /** Its territories by name, and whether it answers only in the older
   *  language — what the card menu reads to offer a move there. */
  territories?: string[];
  older?: boolean;
  /** The verbs a person here may ask of its cards (`flyway/act.rs`), as
   *  `handle.ts::Remote.acts` reads them. Absent from an older build. */
  acts?: string[];
  /** It takes a close from a person here (`close_by_person`). */
  closes?: boolean;
  /** It takes a person's prompt with pictures in it (`fleet::CAN_PICTURES`).
   *  Absent from an older build, which is a no. */
  pictures?: boolean;
  /** It announced `files`: it pulls a prompt's files from the wall that sent
   *  them (`attachments::CAN_FILES`). */
  files?: boolean;
  /** It opens an empty card a person here asks for (`flyway/opening.rs`) —
   *  what a section's menu reads to offer one. Absent from an older build. */
  opens?: boolean;
};

/** How a card asked for from a section ended: its id on that wall, or why not. */
export type OpenedThere = { card: string } | { why: string };

/** A card on another wall, drawn on this one.
 *
 *  It wears the fields `Card.svelte` reads, so the wall draws it with the same
 *  face a card has — and it has none of the methods anything that acts on a
 *  card needs, so it cannot be handed to one. That is the point of it being a
 *  class of its own rather than a `Conversation` with a flag: see the head of
 *  `shadow.ts`. */
export class Shadow {
  /** Unique on this wall — the host and the card's own id — and what the
   *  focus, the layout and the keyboard address it by. */
  readonly id: string;
  readonly host: string;
  /** The card's id on the wall that owns it: what a prompt is addressed to. */
  readonly card: string;

  digest = $state.raw<CardDigest>(null as unknown as CardDigest);
  /** What has been said to it from here, oldest first. Not persisted, like a
   *  `!` line: nothing about it is in any session file, and a prompt is only
   *  worth tracking while somebody is waiting on it. */
  sent = $state<Sent[]>([]);
  /** The questions it is parked on, as sheets this wall's ask panel can fill
   *  in. Kept as the same objects across snapshots, keyed on the ask, so what
   *  has been answered of a sheet survives the next snapshot arriving — the
   *  local panel keeps `answers` on the ask for the same reason. */
  sheets = $state<PendingAsk[]>([]);
  /** Questions answered from here whose answer has not been refused. Hidden
   *  from the panel while the answer is on its way: drawn as still waiting, a
   *  question you have just answered would invite a second answer. */
  answering = $state<string[]>([]);
  /** A close asked of its wall from here. `asked` until the wall answers, then
   *  `taken` — the wall is closing it — or `refused` with the reason. There is
   *  no *done*: the card leaves when its wall's next snapshot no longer carries
   *  it, and nothing here removes it sooner. Asking again replaces it. */
  closing = $state<{ state: "asked" | "taken" | "refused"; why?: string } | null>(null);
  /** A gesture asked of its wall from here (`Elsewhere.act`): `asked` until the
   *  one exchange it is comes back, then `taken` or `refused` with the reason.
   *  Beside `closing` rather than replacing it, since a close is answered on
   *  the prompt wire and this is not. One at a time; asking again replaces it.
   *  What a setting did is drawn by the wall's next snapshot, not here. */
  acting = $state<{ verb: Verb; state: "asked" | "taken" | "refused"; why?: string } | null>(null);

  #walls: Elsewhere;

  constructor(walls: Elsewhere, host: string, d: CardDigest) {
    this.#walls = walls;
    this.host = host;
    this.card = d.id;
    this.id = shadowKey(host, d.id);
    this.digest = d;
  }

  /** How long since this card's wall was last heard, on the wall's one tick. */
  quietMs = $derived(this.#quiet());
  #quiet(): number {
    const heard = this.#walls.heardAt[this.host];
    return heard === undefined ? Infinity : Math.max(0, clock.t - heard);
  }

  #idle = $derived.by(() => {
    const w = this.#walls.walls[this.host];
    return w ? idleOf(this.digest, w.at, w.madeAt, clock.t) : 0;
  });

  /** The questions this wall may answer now. **None while its wall is
   *  unheard**: the question may have been answered there, or its time run out,
   *  and a question that has not been confirmed as still waiting must not look
   *  like one waiting for an answer — the same honesty the face keeps. */
  open = $derived(this.#open());
  #open(): PendingAsk[] {
    return this.face.unheard ? [] : this.sheets.filter((a) => !this.answering.includes(a.askId));
  }

  /** Notices taken down from here whose answer has not been refused — hidden
   *  meanwhile, as an answered question is. By the digest's own notice id. */
  acking = $state<string[]>([]);

  /** The notices standing in its wall's queue that this wall may take down,
   *  drawn as this wall's own (`afar.ts::noticeHere`), raised-at put on this
   *  wall's clock by `askedAt`'s arithmetic. **None while its wall is
   *  unheard**, `open`'s honesty: the notice may have been acknowledged
   *  there, and one not confirmed as still standing must not look like one
   *  waiting on you. */
  notices = $derived.by((): Notice[] => {
    if (this.face.unheard) return [];
    const w = this.#walls.walls[this.host];
    return this.digest.notices
      .filter((n) => !this.acking.includes(n.id))
      .map((n) => noticeHere(n, this.id, w ? askedAt({ since: n.raisedAt }, w.at, w.madeAt) : Date.now()));
  });

  /** Where it is stuck to the glass in the room in front of you, or null for
   *  one standing in its wall's section. Read off the walls' memory rather than
   *  held here, because that memory is per room and outlives this object — see
   *  `ShadowGlass`. */
  get glass(): Spot | null {
    return this.#walls.glass[this.id] ?? null;
  }

  /** Stick it to the glass, move it there, or take it off with `null`. */
  stick(at: Spot | null) {
    this.#walls.stick(this.id, at);
  }

  face = $derived(this.#face());
  #face() {
    return faceOf(this.digest, this.host, this.quietMs, this.#idle);
  }

  /* ── what `Card.svelte` reads ─────────────────────────────────────── */

  get title() {
    return this.digest.title;
  }
  get project() {
    return this.digest.project;
  }
  get tier(): Tier {
    return this.face.tier;
  }
  get working() {
    return this.face.working;
  }
  get dormant() {
    return this.face.dormant;
  }
  get doing() {
    return this.face.doing;
  }
  get idleSeconds() {
    return this.face.idleSeconds;
  }
  /** What it is waiting on, its moments moved onto this wall's clock. **Nothing
   *  while its wall is unheard or it is working**: a wake that may have fired
   *  over there cannot be claimed as pending here, `open`'s honesty again. The
   *  colour is never decided here — late or not, the tier is the owner's. */
  get waiting(): Waiting | null {
    return this.#waiting;
  }
  #waiting = $derived.by((): Waiting | null => {
    if (this.face.unheard || this.face.working || this.busy) return null;
    const w = this.#walls.walls[this.host];
    const wakes = this.digest.wakes.map((x, i) => ({
      id: String(i),
      at: x.at === null ? null : w ? hereAt(x.at, w.at, w.madeAt) : x.at,
      note: x.note,
      from: x.from,
    }));
    return readWaiting(wakes, clock.t);
  });
  get ctx() {
    return this.digest.ctx;
  }
  /** Off while the wall is unheard: the card face says `set aside` ahead of
   *  everything else, and that would hide the one line that matters then. */
  get aside() {
    return this.digest.aside && !this.face.unheard;
  }
  get gear() {
    return this.digest.planning ? "planning" : "making";
  }
  get busy() {
    return this.digest.jobs > 0 && !this.face.unheard;
  }
  /** The face draws a count and a tooltip of labels; a digest carries only the
   *  count, so the labels say where the work is rather than inventing what. */
  get jobs(): Job[] {
    return Array.from({ length: this.busy ? this.digest.jobs : 0 }, (_, i) => ({
      toolId: `${this.id}:job${i}`,
      taskId: null,
      kind: "command" as const,
      label: `background work on ${this.host}`,
      /* **Null, and it has to be.** A job's output file is a path on the other
         machine, so there is nothing here to open and nothing honest to point
         the drawer at. `Jobs.svelte` draws a row with no log rather than a log
         that is not there, which is the right half of the two to keep: that
         work is running over there is worth knowing, and reading it is the
         owning wall's to offer. */
      outputPath: null,
      journalDir: null,
      state: "running" as const,
      since: this.digest.restingSince ?? 0,
    }));
  }
  /** The far wall's own conversation, once somebody has opened the panel and
   *  asked for it. Null until then, and that is the *reading* as well as the
   *  state: a tail nobody has fetched is not an empty conversation, so `lines`
   *  falls back to the one line a digest carries rather than drawing a card
   *  that has never said anything. */
  tail = $state.raw<WireLine[] | null>(null);
  /** Where the fetch has got to, so the panel can say "reading…" rather than
   *  showing a conversation with a hole in it. `none` is the far wall having
   *  answered that it has nothing — a cleared card, or one that never spoke. */
  tailState = $state<"unread" | "loading" | "ready" | "none" | "error">("unread");
  /** Why the last read came to nothing, in the far wall's or the link's own
   *  words — a quiet wall, an older one, a card closed since it was drawn. */
  tailWhy = $state<string | null>(null);
  #reading = false;
  #again = false;

  /** Read the conversation off the wall it runs on (`flyway_tail`). Pulled
   *  when a panel is open on it and never gossiped: a transcript is large and
   *  wanted one card at a time (`flyway/tail.rs`).
   *
   *  One read in flight; asked again meanwhile, it reads once more after,
   *  since the second ask means the card has moved on since the first. Only a
   *  first read says `loading` — a refresh keeps what is drawn, and a refresh
   *  that fails keeps it too, because what was read is still what was said. */
  async readTail(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = true;
    try {
      do {
        this.#again = false;
        if (this.tail === null) this.tailState = "loading";
        try {
          const raw = await invoke<unknown>("flyway_tail", { host: this.host, card: this.card });
          const t = raw == null ? [] : readTail(raw);
          if (!t) throw new Error(`${this.host} sent something that is not a conversation`);
          this.tail = t;
          this.tailState = t.length ? "ready" : "none";
          this.tailWhy = null;
        } catch (e) {
          this.tailWhy = String((e as Error)?.message ?? e);
          if (this.tail === null) this.tailState = "error";
        }
      } while (this.#again);
    } finally {
      this.#reading = false;
    }
  }

  /** The column, as the transcript draws it.
   *
   *  Their conversation and our sends, woven (`shadow.ts::weave`) so a prompt
   *  that has arrived appears once — in their copy, wearing this wall's receipt
   *  — and one still travelling appears below it. The fallback is the digest's
   *  single line, which is what this used to be in its entirety and is still
   *  the honest answer before anybody has asked for more. */
  lines = $derived.by((): Line[] => {
    const t = this.tail;
    if (t) return asLines(weave(t, this.sent, clock.t), this.host, clock.t);
    return this.digest.said ? [{ kind: "text", text: this.digest.said }] : [];
  });

  /* The rest of what `Transcript.svelte` reads. A shadow answers each with the
     empty value rather than a plausible one, which is the bargain `Readable`
     names: the compiler asks the question, and where there is no honest answer
     the panel is told nothing rather than told something made up. Occupancy is
     the exception — `ctx` is a real reading the digest carries, and the token
     count behind it is not, so the ring is right and the number beside it is
     absent rather than invented. */
  readonly cwd = "";
  readonly kind = "project" as const;
  readonly history: Line[] = [];
  get historyState() {
    return this.tailState;
  }
  readonly historyPartial = false;
  get everSpoke() {
    return this.lines.length > 0;
  }
  get activity() {
    return this.digest.doing;
  }
  readonly turns = 0;
  readonly dropped = 0;
  readonly costUsd = 0;
  readonly ctxTokens = 0;
  get model() {
    return this.digest.model ?? undefined;
  }
  get effort() {
    return (this.digest.effort ?? undefined) as Effort | undefined;
  }
  readonly streaming = "";
  get accountLabel() {
    return this.digest.account;
  }
  get bypassCaps() {
    return this.digest.bypassCaps;
  }
  readonly compactFrac = null;
  readonly holding = null;
  readonly planDoc = null;
  get elsewhere() {
    return { host: this.host, unheard: this.face.unheard };
  }
  /** What the panel keys its read of the conversation on: it reads when it
   *  opens and again whenever this changes. The card's own wall saying it has
   *  moved on — a new settled line, a new activity (which is what a run of tool
   *  calls with nothing said between them changes), a turn opening or closing —
   *  and its wall being heard again, so a read refused while it was quiet is
   *  not the last word. Folded off the snapshot and the roster that already
   *  arrive, never a timer.
   *
   *  A `$derived` and not a getter, and that is the whole of it: a reader of a
   *  derived is woken only when its *value* changes, where a getter hands the
   *  reader every signal under it — `digest` is replaced on every snapshot, so
   *  a getter would have the panel pull the conversation over the link again
   *  each time its wall said anything about any card. */
  historyMark = $derived(this.#historyMark());
  #historyMark(): string {
    const d = this.digest;
    return [this.id, d.said, d.doing, d.restingSince, this.working, this.face.unheard].join("\u0000");
  }
  /** `historyMark` without the activity: what a pin of this card's last
   *  message re-reads its conversation on (`Saying.svelte`). A derived for
   *  `historyMark`'s reason — a reader wakes when the value changes, not when
   *  the snapshot under it is replaced. */
  saidMark = $derived(this.#saidMark());
  #saidMark(): string {
    return [this.id, this.digest.said, this.working, this.face.unheard].join("\u0000");
  }
  /** What its panel says above the conversation — what this wall knows that
   *  the conversation cannot say for itself (`handle.ts::panelNotes`). */
  get notes(): Said[] {
    return panelNotes({
      host: this.host,
      unheard: this.face.unheard,
      tailState: this.tailState,
      tailWhy: this.tailWhy,
      closing: this.closing,
      acting: this.acting,
      open: this.open.length,
      sheets: this.sheets.length,
    });
  }
  /** What `handle.ts` needs to say which verbs this card can be asked: the
   *  `act:<verb>` words its wall's roster row carries, and whether it takes a
   *  person's close. A wall with no row yet, or an older one, offers no verbs
   *  — the glass and, while heard, the close, which the link refuses itself
   *  and says why. Read when a menu opens, never per frame. */
  get remote(): Remote {
    const row = this.#walls.roster.find((r) => r.host === this.host && !r.me);
    return {
      host: this.host,
      unheard: this.face.unheard,
      acts: new Set(row && !row.older ? (row.acts ?? []) : []),
      /* No row yet — a stored snapshot drawn at launch — keeps the close, for
         `verbsFor`'s reason: the link refuses one it cannot carry, in words. */
      closes: row ? row.closes === true : true,
      /* No row, or an older one, is no: a picture sent there would arrive as
         the sentence without it. The link refuses one too. */
      pictures: !!row && !row.older && row.pictures === true,
      /* The same for files, which the owning wall pulls from this one
         (`flyway_fetch`). */
      files: !!row && !row.older && row.files === true,
    };
  }
  /** The accounts its wall can put it on, by label — what `put it on…`
   *  offers. Empty from a wall that sent none. */
  get accounts(): string[] {
    return this.#walls.walls[this.host]?.accounts ?? [];
  }
}

/* In `shadow.ts` now, beside the digest, so `lineage.ts` can address a root to
   a shadow without importing runes. Re-exported for everything that already
   reached for it here. */
export { shadowKey };

/** Every other wall's cards, and this wall's offered to them. */
export class Elsewhere {
  /** Each wall's last snapshot, by host. */
  walls = $state<Record<string, Wall>>({});
  /** When each wall was last heard from, on this wall's clock — the roster's
   *  word, or a snapshot arriving, whichever is later. */
  heardAt = $state<Record<string, number>>({});
  /** The link's roster, for the panel. */
  roster = $state<RosterRow[]>([]);
  /** Every shadow on the wall, in host order and then the owner's order. */
  shadows = $state<Shadow[]>([]);
  /** This wall's own name on the flyway, or "" until asked. */
  me = $state("");
  /** Cards on *this* wall that another wall asked for, by card id → the asking
   *  host. Kept apart from the cards themselves because the link may say so
   *  before the card is on the wall, and stamped onto each as it arrives. */
  births = $state<Record<string, string>>({});
  /** The same births with the asking *card* beside the host — what a root to
   *  the card that asked is drawn from. Its own map rather than a widening of
   *  `births`, which the control surface reports as it stands. `at` only on a
   *  birth heard live, so a root grows for a card opened now and a restored one
   *  is simply there, as `Skein.kin`'s are. */
  askedBy = $state<Record<string, Asked>>({});
  /** Where sections have been dragged to on the wall, by `sectionId`.
   *  `localStorage`, not SQLite, on `berth.svelte.ts`'s argument: where this
   *  window stands its furniture is per-machine and disposable, and a section
   *  has no row to be a column of. */
  sections = $state.raw<Placed>(loadSections());
  /** Put a section somewhere, or back in line with `null`. Held in memory on
   *  every move of a drag and written by `saveSections` when the gesture ends,
   *  not sixty times a second. */
  moveSection(id: string, at: { x: number; y: number } | null) {
    const next = { ...this.sections };
    if (at) next[id] = { x: at.x, y: at.y };
    else delete next[id];
    this.sections = next;
  }
  saveSections() {
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(this.sections));
    } catch {
      /* The section is already where it was put; only the memory is lost. */
    }
  }

  /** Which shadows are stuck to the glass in the room in front of you. The
   *  store holds every room's (`arrange.rs`, kind `shadow`); this is the one
   *  `adopt_arrangement` last answered, written through on every change. */
  glass = $state.raw<Spots>(NO_SPOTS);

  /** One wall has just been heard, and these are the cards it still holds — for
   *  whatever on this wall is a view of a card over there and has to come down
   *  when its card does (`Widgets.keepHost`). Set by the app; the same moment,
   *  and the same rule, that lets go of a closed card's glass spot. */
  onHeard: (host: string, alive: ReadonlySet<string>) => void = () => {};

  #skein: Skein;
  #byId = new Map<string, Shadow>();
  /** Where a prompt's events go: its shadow, even after the card has left the
   *  wall, so an answer arriving late lands on the object that asked. */
  #byPrompt = new Map<string, Shadow>();
  /** The same for a close, which is answered on the same event. */
  #byClose = new Map<string, Shadow>();
  /** And for a notice taken down from here: which shadow, which notice. */
  #byNotice = new Map<
    string,
    { shadow: Shadow; notice: string; resolve: (landed: boolean) => void }
  >();
  #listeners = new Listeners();
  /** Prompts from other walls this wall has taken, by id, with the answer each
   *  got — or null while it is being delivered. See `#take`. */
  #taken = new Map<string, { outcome: "taken" | "refused"; why?: string } | null>();
  /** Cards asked for from a section (`openThere`), by request id, until their
   *  wall answers — and answers that arrived before the ask had its id back,
   *  which the request's own reply can lose a race to. */
  #opening = new Map<string, (o: OpenedThere) => void>();
  #openedEarly = new Map<string, OpenedThere>();
  #stopEffects: () => void;

  #offered: { cards: CardDigest[]; accounts: string[] } | null = null;
  #pending: { cards: CardDigest[]; accounts: string[] } | null = null;
  #lastAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Every root this wall can draw, wherever each end runs — see
   *  `lineage.ts::kinAcross`. What `Canvas` hands `Lineage`, in place of
   *  `Skein.kin` alone. */
  readonly kin = $derived.by(() =>
    kinAcross({
      kin: this.#skein.kin,
      births: this.askedBy,
      shadows: this.shadows.map((s) => ({ id: s.id, host: s.host, parent: s.digest.parent ?? null })),
      me: this.me,
      heard: new Set(Object.keys(this.walls)),
    }),
  );

  constructor(skein: Skein) {
    this.#skein = skein;
    this.#stopEffects = $effect.root(() => {
      $effect(() => {
        if (!this.#skein.loaded) return;
        this.#offer(
          this.#skein.convs.map((c) => digestOf(this.#sourceOf(c))),
          usable(waterfall.list).map((a) => a.label),
        );
      });
      /* Whichever arrives second — the card or the link's word about it — is
         what stamps it, so neither order leaves a remotely born card silent. */
      $effect(() => {
        for (const c of this.#skein.convs) {
          const h = this.births[c.id];
          if (h !== undefined && c.bornFor !== h) c.bornFor = h;
        }
      });
    });
  }

  /** Start listening, and read what the link already holds. Every command here
   *  may not exist — an older build, or a wall that has never joined a flyway —
   *  and a wall with no flyway is a wall with no shadows, not a fault. */
  attach() {
    const l = this.#listeners;
    l.keep(listen<{ host: string; ageMs: number; snapshot: unknown }>("flyway:cards", (e) => this.#arrived(e.payload)));
    l.keep(listen<RosterRow[]>("flyway:roster", (e) => this.#heard(e.payload)));
    l.keep(listen<{ id: string }>("flyway:prompt-left", (e) => this.#fold(e.payload.id, { kind: "left" })));
    l.keep(
      listen<{ id: string; by: string; outcome: "taken" | "refused"; why?: string }>("flyway:prompt-answer", (e) => {
        if (this.#closed(e.payload.id, e.payload.outcome, e.payload.why)) return;
        this.#noticed(e.payload.id, e.payload.outcome, e.payload.why);
        this.#fold(e.payload.id, { kind: "answer", outcome: e.payload.outcome, why: e.payload.why });
      }),
    );
    l.keep(
      listen<{ id: string; from: { host: string; card: string | null }; card: string; text: string; notice?: string }>(
        "flyway:prompt",
        (e) => void this.#take(e.payload),
      ),
    );
    l.keep(listen<{ id: string; card: string }>("flyway:tail", (e) => void this.#lend(e.payload)));
    l.keep(
      listen<{ id: string; host: string; outcome: string; card?: string | null; why?: string | null }>(
        "flyway:opened-there",
        (e) => {
          const { id, outcome, card, why } = e.payload;
          const o: OpenedThere =
            outcome === "opened" && card ? { card } : { why: why || `${e.payload.host} did not open it` };
          const done = this.#opening.get(id);
          if (done) {
            this.#opening.delete(id);
            done(o);
          } else if (this.#openedEarly.size < 8) {
            /* Only the race it is for — an answer beating the ask's own reply
               by a moment — so it is let go of soon after. */
            this.#openedEarly.set(id, o);
            setTimeout(() => this.#openedEarly.delete(id), 10_000);
          }
        },
      ),
    );
    l.keep(
      listen<{ id: string; host: string; card: string; verb: string; args: Record<string, unknown> }>("flyway:act", (e) =>
        void this.#perform(e.payload),
      ),
    );
    l.keep(
      listen<{ card: string; host: string; askerCard?: string | null }>("flyway:born", (e) => {
        this.births[e.payload.card] = e.payload.host;
        this.askedBy[e.payload.card] = { host: e.payload.host, card: e.payload.askerCard ?? null, at: Date.now() };
      }),
    );
    void invoke<string>("flyway_host").then((h) => (this.me = h)).catch(() => {});
    void invoke<{ card: string; host: string; askerCard?: string | null }[]>("flyway_births")
      .then((all) => {
        for (const b of all) {
          this.births[b.card] = b.host;
          /* Never over a live one: the event may have landed first, and its
             `at` is what makes that root grow rather than appear. */
          this.askedBy[b.card] ??= { host: b.host, card: b.askerCard ?? null };
        }
      })
      .catch(() => {});
    void invoke<RosterRow[]>("flyway_roster").then((r) => this.#heard(r)).catch(() => {});
    void invoke<{ host: string; ageMs: number; quietMs: number; snapshot: unknown }[]>("flyway_remote_cards")
      .then((all) => {
        for (const w of all) {
          this.#arrived(w, false);
          this.#hear(w.host, w.quietMs);
        }
      })
      .catch(() => {});
  }

  detach() {
    this.#listeners.detach();
    this.#stopEffects();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Read off `shadows` rather than the map beside it, which is not state: a
   *  card closed on its own wall has to let go of the focus here the moment its
   *  snapshot drops it, and only a reactive read is told. */
  find(id: string | null): Shadow | null {
    return id === null ? null : (this.shadows.find((s) => s.id === id) ?? null);
  }

  /* ── this wall's cards, outward ───────────────────────────────────── */

  #sourceOf(c: Conversation) {
    const t = c.territoryId ? this.#skein.territories.find((t) => t.id === c.territoryId) : undefined;
    return {
      id: c.id,
      title: c.title,
      project: c.project,
      territory: t?.name ?? c.project,
      kind: c.kind,
      tier: c.tier,
      ending: c.ending,
      dormant: c.dormant,
      working: c.working,
      aside: c.aside,
      gear: c.gear,
      model: c.model,
      effort: c.effort,
      accountLabel: c.accountLabel,
      bypassCaps: c.bypassCaps,
      activity: c.activity,
      held: c.held,
      stalled: c.stalled,
      unacknowledged: c.unacknowledged,
      restingSince: c.restingSince,
      ctx: c.ctx,
      lines: c.lines,
      jobs: c.jobs,
      pendingWakes: c.pendingWakes,
      asks: c.asks,
      notices: this.#skein.notices,
      parent: this.#parentOf(c.id),
    };
  }

  /** Who opened a card here, as its digest says it: another wall's card if one
   *  asked for it, a card on this wall if one spawned it (`host: null`, which
   *  the reader takes as this wall). Read off `kinAcross`'s own inputs rather
   *  than its output, which also holds roots between two *shadows* — another
   *  wall's business to publish, not this one's. */
  #parentOf(id: string): { host: string | null; card: string } | null {
    const b = this.askedBy[id];
    if (b?.card) return { host: b.host, card: b.card };
    const k = this.#skein.kin.find((k) => k.child === id);
    return k ? { host: null, card: k.parent } : null;
  }

  /** Coalesce: the newest set wins, and it goes at most once a second. The
   *  wall's account labels ride along, so a change to them alone is a change. */
  #offer(cards: CardDigest[], accounts: string[]) {
    if (
      this.#offered &&
      sameCards(cards, this.#offered.cards) &&
      accounts.join("\n") === this.#offered.accounts.join("\n")
    ) {
      this.#pending = null;
      return;
    }
    this.#pending = { cards, accounts };
    if (this.#timer) return;
    const wait = Math.max(0, this.#lastAt + PUBLISH_EVERY_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#pending;
      this.#pending = null;
      if (!next) return;
      this.#offered = next;
      this.#lastAt = Date.now();
      void invoke("flyway_publish_cards", {
        snapshot: { v: DIGEST_V, at: Date.now(), cards: next.cards, accounts: next.accounts },
      }).catch(() => {
        /* No flyway, or a build without the command: the snapshot has nowhere
           to go and nothing here is owed a reading of why. Forgetting what was
           offered means the next change offers the whole set again, which is
           what a link coming up later wants. */
        this.#offered = null;
      });
    }, wait);
  }

  /* ── other walls' cards, inward ───────────────────────────────────── */

  #hear(host: string, quietMs: number) {
    /* A missing figure is no news, not news of "just now" — and NaN here would
       have compared false against every bound and read as heard for ever. */
    if (!host || host === this.me || !Number.isFinite(quietMs)) return;
    const at = Date.now() - Math.max(0, quietMs);
    const was = this.heardAt[host];
    if (was === undefined || at > was) this.heardAt[host] = at;
  }

  #heard(rows: RosterRow[]) {
    if (!Array.isArray(rows)) return;
    this.roster = rows;
    for (const r of rows) {
      if (r.me) {
        /* The link knows this wall's name before `flyway_host` has answered
           here; taking it from the roster too means a wall can never draw its
           own cards as somebody else's. */
        if (!this.me) this.me = r.host;
        continue;
      }
      this.#hear(r.host, r.quietMs);
    }
  }

  #arrived(p: { host: string; ageMs: number; snapshot: unknown }, live = true) {
    const snap = readSnapshot(p.snapshot);
    if (!snap || !p.host || p.host === this.me) return;
    const now = Date.now();
    /* Never let an older snapshot replace a newer one. Both `at`s are the same
       wall's clock, so comparing them is fair — and the case is real at launch,
       when the link's stored copy can answer after a live one has arrived. */
    const held = this.walls[p.host];
    if (held && held.at !== null && snap.at !== null && snap.at < held.at) return;
    this.walls[p.host] = {
      at: snap.at,
      madeAt: now - Math.max(0, p.ageMs || 0),
      cards: snap.cards,
      accounts: snap.accounts,
    };
    /* A snapshot is sent only by the wall it describes — the link does not
       relay them — so one arriving is that wall being heard. */
    if (live) this.#hear(p.host, 0);
    this.#reconcile(live ? p.host : null);
  }

  /** Keep each shadow as the same object across snapshots, so the prompts said
   *  to it and the focus on it survive the wall it is on changing. */
  #reconcile(heard: string | null = null) {
    const keep = new Set<string>();
    const next: Shadow[] = [];
    for (const host of Object.keys(this.walls).sort()) {
      for (const d of this.walls[host]!.cards) {
        const id = shadowKey(host, d.id);
        keep.add(id);
        let s = this.#byId.get(id);
        if (s) s.digest = d;
        else {
          s = new Shadow(this, host, d);
          this.#byId.set(id, s);
        }
        this.#sheets(s, this.walls[host]!, host === heard);
        next.push(s);
      }
    }
    for (const id of [...this.#byId.keys()]) {
      if (keep.has(id)) continue;
      this.#byId.delete(id);
      this.#forgetLooks(id, new Set());
    }
    this.shadows = next;
    if (heard) {
      /* Only the wall just heard, and only for its own cards: one that is
         silent says nothing about what it holds. A card it closed will not
         come back, so its spot — in every room — is let go. */
      const alive = new Set([...keep].filter((id) => id.startsWith(`elsewhere:${heard}:`)));
      const kept = keepHost(this.glass, heard, alive);
      if (kept !== this.glass) this.glass = kept;
      void invoke("keep_shadow_glass", { host: heard, alive: [...alive] }).catch(() => {});
      this.onHeard(heard, alive);
    }
  }

  /* ── the glass ─────────────────────────────────────────────────────── */

  /** Stick a shadow to the glass at a point in glass pixels, or take it off
   *  with `null`. Written through to the store for the room in front of you,
   *  as every other glass writer is (`arrange::remember`). */
  stick(id: string, at: Spot | null) {
    if (!at && !this.glass[id]) return;
    this.glass = stickShadow(this.glass, id, at);
    void invoke("stick_shadow", { id, x: at?.x ?? null, y: at?.y ?? null }).catch(() => {
      /* The spot is already where it was put, so the wall is right and only
         this room's memory of it is behind — not worth failing a drag for. */
    });
  }

  /** The screens changed: put the glass in the room now in front of you, as
   *  `adopt_arrangement` answered it. The store does the room-keeping and the
   *  shifted copy for a room never seen, so this only replaces. */
  adoptRoom(raw: unknown) {
    this.glass = spotsOf(raw);
  }

  /** Bring a shadow's sheets in line with the questions its digest carries:
   *  the same sheet for the same ask, a fresh one for a new ask, and none for
   *  an ask that has gone — answered on its own wall, or out of time. */
  #sheets(s: Shadow, w: Wall, heard = false) {
    const was = new Map(s.sheets.map((a) => [a.askId, a]));
    const now = s.digest.asks.map((a) => {
      /* Only off a snapshot that wall itself just sent: that is the wall
         talking, and the one moment a pull — or a second try at one — can go
         somewhere. Another wall's snapshot, or the stored copy read at launch,
         says nothing about this one. */
      if (heard && shows(a) && !s.face.unheard) this.#look(s, a);
      const kept = was.get(a.askId);
      if (kept) return kept;
      return {
        askId: a.askId,
        questions: askHere(a, s.host),
        answers: blankAnswers(askHere(a, s.host)),
        ours: false,
        since: askedAt(a, w.at, w.madeAt),
      };
    });
    /* A removal is drawn from its evidence alone, and only when the evidence
       names the wall it was heard from — `removalHere` refuses otherwise, and a
       removal it refuses is not drawn at all rather than drawn as a path. */
    for (const r of s.digest.removals) {
      const kept = was.get(r.askId);
      if (kept) {
        now.push(kept);
        continue;
      }
      const questions = removalHere(r.removal, s.host);
      if (!questions) continue;
      now.push({
        askId: r.askId,
        questions,
        answers: blankAnswers(questions),
        ours: true,
        since: askedAt(r, w.at, w.madeAt),
      });
    }
    /* A close is the same arrangement, for the same reason — and answers with a
       label (`close it`) that `spawn::approved` reads verbatim. */
    for (const c of s.digest.closings) {
      const kept = was.get(c.askId);
      if (kept) {
        now.push(kept);
        continue;
      }
      const questions = closingHere(c.closing, s.host);
      if (!questions) continue;
      now.push({
        askId: c.askId,
        questions,
        answers: blankAnswers(questions),
        ours: true,
        since: askedAt(c, w.at, w.madeAt),
      });
    }
    /* And every other confirmation, by the one generic block (sink `a02ecd0e`):
       composed here from its fields, named for the wall it was heard from, and
       answered with the option's own label, which the owning wall's settle reads
       verbatim. One already drawn above under the same ask is not drawn twice —
       the richer reading wins, and an owning wall of this build never sends a
       removal or a close in both fields anyway (`confirmsOf`). */
    const drawn = new Set(now.map((a) => a.askId));
    for (const c of s.digest.confirms) {
      if (drawn.has(c.askId)) continue;
      const kept = was.get(c.askId);
      if (kept) {
        now.push(kept);
        continue;
      }
      const questions = confirmHere(c.confirm, s.host, s.title);
      if (!questions) continue;
      now.push({
        askId: c.askId,
        questions,
        answers: blankAnswers(questions),
        ours: true,
        since: askedAt(c, w.at, w.madeAt),
      });
    }
    if (now.length !== s.sheets.length || now.some((a, i) => a !== s.sheets[i])) s.sheets = now;
    const live = new Set(now.map((a) => a.askId));
    this.#forgetLooks(s.id, live);
    if (s.answering.some((id) => !live.has(id))) s.answering = s.answering.filter((id) => live.has(id));
    const standing = new Set(s.digest.notices.map((n) => n.id));
    if (s.acking.some((id) => !standing.has(id))) s.acking = s.acking.filter((id) => standing.has(id));
  }

  /** Questions whose design or files have been asked for, by shadow and ask,
   *  so a snapshot arriving while one is on its way does not ask again. `busy`
   *  while a pull is out; `tries` bounds asking again after one failed. */
  #looks = new Map<string, { host: string; askId: string; shadow: string; tries: number; busy: boolean }>();

  /** Pull what a question shows from the wall it was asked on, and redraw its
   *  sheet from the call's own arguments — through `normalizeAsk`, the one
   *  reading a question asked here gets, so the dock, the gallery and the
   *  viewer draw it as they draw a local card's (`flyway/look.rs`). A pull that
   *  fails says why in the question, where the words already said something
   *  was coming — and is asked again on the next snapshot from that wall, up
   *  to `LOOK_TRIES`, since a wall that is talking again is the one moment a
   *  second try can go differently. Not on a clock: CLAUDE.md's three places
   *  that go and look are three. */
  #look(s: Shadow, a: DigestAsk) {
    const key = `${s.id}\n${a.askId}`;
    const was = this.#looks.get(key);
    /* Answered from here and on its way: nothing to draw it for, and a try
       spent now would be a try the question has not got if the answer is
       refused and the sheet comes back. */
    if (s.answering.includes(a.askId)) return;
    if (was && (was.busy || was.tries === 0)) return;
    const l = was ?? { host: s.host, askId: a.askId, shadow: s.id, tries: LOOK_TRIES, busy: false };
    l.busy = true;
    l.tries -= 1;
    this.#looks.set(key, l);
    /* Whether it was drawn: false when the sheet has gone or is being answered,
       so the pull is not counted as having landed. */
    const redraw = (questions: AskQuestion[]): boolean => {
      const sheet = s.sheets.find((x) => x.askId === a.askId);
      if (!sheet || s.answering.includes(a.askId)) return false;
      const answers = carryAnswers(sheet.questions, sheet.answers, questions);
      if (answers !== sheet.answers) sheet.answers = answers;
      sheet.questions = questions;
      return true;
    };
    invoke<{ args: unknown; whole: boolean }>("flyway_look", { host: s.host, card: s.card, ask: a.askId })
      .then(({ args, whole }) => {
        /* The question went while its files were crossing, and `#forgetLooks`
           ran before they were written: take them away now. */
        if (this.#looks.get(key) !== l) {
          void invoke("flyway_look_forget", { host: l.host, ask: l.askId }).catch(() => {});
          return;
        }
        const drawn = redraw(normalizeAsk((args ?? {}) as Parameters<typeof normalizeAsk>[0]));
        /* A file that stopped arriving is drawn as a fault for now and asked
           for again on the next snapshot, while tries remain. */
        if (drawn && whole) l.tries = 0;
      })
      .catch((err) => {
        if (this.#looks.get(key) === l) redraw(askHere(a, s.host, String(err)));
      })
      .finally(() => (l.busy = false));
  }

  /** Let go of what questions that have gone brought here — answered, run out,
   *  or their card closed. `keep` is the asks still standing on `shadow`, or
   *  none for a shadow that has gone. */
  #forgetLooks(shadow: string, keep: ReadonlySet<string>) {
    for (const [key, l] of this.#looks) {
      if (l.shadow !== shadow || keep.has(l.askId)) continue;
      this.#looks.delete(key);
      void invoke("flyway_look_forget", { host: l.host, ask: l.askId }).catch(() => {});
    }
  }

  /* What the dock draws out of these is the dock's question: it reads every
     shadow's `open` and `notices` into the one queue (`queue.ts`). */

  /* ── speaking to one ──────────────────────────────────────────────── */

  /** Answer a question a card on another wall is parked on.
   *
   *  The answer is the text the dock here would have sent — `composeAnswer`,
   *  numbered list and asides included — and it rides the prompt wire with the
   *  ask's id, which the owning wall hands straight into the parked call. It is
   *  drawn among what was said to the card from here and goes through the same
   *  four readings a prompt does: a question answered into a link that is down
   *  must not look answered. */
  async answer(s: Shadow, sheet: PendingAsk, said?: string) {
    const text = said ?? composeAnswer(sheet.questions, sheet.answers);
    const id = crypto.randomUUID();
    const about = sheet.questions[0]?.header ?? "a question";
    s.sent.push({ id, text, at: Date.now(), state: "queued", askId: sheet.askId, about });
    this.#byPrompt.set(id, s);
    /* Refused on the spot, never queued for a wall that comes back: a
       confirmation landing hours later on a card running with the machine in
       its hands is the thing that must not happen. `open` already hides the
       question from an unheard wall; this is the second lock, for a click
       already on its way when the wall went quiet. */
    if (s.face.unheard) {
      this.#fold(id, { kind: "unsent", why: `${s.host} has not been heard from — nothing was sent` });
      return;
    }
    /* Words only cross in an answer, so far: refused with the reason rather
       than sent without the thing the words are about. */
    if (said === undefined && attachedIn(`ask:${sheet.askId}`).length) {
      this.#fold(id, { kind: "unsent", why: `only words go in an answer to a card on ${s.host} — take the attachment out, or send it as a message` });
      return;
    }
    s.answering = [...s.answering, sheet.askId];
    try {
      await invoke("flyway_prompt", { id, to: s.host, card: s.card, text, askId: sheet.askId });
    } catch (e) {
      this.#fold(id, { kind: "unsent", why: String(e) || "the link would not take it" });
    }
  }

  /** Put a question parked on another wall off until later: the owning wall
   *  files it in its own pile as a defer pressed there would (`DEFER_ANSWER`,
   *  recognised in `ask::answer_from_afar`). It rides the same four readings an
   *  answer does, and the question comes down when that wall's digest stops
   *  carrying it. */
  async defer(s: Shadow, sheet: PendingAsk) {
    await this.answer(s, sheet, DEFER_ANSWER);
  }

  /** Take down a notice standing in another wall's queue — acknowledged with
   *  an empty reply, followed up otherwise — over the prompt wire, naming the
   *  notice (`afar.ts::noticeAnswer`). Hidden while the answer travels and
   *  given back if it is refused. A follow-up is drawn among what was said to
   *  the card, as a prompt is; an acknowledgement says nothing to the card and
   *  is not. */
  /** Take a notice on another wall down, with or without a follow-up.
   *
   *  Answers whether it landed — once the other wall says, since a link that
   *  took the prompt is not a wall that took the notice down. The dock keeps a
   *  follow-up typed into it until this says yes, so a refusal hands the words
   *  back rather than giving the notice back with its field empty
   *  (`replies.svelte.ts`). A wall that never says is the dock's to time out. */
  async answerNotice(s: Shadow, n: Notice, reply = ""): Promise<boolean> {
    const d = s.digest.notices.find((x) => `${s.id}:${x.id}` === n.id);
    if (!d) return false;
    const { answers, text } = noticeAnswer(d, reply);
    /* Words only cross in a reply, so far — refused with the reply kept. */
    if (reply.trim() && attachedIn(`notice:${n.id}`).length) {
      this.#skein.fault = `only words go in a reply to a notice on ${s.host} — take the attachment out, or send it as a message`;
      return false;
    }
    const id = crypto.randomUUID();
    const said = reply.trim();
    if (said) {
      s.sent.push({ id, text: said, at: Date.now(), state: "queued" });
      this.#byPrompt.set(id, s);
    }
    if (s.face.unheard) {
      const why = `${s.host} has not been heard from — nothing was sent`;
      this.#fold(id, { kind: "unsent", why });
      this.#skein.fault = `that notice is on ${s.host}: ${why}`;
      return false;
    }
    const outcome = new Promise<boolean>((resolve) => {
      this.#byNotice.set(id, { shadow: s, notice: d.id, resolve });
    });
    s.acking = [...s.acking, d.id];
    try {
      await invoke("flyway_prompt", { id, to: s.host, card: s.card, text, askId: answers });
    } catch (e) {
      const why = String(e) || "the link would not take it";
      this.#noticed(id, "refused", why);
      this.#fold(id, { kind: "unsent", why });
    }
    return outcome;
  }

  /** A notice's answer settled. Refused gives the notice back and says why:
   *  an acknowledgement that silently did nothing leaves a notice you believe
   *  gone standing on a wall you are not looking at. */
  #noticed(id: string, outcome: "taken" | "refused", why?: string) {
    const r = this.#byNotice.get(id);
    if (!r) return;
    this.#byNotice.delete(id);
    r.resolve(outcome === "taken");
    if (outcome === "taken") return;
    r.shadow.acking = r.shadow.acking.filter((x) => x !== r.notice);
    this.#skein.fault = `${r.shadow.host} did not take that notice down: ${why || "refused"}`;
  }

  /** Send a prompt to a card on another wall. Drawn at once, as a local send
   *  is, and marked for what it is until the other wall answers.
   *
   *  Its pictures go with it (`turn.carried`) and are drawn under the line
   *  here as a local prompt's are — the thumbnails, never the bytes, which
   *  leave with the send and are not kept (`attach.md`). */
  async send(s: Shadow, text: string, turn?: Turn) {
    const id = crypto.randomUUID();
    const shots = turn?.shots.length ? turn.shots : undefined;
    s.sent.push({ id, text, at: Date.now(), state: "queued", ...(shots ? { shots } : {}) });
    this.#byPrompt.set(id, s);
    /* Refused here when the card is drawn as unheard, in the words the card is
       already wearing — the link would refuse it too, but a wall that says one
       thing on the card and another under the prompt is arguing with itself. */
    if (s.face.unheard) {
      const span = Number.isFinite(s.quietMs) ? ` for ${spanOf(s.quietMs / 1000)}` : "";
      this.#fold(id, { kind: "unsent", why: `${s.host} has not been heard from${span} — nothing was sent` });
      return;
    }
    try {
      let pictures: { name: string; mediaType: string; data: string }[] | undefined = turn?.carried.length
        ? [...turn.carried]
        : undefined;
      /* Files are held here for the owning wall to pull (`stage_outbound`),
         and the prompt carries only where they are — see `attach.ts`,
         *files to a card on another wall*. */
      if (turn?.files.length) {
        const stage = await invoke<string>("stage_outbound", {
          card: s.card,
          files: turn.files.map((f) =>
            f.kind === "file" ? { name: f.name, path: f.path } : { name: f.name, data: f.data },
          ),
        });
        pictures = [...(pictures ?? []), manifestEntry({ stage, names: turn.files.map((f) => f.name) })];
      }
      await invoke("flyway_prompt", { id, to: s.host, card: s.card, text, pictures });
    } catch (e) {
      this.#fold(id, { kind: "unsent", why: String(e) || "the link would not take it" });
    }
  }

  /** Ask the card's own wall to close it, as a person — which that wall
   *  allows whatever its switch says (`fleet::may_reach`). The card stays drawn
   *  until the wall's next snapshot drops it; a refusal or a link that would not
   *  take it lands on `closing`, on the shadow. */
  async close(s: Shadow) {
    if (s.closing?.state === "asked") return;
    const id = crypto.randomUUID();
    this.#byClose.set(id, s);
    s.closing = { state: "asked" };
    try {
      await invoke("flyway_close", { id, to: s.host, card: s.card });
    } catch (e) {
      this.#closed(id, "refused", String(e) || "the link would not take it");
    }
  }

  /** Open a card in `project` on `host`, as a person here — a section's
   *  menu (`flyway/opening.rs`). Set up as `preset` says, in `spawn`'s
   *  vocabulary (`spawnPairOf`); empty, so it waits for its first message as
   *  a card opened by that wall's own `+` does. Resolves when that wall has
   *  answered: the card's id there, or the reason — refused up front (unknown,
   *  quiet, older, not taking work, no such project), refused by that wall when
   *  it decided (its switch, its bounds), or not answered in time. Nothing is
   *  queued for a wall that is away. */
  async openThere(host: string, project: string, pair: { model: string | null; effort: string | null }): Promise<OpenedThere> {
    let id: string;
    try {
      id = await invoke<string>("flyway_open", { host, project, model: pair.model, effort: pair.effort });
    } catch (e) {
      return { why: String((e as Error)?.message ?? e) || "the link would not take it" };
    }
    const early = this.#openedEarly.get(id);
    if (early) {
      this.#openedEarly.delete(id);
      return early;
    }
    /* Rust says "did not answer" by `GIVE_UP_MS`; this is the bound for a
       link restarted in between, which would take the waiter with it. */
    return new Promise<OpenedThere>((resolve) => {
      const timer = setTimeout(() => {
        this.#opening.delete(id);
        resolve({ why: `${host} did not answer — if it opens the card after all, it will appear in its section` });
      }, 7 * 60_000);
      this.#opening.set(id, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
    });
  }

  /** Ask the card's own wall to do `verb` to it, as a person here — one of
   *  the verbs its wall announced (`handle.ts::verbsFor`), with the arguments
   *  `actFor` made from the row. One exchange (`flyway_act`), so of a prompt's
   *  four readings this needs two and the moment between: `asked`, then
   *  `taken` or `refused`. A wall drawn as unheard is refused here at once and
   *  never queued — the link refuses it too, and so does the owner for a verb
   *  that starts work while it takes none. What a setting did arrives with the
   *  wall's next snapshot; a reading verb comes back as `text`. */
  async act(s: Shadow, verb: Verb, args: Record<string, unknown> = {}): Promise<ActOutcome> {
    const refuse = (why: string): ActOutcome => {
      s.acting = { verb, state: "refused", why };
      this.#skein.fault = `${s.host} did not ${verb} ${s.title || "that card"}: ${why}`;
      return { outcome: "refused", why };
    };
    /* Not through `refuse`: writing `acting` here would clear the very mark
       that makes a third click wait too. */
    if (s.acting?.state === "asked") {
      const why = `still waiting on ${s.host} for the last thing asked`;
      this.#skein.fault = why;
      return { outcome: "refused", why };
    }
    if (s.face.unheard) return refuse(`${s.host} has not been heard from — nothing was sent`);
    s.acting = { verb, state: "asked" };
    try {
      const text = await invoke<string | null>("flyway_act", { host: s.host, card: s.card, verb, args });
      s.acting = { verb, state: "taken" };
      return { outcome: "taken", text: text ?? undefined };
    } catch (e) {
      return refuse(String((e as Error)?.message ?? e) || "the link would not take it");
    }
  }

  #closed(id: string, outcome: "taken" | "refused", why?: string) {
    const s = this.#byClose.get(id);
    if (!s) return false;
    this.#byClose.delete(id);
    s.closing = outcome === "taken" ? { state: "taken" } : { state: "refused", why: why || "refused" };
    if (outcome === "refused") this.#skein.fault = `${s.host} did not close ${s.title || "that card"}: ${s.closing.why}`;
    return true;
  }

  #fold(id: string, ev: SentEvent) {
    const s = this.#byPrompt.get(id);
    if (!s) return;
    const i = s.sent.findIndex((p) => p.id === id);
    if (i < 0) return;
    const next = advance(s.sent[i]!, ev);
    s.sent[i] = next;
    /* A refused answer gives its question back, with the sheet still filled
       in: refused because the link was down, it can be sent again; refused
       because the question is gone, the next snapshot takes it away. */
    if (next.state === "refused" && next.askId) {
      const ask = next.askId;
      s.answering = s.answering.filter((a) => a !== ask);
    }
    /* An answer is final (`advance`), so nothing further can be owed to it and
       the route can go — which is what keeps this map from growing for the life
       of the window. */
    if (next.state === "taken" || next.state === "refused") this.#byPrompt.delete(id);
  }

  /* ── a prompt arriving for one of this wall's cards ───────────────── */

  /** Hand a prompt from another wall to the card it is for, through the same
   *  send path a prompt typed here takes — waking a dormant card, the echo and
   *  its marks, all of it — and say what became of it.
   *
   *  It arrives *introduced*: a `you` line nobody at this keyboard typed is the
   *  transcript putting words in somebody's mouth unless it says where they came
   *  from (`Conversation.note`). `taken` means this wall has it and the card's
   *  own transcript is now the honest account — including a send that fails
   *  there, which this wall's panel draws as it would any failed send. */
  async #take(p: {
    id: string;
    from: { host: string; card: string | null };
    card: string;
    text: string;
    /** Set when this takes down one of the card's notices rather than being a
     *  prompt — see `afar.ts`. */
    notice?: string;
    /** What it carries besides its words, already checked by Rust
     *  (`attach::carried_fit`). */
    pictures?: (Carried | { name: string; mediaType: string; data: string })[];
  }) {
    /* A redelivered frame gets the answer the first one got, and never a
       second send. The link already drops repeats; this is the second lock on
       the same door, because a prompt taken twice is two turns on a card
       running with the machine in its hands. Re-answering is the useful half: a
       repeat usually means the first answer was lost on the way back. */
    /* Keyed on the asking wall *and* the id, the fleet's lesson: the id alone
       was its first cut, and two walls minting the same one swallowed each
       other's asks. A uuid makes that unlikely here; the key makes it moot. */
    const key = `${p.from.host}\u0000${p.id}`;
    const known = this.#taken.get(key);
    if (known !== undefined) {
      if (known) this.#answer(p, known.outcome, known.why);
      return;
    }
    this.#taken.set(key, null);
    if (this.#taken.size > TAKEN_KEPT) this.#taken.delete(this.#taken.keys().next().value!);

    /* Before the wall has read its cards every card looks absent, and "it may
       have been closed" would be a false thing to tell the asker. */
    if (!this.#skein.loaded) {
      return this.#settle(p, "refused", `${this.me || "that wall"} is still starting — send it again in a moment`);
    }
    const conv = this.#skein.convs.find((c) => c.id === p.card);
    const refusal = promptRefusal(!!conv, this.me);
    if (!conv || refusal) return this.#settle(p, "refused", refusal ?? undefined);

    /* A notice taken down from another wall: the same two gestures the dock
       here makes, on the row this wall holds — so the queue, the card and the
       register cannot tell a click there from one here. */
    if (p.notice) {
      const n = this.#skein.notices.find((x) => x.id === p.notice && x.conversationId === conv.id && !x.askId);
      if (!n) {
        return this.#settle(
          p,
          "refused",
          `that notice is no longer standing on ${this.me || "that wall"} — acknowledged there, or the card has moved on`,
        );
      }
      if (p.text.trim() === NOTICE_AFAR_ACK) {
        await this.#skein.acknowledgeNotice(n);
        return this.#settle(p, "taken");
      }
      conv.note(`sent from ${p.from.host}`);
      const went = await this.#skein.followUpNotice(n, p.text).catch(() => false);
      return this.#settle(
        p,
        went ? "taken" : "refused",
        went ? undefined : `${this.me || "that wall"} could not deliver it — ${conv.activity}`,
      );
    }

    /* Its pictures are attached here the way a paste in this wall's own dock
       is — decoded, held to the same limits, given a thumbnail — and then the
       sentence is cut with them by the same `turnOf` the dock uses, so the far
       card gets the turn a person at this keyboard would have sent. All or
       nothing: the sentence without one of its pictures is refused, never
       sent. Nothing is written to disk; the bytes leave with the send. */
    let turn: Turn | undefined;
    if (p.pictures?.length) {
      const shots = new Attachments();
      /* Files are not in the list: a manifest says where they are, and they
         are pulled from the wall that sent them and written into this card's
         own folder, so the agent here is handed paths on this machine. All or
         nothing, as the pictures are. */
      const manifest = p.pictures.map((e) => readManifest(e)).find((m) => m !== null) ?? null;
      const pictures = p.pictures.filter((e): e is Carried => e.mediaType !== MANIFEST);
      /* A decode that throws is answered too — an asker that never hears back
         can only say it does not know, and the key above would swallow its
         retry. */
      const why = pictures.length
        ? await shots.fromCarried(pictures).catch((e) => String((e as Error)?.message ?? e) || "could not be read")
        : null;
      if (why) return this.#settle(p, "refused", `${this.me || "that wall"} would not take its pictures: ${why}`);
      let files: FileRef[] = [];
      if (manifest) {
        let got: { n: number; path: string | null; fault: string | null }[];
        try {
          got = await invoke("flyway_fetch", { host: p.from.host, card: conv.id, stage: manifest.stage });
        } catch (e) {
          return this.#settle(p, "refused", `${this.me || "that wall"} could not fetch its files: ${String(e)}`);
        }
        const fault = got.find((g) => g.fault || !g.path);
        if (fault || got.length !== manifest.names.length) {
          return this.#settle(p, "refused", `${this.me || "that wall"} could not fetch its files: ${fault?.fault ?? "some did not arrive"}`);
        }
        files = got.map((g, i) => ({ kind: "file", id: `f${i}`, name: manifest.names[i]!, path: g.path!, dir: false, size: null }));
      }
      const made = await turnFrom(p.text, [...shots.list, ...files], { chat: conv.kind === "chat", afar: false }, conv.id);
      shots.clear();
      if ("refused" in made) return this.#settle(p, "refused", `${this.me || "that wall"} could not give it to the card: ${made.refused}`);
      turn = made;
    }

    conv.note(`sent from ${p.from.host}`);
    let sent = false;
    try {
      sent = await this.#skein.send(conv, turn?.text ?? p.text, turn);
    } catch {
      sent = false;
    }
    this.#settle(
      p,
      sent ? "taken" : "refused",
      sent ? undefined : `${this.me || "that wall"} could not deliver it — ${conv.activity}`,
    );
  }

  /* ── a person's gesture from another wall, on a card here ─────────── */

  /** Do what a person at another wall asked of one of this wall's cards, with
   *  the same `Skein` calls this wall's own menu makes — so a card cannot tell
   *  a gesture made there from one made here. Rust has gated it already (the
   *  verb, the switch, a card asking); this re-checks the card as it is now
   *  (`actRefusal`), as `settle_delete` re-runs its refusals at the moment of
   *  deleting. Always answered, for `#take`'s reason. */
  async #perform(p: { id: string; host: string; card: string; verb: string; args: Record<string, unknown> }) {
    const answer = (outcome: "taken" | "refused", why?: string, text?: string) =>
      void invoke("flyway_act_answer", { id: p.id, outcome, why, text }).catch(() => {
        /* The asker's own bound says it may or may not have happened. */
      });
    const me = this.me || "that wall";
    try {
      if (!this.#skein.loaded) return answer("refused", `${me} is still starting — ask again in a moment`);
      const conv = this.#skein.convs.find((c) => c.id === p.card);
      if (!conv) return answer("refused", `no card ${p.card.slice(0, 8)} is open on ${me} — it may have been closed since`);
      const args = p.args ?? {};
      const no = actRefusal(p.verb, args, conv, usable(waterfall.list).map((a) => a.label), me);
      if (no) return answer("refused", no);
      const on = args.on === true;
      switch (p.verb) {
        case "copy-resume":
          return answer("taken", undefined, `claude --resume ${conv.sessionId}`);
        case "copy-cwd":
          return answer("taken", undefined, conv.cwd);
        /* A setting already as asked is done, and touched no further: a stale
           face asking again must not write a second note, nor have a bypass
           release every held card on the wall. */
        case "aside":
          if (conv.aside !== on) this.#skein.setAside(conv, on);
          return answer("taken");
        case "bypass":
          if (conv.bypassCaps !== on) {
            conv.note(`asked from ${p.host}`);
            this.#skein.setBypass(conv, on);
          }
          return answer("taken");
        case "account": {
          /* `putOnAccount` says a refusal as a fault rather than throwing, so
             whether it went is read off the card. */
          const to = String(args.account);
          conv.note(`asked from ${p.host}`);
          await this.#skein.putOnAccount(conv, to);
          return conv.accountLabel === to
            ? answer("taken")
            : answer("refused", `${me} could not put it on ${to} — ${this.#skein.fault || "it refused"}`);
        }
        /* A turn ended, as Escape ends one here. Not working any more is
           what was asked, so a card that finished first is taken. */
        case "stop":
          if (conv.working) {
            conv.note(`stopped from ${p.host}`);
            await this.#skein.stop(conv);
          }
          return answer("taken");
        case "wake": {
          if (!conv.dormant) return answer("taken");
          const woke = await this.#skein.wake(conv);
          if (woke) conv.note(`woken from ${p.host}`);
          return woke ? answer("taken") : answer("refused", `${me} could not wake it — ${conv.activity}`);
        }
        case "clear": {
          /* Asked again once a spawn in flight has landed, since that spawn
             may open a turn the check above could not see (`Skein.clear`). */
          const no = await this.#skein.clear(conv, () => actRefusal(p.verb, args, conv, [], me));
          if (no) return answer("refused", no);
          conv.note(`cleared from ${p.host}`);
          return answer("taken");
        }
        default:
          return answer("refused", `${me} does not know how to ${p.verb} a card from another wall`);
      }
    } catch (e) {
      answer("refused", `${me} could not do that — ${String((e as Error)?.message ?? e)}`);
    }
  }

  /* ── a card's conversation, asked for by another wall ─────────────── */

  /** Make one of this wall's cards' tails for a wall with a panel open on it.
   *  The scrollback and the live lines, as this wall's own panel would draw
   *  them — so a card nobody here has opened has its transcript read off disk
   *  first, as opening it here would. Always answered, for `#take`'s reason:
   *  the far panel can only say "reading…" until it is. */
  async #lend(p: { id: string; card: string }) {
    const answer = (lines: WireLine[] | null, why?: string) =>
      void invoke("flyway_tail_answer", { id: p.id, lines, why }).catch(() => {
        /* The asker's own bound says it was not read in time. */
      });
    const me = this.me || "that wall";
    try {
      if (!this.#skein.loaded) return answer(null, `${me} is still starting — open it again in a moment`);
      const conv = this.#skein.convs.find((c) => c.id === p.card);
      if (!conv) return answer(null, `no card ${p.card.slice(0, 8)} is open on ${me} — it may have been closed since`);
      try {
        await this.#skein.loadHistory(conv);
      } catch {
        /* What is live is still worth reading without the scrollback. */
      }
      answer(tailOf([...conv.history, ...conv.lines]));
    } catch (e) {
      answer(null, `${me} could not make that card's conversation — ${String((e as Error)?.message ?? e)}`);
    }
  }

  #settle(p: { id: string; from: { host: string } }, outcome: "taken" | "refused", why?: string) {
    this.#taken.set(`${p.from.host}\u0000${p.id}`, { outcome, why });
    this.#answer(p, outcome, why);
  }

  #answer(p: { id: string; from: { host: string } }, outcome: "taken" | "refused", why?: string) {
    void invoke("flyway_prompt_answer", { id: p.id, askedBy: p.from.host, outcome, why }).catch(() => {
      /* Nothing here can do better than the asker's own give-up, which says
         it does not know — and that is the truth if this never arrives. */
    });
  }
}
