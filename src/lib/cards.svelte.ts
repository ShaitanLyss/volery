/* A card, for a gesture: one handle over a card on this wall and a card on
 * another, so the menu, the dock, the keyboard and the panel are written once.
 *
 * A shadow is its own type for a reason that still holds (`elsewhere.md`, "a
 * shadow is a fifth kind"): `Skein.convs` is wired to rousing, the reap pass,
 * `#fillHistory`, the hold sweep and `#persistConv`, and a card from another
 * machine reaching any of them is a `claude --resume` here on a session that
 * only exists over there. But every *gesture* then took a `Conversation`, so
 * each grew a branch for a shadow — eighteen in `App.svelte`, eleven in the
 * dock — and a menu of its own with two rows. Forgetting one was silent, and
 * that is how the two kinds drifted. The guard belongs on `Skein.convs`; it
 * never needed to reach the menu.
 *
 * So a gesture holds a `CardHandle`, asks it `can(verb)` and calls `do(verb)`.
 * `LocalCard` wraps a `Conversation` and calls `Skein`; `RemoteCard` wraps a
 * `Shadow` and asks its wall (`Elsewhere.act`, one `act` frame). Nothing here
 * hands a `Shadow` to anything that wants a `Conversation`, and nothing on the
 * hot path goes through a handle: a card face still draws off `CardFace`, the
 * transcript off `Readable`, and both are the very objects the handle wraps.
 * A handle is made once per card and kept (`Cards.find`), and a local verb is
 * a one-line delegate.
 *
 * This file is one of the few places that knows a card can be remote, and
 * should stay so: anything else that finds itself asking is a gesture that
 * belongs here as a verb. Design: `.claude/rules/elsewhere.md`, "one card
 * handle". */

import type { Conversation, PendingAsk } from "./conversation.svelte";
import type { Elsewhere, Shadow } from "./shadows.svelte";
import type { Skein } from "./skein.svelte";
import type { CardFace } from "./Card.svelte";
import type { Readable } from "./transcript";
import type { Notice } from "./notice";
import type { MenuTarget } from "./menu";
import type { Turn } from "./attach";
import type { Timeline } from "./timeline";
import { actFor, canDo, carriesTo, dockHints, verbsFor, whyNot, type Can, type Remote, type Said, type Verb } from "./handle";
import { closeWarnings } from "./closing";
import { presetById } from "./presets";
import { usable } from "./accounts";
import { waterfall } from "./waterfall.svelte";

/** What a gesture holds. See the head of this file. */
export interface CardHandle {
  readonly id: string;
  /** This wall's card, or null for one on another wall — for the few things
   *  only a card here can be: picked into a selection, reached by a broadcast,
   *  the directory a `!` line runs in. Never for a gesture: a gesture asks
   *  `can` and calls `do`. */
  readonly conv: Conversation | null;
  /** What a card face draws: the wrapped object itself, not a copy. */
  readonly face: CardFace;
  /** What the transcript reads: the wrapped object itself. */
  readonly readable: Readable;
  /** The wall it runs on, when that is not this one. */
  readonly remote: Remote | null;
  /** Its project as a panel heads it — `skein`, or `skein · on lab`. */
  readonly where: string;
  /** May a panel drawn for one of its questions run scripts — the card's
   *  kind, as it is for a question asked here. */
  readonly scripts: boolean;
  /** What the dock says beside its name. */
  readonly hints: Said[];
  /** The fields its right-click reads (`menu.ts::cardRows`). */
  menu(): MenuTarget;
  /** Whether `verb` may be done to it now — `"yes"`, or why not. */
  can(verb: Verb): Can;
  /** Do it. A refusal is said (as a fault) and returned, never thrown. */
  do(verb: Verb, args?: Record<string, unknown>): Promise<Can>;
  /** Whether this turn can reach it — asked before the draft is cleared, so
   *  a refusal keeps what was typed. Pictures travel to a card elsewhere as
   *  they reach one here; what cannot arrive is said (`handle.ts::carriesTo`). */
  carries(turn: Turn): Can;
  /** Say something to it. */
  say(text: string, turn: Turn): Promise<void>;
  /** A keystroke turning towards it: a dormant card here starts its process
   *  as you type. Nothing for a card elsewhere — no touch travels. */
  stir(): void;
  /** Read what it said before this panel opened on it. */
  history(): void;
  /** Open a file one of its tool calls named. Absent where the files are on
   *  another machine. */
  readonly look?: (path: string, line: number | null) => void;

