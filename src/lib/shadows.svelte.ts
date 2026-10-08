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
import { blankAnswers, composeAnswer } from "./asking";
import type { Skein } from "./skein.svelte";
import { spanOf, type Tier } from "./classify";
import { Listeners } from "./listeners";
import {
  advance,
  asLines,
  askedAt,
  askHere,
  DIGEST_V,
  digestOf,
  faceOf,
  idleOf,
  promptRefusal,
  readSnapshot,
  readTail,
  sameCards,
  tailOf,
  weave,
  type WireLine,
  type CardDigest,
  type Sent,
  type SentEvent,
} from "./shadow";

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
};

/** What the link says about a wall's roster entry. Only `quietMs` is read here;
 *  the rest is carried for the panel. */
export type RosterRow = {
  host: string;
  /** The row is this wall's own. */
  me?: boolean;
  quietMs: number;
  standing?: string;
  reason?: string;
};

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
    if (t) return asLines(weave(t, this.sent), this.host, clock.t);
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
  readonly model = undefined;
  readonly effort = undefined;
  readonly streaming = "";
  readonly accountLabel = null;
  readonly bypassCaps = false;
  readonly compactFrac = null;
  readonly holding = null;
  readonly planDoc = null;
  get elsewhere() {
    return { host: this.host, unheard: this.face.unheard };
  }
}

export function shadowKey(host: string, card: string): string {
  return `elsewhere:${host}:${card}`;
}

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

  #skein: Skein;
  #byId = new Map<string, Shadow>();
  /** Where a prompt's events go: its shadow, even after the card has left the
   *  wall, so an answer arriving late lands on the object that asked. */
  #byPrompt = new Map<string, Shadow>();
  /** The same for a close, which is answered on the same event. */
  #byClose = new Map<string, Shadow>();
  #listeners = new Listeners();
  /** Prompts from other walls this wall has taken, by id, with the answer each
   *  got — or null while it is being delivered. See `#take`. */
  #taken = new Map<string, { outcome: "taken" | "refused"; why?: string } | null>();
  #stopEffects: () => void;

  #offered: CardDigest[] | null = null;
  #pending: CardDigest[] | null = null;
  #lastAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(skein: Skein) {
    this.#skein = skein;
    this.#stopEffects = $effect.root(() => {
      $effect(() => {
        if (!this.#skein.loaded) return;
        this.#offer(this.#skein.convs.map((c) => digestOf(this.#sourceOf(c))));
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
        this.#fold(e.payload.id, { kind: "answer", outcome: e.payload.outcome, why: e.payload.why });
      }),
    );
    l.keep(
      listen<{ id: string; from: { host: string; card: string | null }; card: string; text: string }>(
        "flyway:prompt",
        (e) => void this.#take(e.payload),
      ),
    );
    l.keep(listen<{ id: string; card: string }>("flyway:tail", (e) => void this.#lend(e.payload)));
    l.keep(
      listen<{ card: string; host: string }>("flyway:born", (e) => {
        this.births[e.payload.card] = e.payload.host;
      }),
    );
    void invoke<string>("flyway_host").then((h) => (this.me = h)).catch(() => {});
    void invoke<{ card: string; host: string }[]>("flyway_births")
      .then((all) => {
        for (const b of all) this.births[b.card] = b.host;
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
      activity: c.activity,
      held: c.held,
      stalled: c.stalled,
      unacknowledged: c.unacknowledged,
      restingSince: c.restingSince,
      ctx: c.ctx,
      lines: c.lines,
      jobs: c.jobs,
      asks: c.asks,
    };
  }

  /** Coalesce: the newest set wins, and it goes at most once a second. */
  #offer(cards: CardDigest[]) {
    if (this.#offered && sameCards(cards, this.#offered)) {
      this.#pending = null;
      return;
    }
    this.#pending = cards;
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
        snapshot: { v: DIGEST_V, at: Date.now(), cards: next },
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
    this.walls[p.host] = { at: snap.at, madeAt: now - Math.max(0, p.ageMs || 0), cards: snap.cards };
    /* A snapshot is sent only by the wall it describes — the link does not
       relay them — so one arriving is that wall being heard. */
    if (live) this.#hear(p.host, 0);
    this.#reconcile();
  }

  /** Keep each shadow as the same object across snapshots, so the prompts said
   *  to it and the focus on it survive the wall it is on changing. */
  #reconcile() {
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
        this.#sheets(s, this.walls[host]!);
        next.push(s);
      }
    }
    for (const id of [...this.#byId.keys()]) if (!keep.has(id)) this.#byId.delete(id);
    this.shadows = next;
  }

  /** Bring a shadow's sheets in line with the questions its digest carries:
   *  the same sheet for the same ask, a fresh one for a new ask, and none for
   *  an ask that has gone — answered on its own wall, or out of time. */
  #sheets(s: Shadow, w: Wall) {
    const was = new Map(s.sheets.map((a) => [a.askId, a]));
    const now = s.digest.asks.map(
      (a) =>
        was.get(a.askId) ?? {
          askId: a.askId,
          questions: askHere(a, s.host),
          answers: blankAnswers(askHere(a, s.host)),
          ours: false,
          since: askedAt(a, w.at, w.madeAt),
        },
    );
    if (now.length !== s.sheets.length || now.some((a, i) => a !== s.sheets[i])) s.sheets = now;
    const live = new Set(now.map((a) => a.askId));
    if (s.answering.some((id) => !live.has(id))) s.answering = s.answering.filter((id) => live.has(id));
  }

  /** The first question on another wall this one may answer — what the dock
   *  shows when nothing on this wall is asking. */
  firstAsking(): { shadow: Shadow; sheet: PendingAsk } | null {
    for (const shadow of this.shadows) {
      const sheet = shadow.open[0];
      if (sheet) return { shadow, sheet };
    }
    return null;
  }

  /* ── speaking to one ──────────────────────────────────────────────── */

  /** Answer a question a card on another wall is parked on.
   *
   *  The answer is the text the dock here would have sent — `composeAnswer`,
   *  numbered list and asides included — and it rides the prompt wire with the
   *  ask's id, which the owning wall hands straight into the parked call. It is
   *  drawn among what was said to the card from here and goes through the same
   *  four readings a prompt does: a question answered into a link that is down
   *  must not look answered. */
  async answer(s: Shadow, sheet: PendingAsk) {
    const text = composeAnswer(sheet.questions, sheet.answers);
    const id = crypto.randomUUID();
    const about = sheet.questions[0]?.header ?? "a question";
    s.sent.push({ id, text, at: Date.now(), state: "queued", askId: sheet.askId, about });
    this.#byPrompt.set(id, s);
    s.answering = [...s.answering, sheet.askId];
    try {
      await invoke("flyway_prompt", { id, to: s.host, card: s.card, text, askId: sheet.askId });
    } catch (e) {
      this.#fold(id, { kind: "unsent", why: String(e) || "the link would not take it" });
    }
  }

  /** Send a prompt to a card on another wall. Drawn at once, as a local send
   *  is, and marked for what it is until the other wall answers. */
  async send(s: Shadow, text: string) {
    const id = crypto.randomUUID();
    s.sent.push({ id, text, at: Date.now(), state: "queued" });
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
      await invoke("flyway_prompt", { id, to: s.host, card: s.card, text });
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
  async #take(p: { id: string; from: { host: string; card: string | null }; card: string; text: string }) {
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

    conv.note(`sent from ${p.from.host}`);
    let sent = false;
    try {
      sent = await this.#skein.send(conv, p.text);
    } catch {
      sent = false;
    }
    this.#settle(
      p,
      sent ? "taken" : "refused",
      sent ? undefined : `${this.me || "that wall"} could not deliver it — ${conv.activity}`,
    );
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