  /* ── what it is waiting on you for ── */
  /** The question at the front of its queue, if it is parked on one you can
   *  answer from here. */
  readonly ask: PendingAsk | null;
  /** How many questions it is parked on in all. */
  readonly asking: number;
  /** Its notices still standing. */
  readonly notices: readonly Notice[];
  answer(ask: PendingAsk): void;
  defer(ask: PendingAsk): Promise<void> | void;
  /** What has been answered of the sheet in front of you, kept in case the
   *  call closes before you send it. */
  holdAsk(): void;
  /** Take a notice down: an empty reply acknowledges it, anything else is a
   *  follow-up sent to the card. */
  acknowledge(n: Notice, reply: string): void | boolean | Promise<boolean | void>;
}

/** What `App.svelte` lends the handles: the gestures whose state is the
 *  window's — a dialog, the glass, the clipboard, this wall's furniture —
 *  and nothing that is a card's. */
export type Hands = {
  copy(text: string): Promise<void>;
  /** Stick it to the glass or take it back; the canvas keeps each kind's
   *  spots apart. */
  glass(kind: "card" | "shadow", id: string): void;
  /** Hang its last message up beside it, on the wall or the glass — this
   *  wall's furniture, so a card here and one elsewhere ask it alike. */
  keep(id: string, glass: boolean): void;
  /** A card here drawn on the glass only because its grouping is stuck. */
  heldByGlass(conv: Conversation): boolean;
  /** Ask before a close that would end something — one plate for both kinds,
   *  which calls `do("close", { sure: true })` on a yes. */
  confirmClose(card: CardHandle, warnings: string[], t: Timeline | null): void;
  /** Take a card here off the wall: the focus moved on, its draft let go. */
  close(conv: Conversation): Promise<void>;
  processes(conv: Conversation): void;
  unpin(conv: Conversation): void;
  look(root: string, path: string, line: number | null): void;
  /** This wall's furniture around a card here, for its menu: the groupings it
   *  could move to, the walls it could move to, whether it is pinned or on the
   *  glass, the presets a plan could be handed to. */
  furniture(conv: Conversation): Partial<MenuTarget>;
};

/** Say a refusal where it will be seen, and hand it back. */
function refused(skein: Skein, c: Can): Can {
  const why = whyNot(c);
  if (why) skein.fault = why;
  return c;
}

/** A card on this wall. Every verb is a delegate to `Skein`, as the menu's
 *  arms in `App.svelte` were. */
export class LocalCard implements CardHandle {
  readonly remote = null;
  readonly #skein: Skein;
  readonly #hands: Hands;
  constructor(
    readonly conv: Conversation,
    skein: Skein,
    hands: Hands,
  ) {
    this.#skein = skein;
    this.#hands = hands;
  }
  get id() {
    return this.conv.id;
  }
  get face(): CardFace {
    return this.conv;
  }
  get readable(): Readable {
    return this.conv;
  }
  get where() {
    return this.conv.project;
  }
  get scripts() {
    return this.conv.kind !== "chat";
  }
  get hints() {
    return dockHints(this.conv, null);
  }
  menu(): MenuTarget {
    const c = this.conv;
    return {
      kind: "card",
      dormant: c.dormant,
      spoken: c.everSpoke || c.working,
      aside: c.aside,
      bypassing: c.bypassCaps,
      accounts: waterfall.list.length > 0,
      /* The same list `/account` offers and for the same reasons; `menu.ts`
         drops the submenu below two, so a wall with one account grows no row. */
      accountPicks: usable(waterfall.list).map((a) => ({ id: a.label, label: a.label, on: a.label === c.accountLabel })),
      /* Only where there is a plan to hand on — see menu.ts. */
      plan: !!c.planDoc,
      ...this.#hands.furniture(c),
    };
  }
  can(verb: Verb): Can {
    const c = this.conv;
    /* A card drawn on the pane only because its whole grouping is stuck: the
       grouping would go on carrying it, so "put it back on the wall" is a
       promise this card cannot keep. */
    if (verb === "glass" && this.#hands.heldByGlass(c))
      return { no: "this card is on the glass with its grouping — move the grouping instead (space then g g)" };
    if (verb === "hand" && !c.planDoc) return { no: "it has no plan to hand on" };
    return canDo(null, verb, { dormant: c.dormant, working: c.working, spoken: c.everSpoke });
  }
  async do(verb: Verb, args: Record<string, unknown> = {}): Promise<Can> {
    const ok = this.can(verb);
    if (ok !== "yes") return refused(this.#skein, ok);
    const c = this.conv;
    const s = this.#skein;
    const on = (now: boolean) => (typeof args.on === "boolean" ? args.on : !now);
    switch (verb) {
      case "glass":
        this.#hands.glass("card", c.id);
        break;
      case "keep":
        this.#hands.keep(c.id, args.glass === true);
        break;
      case "close": {
        /* A card with a timeline in flight asks first — closing ends a plan
           you have been watching — and so does a card doing something, since
           the ✕ sits on every card. `closing.ts` decides; this only asks. */
        const t = s.timelines.liveFor(c.id);
        const warnings = closeWarnings({ working: c.working, jobs: c.jobs.length });
        if ((t || warnings.length) && args.sure !== true) this.#hands.confirmClose(this, warnings, t);
        else await this.#hands.close(c);
        break;
      }
      case "stop":
        await s.stop(c);
        break;
      case "wake":
        await s.wake(c);
        break;
      case "aside":
        s.setAside(c, on(c.aside));
        break;
      case "bypass":
        s.setBypass(c, on(c.bypassCaps));
        break;
      case "account":
        await s.putOnAccount(c, String(args.account ?? ""));
        break;
      case "clear":
        await s.clear(c);
        break;
      /* The session id is what `--resume` takes, and this is the only place
         the UI hands it over. `sessionId` rather than `id`, or a cleared card
         would hand over a resume command for a session that never existed. */
      case "copy-resume":
        await this.#hands.copy(`claude --resume ${c.sessionId}`);
        break;
      case "copy-cwd":
        await this.#hands.copy(c.cwd);
        break;
      case "processes":
        this.#hands.processes(c);
        break;
      case "pin":
        if (args.on === false) this.#hands.unpin(c);
        break;
      case "regroup":
        await s.setCardTerritory(c.id, String(args.territory ?? ""));
        break;
      /* The maker opens on the preset the row named, never on the wall's
         default: the choice is the reason the row exists. */
      case "hand":
        await s.handOff(c, presetById(String(args.preset ?? "")) ?? null);
        break;
      case "move": {
        const why = await s.moveCard(c, String(args.host ?? ""));
        if (why) return refused(s, { no: why });
        break;
      }
    }
    return "yes";
  }
  carries(): Can {
    return "yes";
  }
  async say(text: string, turn: Turn) {
    await this.#skein.send(this.conv, text, turn);
  }
  stir() {
    this.#skein.stir(this.conv);
  }
  history() {
    void this.#skein.loadHistory(this.conv);
  }
  /* A tool call's path counts from the card's directory; a chat card has
     none, and the viewer is handed the empty root it always was. */
  readonly look = (path: string, line: number | null) =>
    this.#hands.look(this.conv.kind === "project" ? this.conv.cwd : "", path, line);
  get ask() {
    return this.conv.pendingAsk;
  }
  get asking() {
    return this.conv.asks.length;
  }
  get notices(): readonly Notice[] {
    return this.#skein.noticeQueue.filter((n) => n.conversationId === this.conv.id);
  }
  answer() {
    void this.#skein.answerAsk(this.conv);
  }
  defer() {
    return this.#skein.deferAsk(this.conv);
  }
  holdAsk() {
    void this.#skein.holdAsk(this.conv);
  }
  acknowledge(n: Notice, reply: string) {
    return reply ? this.#skein.followUpNotice(n, reply) : this.#skein.acknowledgeNotice(n);
  }
}

/** A card on another wall. A verb its wall announced crosses as one `act`
 *  (`flyway/act.rs`); the close keeps its own road; what is this wall's own —
 *  the glass — is done here. Everything else says why it cannot. */
export class RemoteCard implements CardHandle {
  readonly conv = null;
  readonly #skein: Skein;
  readonly #walls: Elsewhere;
  readonly #hands: Hands;
  constructor(
    readonly shadow: Shadow,
    skein: Skein,
    walls: Elsewhere,
    hands: Hands,
  ) {
    this.#skein = skein;
    this.#walls = walls;
    this.#hands = hands;
  }
  get id() {
    return this.shadow.id;
  }
  get face(): CardFace {
    return this.shadow;
  }
  get readable(): Readable {
    return this.shadow;
  }
  get remote(): Remote {
    return this.shadow.remote;
  }
  get where() {
    return `${this.shadow.project} · on ${this.shadow.host}`;
  }
  get scripts() {
    return this.shadow.digest.kind !== "chat";
  }
  get hints() {
    return dockHints(this.shadow, this.remote);
  }
  menu(): MenuTarget {
    const s = this.shadow;
    return {
      kind: "card",
      host: s.host,
      verbs: verbsFor(s.remote),
      glass: !!s.glass,
      dormant: s.dormant,
      spoken: s.everSpoke || s.working,
      aside: s.aside,
      bypassing: s.bypassCaps,
      accounts: s.accounts.length > 0,
      /* That wall's subscriptions, since an account is spent where the card
         runs. An older wall sends none, which offers no choice. */
      accountPicks: s.accounts.map((a) => ({ id: a, label: a, on: a === s.accountLabel })),
    };
  }
  can(verb: Verb): Can {
    const s = this.shadow;
    return canDo(s.remote, verb, { dormant: s.dormant, working: s.working, spoken: s.everSpoke });
  }
  async do(verb: Verb, args: Record<string, unknown> = {}): Promise<Can> {
    const ok = this.can(verb);
    if (ok !== "yes") return refused(this.#skein, ok);
    const s = this.shadow;
    if (verb === "glass") {
      this.#hands.glass("shadow", s.id);
      return "yes";
    }
    if (verb === "keep") {
      this.#hands.keep(s.id, args.glass === true);
      return "yes";
    }
    if (verb === "close") {
      /* Asks first off its digest, on the same plate as a close here. Nothing
         is removed on this wall: the card goes when its wall's next snapshot
         drops it, and a refusal comes back on the shadow. */
      const warnings = closeWarnings({ working: s.digest.working, jobs: s.digest.jobs });
      if (warnings.length && args.sure !== true) this.#hands.confirmClose(this, warnings, null);
      else void this.#walls.close(s);
      return "yes";
    }
    /* Everything else is asked of its wall. A refusal is said by
       `Elsewhere.act` itself; what a reading verb answered is this wall's to
       copy. */
    const asked = actFor(verb, args, { aside: s.aside, bypassCaps: s.bypassCaps, working: s.working });
    if (!asked) return refused(this.#skein, { no: `that is on ${s.host}` });
    const r = await this.#walls.act(s, asked.verb, asked.args);
    if (r.outcome !== "taken") return { no: r.why ?? `${s.host} would not do that` };
    if (r.text) await this.#hands.copy(r.text);
    return "yes";
  }
  /* The sentence and its pictures go as they are, and the far wall's own
     send decides what they mean there — attaching each exactly as a paste in
     its dock would (`attach.md`). What cannot arrive is refused with the draft
     kept, in `carriesTo`'s words. */
  carries(turn: Turn): Can {
    return carriesTo(this.shadow.remote, turn);
  }
  async say(text: string, turn: Turn) {
    await this.#walls.send(this.shadow, text, turn);
  }
  stir() {}
  history() {
    void this.shadow.readTail();
  }
  get ask() {
    return this.shadow.open[0] ?? null;
  }
  get asking() {
    return this.shadow.open.length;
  }
  get notices(): readonly Notice[] {
    return this.shadow.notices;
  }
  answer(ask: PendingAsk) {
    void this.#walls.answer(this.shadow, ask);
  }
  defer(ask: PendingAsk) {
    return this.#walls.defer(this.shadow, ask);
  }
  holdAsk() {}
  acknowledge(n: Notice, reply: string) {
    return this.#walls.answerNotice(this.shadow, n, reply);
  }
}

/** Every card a gesture can reach, here and on every other wall, as handles.
 *  One handle per card for as long as the card stands, so a `$derived` over a
 *  handle hands back the same object and wakes nothing that reads it. */
export class Cards {
  #local = new WeakMap<Conversation, LocalCard>();
  #remote = new WeakMap<Shadow, RemoteCard>();
  constructor(
    readonly skein: Skein,
    readonly walls: Elsewhere,
    readonly hands: Hands,
  ) {}

  #ofConv(c: Conversation): LocalCard {
    let h = this.#local.get(c);
    if (!h) this.#local.set(c, (h = new LocalCard(c, this.skein, this.hands)));
    return h;
  }
  #ofShadow(s: Shadow): RemoteCard {
    let h = this.#remote.get(s);
    if (!h) this.#remote.set(s, (h = new RemoteCard(s, this.skein, this.walls, this.hands)));
    return h;
  }

  /** The card with this id, on this wall or another, or null. */
  find(id: string | null | undefined): CardHandle | null {
    if (!id) return null;
    const c = this.skein.convs.find((x) => x.id === id);
    if (c) return this.#ofConv(c);
    const s = this.walls.find(id);
    return s ? this.#ofShadow(s) : null;
  }

  /** The handle for a card here. */
  of(c: Conversation): CardHandle {
    return this.#ofConv(c);
  }

  /** Is this card — here or elsewhere — still on the wall? */
  stands(id: string): boolean {
    return this.skein.convs.some((c) => c.id === id) || this.walls.shadows.some((s) => s.id === id);
  }

  /** Every card parked on a question you can answer from here: this wall's,
   *  then every other's. */
  get asking(): CardHandle[] {
    return [...this.skein.blocked.map((c) => this.#ofConv(c)), ...this.walls.shadows.filter((s) => s.open.length).map((s) => this.#ofShadow(s))];
  }

  /** Every notice standing, with its card: this wall's queue in its order,
   *  then every other wall's. */
  get noticing(): { card: CardHandle; notice: Notice }[] {
    const out: { card: CardHandle; notice: Notice }[] = [];
    for (const n of this.skein.noticeQueue) {
      const c = this.skein.convs.find((x) => x.id === n.conversationId);
      if (c) out.push({ card: this.#ofConv(c), notice: n });
    }
    for (const s of this.walls.shadows) for (const n of s.notices) out.push({ card: this.#ofShadow(s), notice: n });
    return out;
  }

  /** Everything waiting on you, counted: every question — a card can be
   *  parked on several — and every notice. */
  get waitingOnYou(): number {
    return (
      this.skein.pendingAsks +
      this.skein.noticeQueue.length +
      this.walls.shadows.reduce((n, s) => n + s.open.length + s.notices.length, 0)
    );
  }
}
