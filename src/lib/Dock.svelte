<script lang="ts">
  /* The dock: the strip along the bottom of the wall where a prompt is written.
   *
   * Cut out of `App.svelte` after a `.ghost` here and a `.ghost` in the header
   * turned out to be the same selector — one 565-line stylesheet holding two
   * unrelated subsystems, where Svelte's scoping had nothing to bite on. Both
   * halves now have their own, which is the sort of fix a language enforces
   * rather than a reviewer. `test/styles.test.ts` guards the rest.
   *
   * What is here is what the dock alone owns: the target line, the palette in
   * its two stages, the `!` line's offering and bar, and the field. What is not
   * is the keyboard — `onDraftKey` stays in `App.svelte` beside `onGlobalKey`,
   * deliberately. That ladder is not dock-local: half its branches are about the
   * wall (Tab between cards, Escape to the ground, the transcript's scrolling),
   * and it is the *boundary* between the dock and everything else rather than a
   * thing inside it. Splitting it across two files would put the two halves of
   * one priority order where neither can be read against the other. */
  import { tick, untrack } from "svelte";
  import Ask from "./Ask.svelte";
  import Notice from "./Notice.svelte";
  import type { Notice as NoticeRow } from "./notice";
  import type { Skein } from "../lib/skein.svelte";
  import type { Conversation, PendingAsk } from "../lib/conversation.svelte";
  import type { Shadow } from "./shadows.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import { nextItem, settleHold, shownItem, steady, type Hold, type Waiting } from "./queue";
  import { replies } from "./replies.svelte";
  import type { Orphan, Reply } from "./replies";
  import { isShadowKey } from "./shadow";
  import type { DockChord } from "./leader";
  import { scopeFiles } from "./paths.svelte";
  import { completionForChoice, slashAt, stirsCard, typingChoice, type Command } from "./commands";
  import { nameBesideProject } from "./naming";
  import { promptPath } from "./shell";
  import { BANG, isBang, kindLabel, tokens, type Completion, type Match } from "./bang";
  import { dropToken, runsOf, sizeNote } from "./attach";
  import type { DockSite } from "./berth";

  let {
    field,
    skein,
    bang,
    focused,
    remote = null,
    shadows = [],
    onremoteanswer,
    onremotedefer,
    onremotenotice,
    onremoteselect,
    targets,
    waiting,
    clashing,
    bangCard,
    dropping,
    berth,
    grabbing,
    onmoor,
    onheight,
    prompt = $bindable(),
    onkey,
    onsendtext,
    onrun,
    ontake,
    oncycle,
    onmore,
    onselect,
  }: {
    /** What is being typed and what the typing currently means. */
    field: Field;
    skein: Skein;
    /** The `!` line's session — its runs and its completions. */
    bang: Bang;
    /** The card in the ring, if there is one. */
    focused: Conversation | null;
    /** The card in the ring when it is on another wall — never at the same time
     *  as `focused`. Its own prop and its own type, so that nothing here that
     *  acts on a card can be aimed at one by accident; all the dock does with it
     *  is say where a prompt would go and let one be typed. */
    remote?: Shadow | null;
    /** Every card on another wall. Their questions and notices join the queue
     *  beside this wall's own (`items`), drawn by the same panels, and held by
     *  the same rule — see `queue.ts`. */
    shadows?: readonly Shadow[];
    onremoteanswer?: (shadow: Shadow, sheet: PendingAsk) => void;
    onremotedefer?: (shadow: Shadow, sheet: PendingAsk) => void | Promise<void>;
    /** Take a far notice down over there: an empty reply acknowledges,
     *  anything else is a follow-up sent to the card. */
    onremotenotice?: (shadow: Shadow, notice: NoticeRow, reply: string) => void | Promise<boolean>;
    onremoteselect?: (shadow: Shadow) => void;
    /** Everything a send would reach: the gathering, or the focused card, or
     *  nothing at all. */
    targets: Conversation[];
    /** Cards that want you, in the order the Tab cycle takes them. */
    waiting: Conversation[];
    /** Ids among the targets that have already edited the same files as another
     *  target — a broadcast about to land twice in one tree. */
    clashing: string[];
    /** Which card a `!` line would run in. One card, never the gathering. */
    bangCard: Conversation | null;
    /** A file is being dragged over somewhere that would attach it to this
     *  draft. The only feedback a drag gets: an OS file drag fires no DOM drag
     *  events at all here — the webview swallows them so the payload can carry
     *  real paths — so nothing under the cursor is ever told it is hovered, and
     *  without this the dock would look identical whether a drop was about to
     *  land in the prompt or fly past onto the wall. */
    dropping: boolean;
    /** Where the dock is moored, and — while it is floating — the box it was
     *  put in, in window coordinates. The dock has always been a strip along
     *  the bottom; over three screens that is a line of text pinned to the
     *  corner of one of them, so it can go to the top or come off both edges.
     *  See `berth.ts`, which owns the sites and the drop rule. */
    berth: { site: DockSite; x: number; y: number; w: number };
    /** The mooring handle is being dragged, so it says so under the cursor. */
    grabbing: boolean;
    /** The three halves of that drag, which live in `App.svelte` beside the
     *  panel's — one gesture over two surfaces wants one implementation, and
     *  the room a drop is measured against is the window's rather than the
     *  dock's. */
    onmoor: {
      down: (e: PointerEvent) => void;
      move: (e: PointerEvent) => void;
      up: () => void;
      reset: () => void;
    };
    /** How tall the dock is drawn, which is the draft's business and not the
     *  berth's — the field grows as you type. Reported rather than stored, so
     *  a floating dock can be clamped against a bottom edge it actually has. */
    onheight: (h: number) => void;
    /** The textarea itself, handed back up so a keystroke on the wall can put
     *  the focus here and the character with it. */
    prompt: HTMLTextAreaElement | undefined;
    onkey: (e: KeyboardEvent) => void;
    onsendtext: (text: string, broadcast: boolean) => Promise<void>;
    onrun: (cmd: Command, broadcast: boolean) => Promise<void>;
    ontake: (offer: Completion, match: Match) => Promise<void>;
    oncycle: (step: 1 | -1) => void;
    /** Put the ring on the card — here or elsewhere — of the item "more
     *  waiting on you" just stepped to, so the transcript beside it is that
     *  card's. Which item is the dock's question (`queue.ts::nextItem`). */
    onmore: (card: string) => void;
    /** Land on a card: the ring, the gathering and the panel, the way clicking
     *  it does. Asked for by the ask panel when the card being asked is not the
     *  one selected. */
    onselect: (conv: Conversation) => void;
  } = $props();

  /* ── what the panel is already on ──────────────────────────────────────
   *
   * The dock draws one thing out of a queue every card on the wall — and every
   * card on every other wall in the flyway — is writing to all the time. Which
   * one is a single hold over all of it, of every kind: a question, a notice,
   * either from another wall. It stays on what it holds for as long as that
   * exists, whatever arrives and whatever it is; `queue.ts` has the rule, and
   * the bug that made it one rule rather than one per kind.
   *
   * `$effect.pre` rather than `$effect` so the hold is settled before the
   * template reads the deriveds that depend on it: doing it after would have
   * the panel drawn once with the stale hold on the frame you click a card. */

  /** One thing waiting on you, with what its panel needs to draw it.
   *
   *  Only the question at the *front* of a card's queue is an item: a card's
   *  questions are answered in the order it asked them, and `answerAsk`
   *  answers the front one. The rest are counted in `waitingOnYou` and come
   *  forward one by one, as the hold moves on to them (`settleHold`'s
   *  same-card rule). */
  type Item =
    | (Waiting & { kind: "ask"; conv: Conversation; ask: PendingAsk })
    | (Waiting & { kind: "notice"; conv: Conversation; notice: NoticeRow })
    | (Waiting & { kind: "far-ask"; shadow: Shadow; ask: PendingAsk })
    | (Waiting & { kind: "far-notice"; shadow: Shadow; notice: NoticeRow });

  /* Keyed as the panels key their replies (`replies.ts`), so "this item is
     still waiting" and "this reply's item is still waiting" are one question.
     A far notice's id already carries its shadow's (`afar.ts::noticeHere`).

     And every item that has not changed is handed back as the very object it
     was (`steady`): this is rebuilt on any traffic anywhere — a far wall's
     digest alone does it every few seconds — and a panel handed a new object
     for the same question wakes everything reading it. Plain, not `$state`:
     the derived's own memory, read and written only here. */
  let lastItems = new Map<string, Item>();
  const items = $derived.by((): Item[] => {
    const out: Item[] = [];
    for (const conv of skein.blocked) {
      const ask = conv.pendingAsk;
      if (ask) {
        out.push({ kind: "ask", key: `ask:${ask.askId}`, card: conv.id, tier: 0, far: false, conv, ask });
      }
    }
    for (const shadow of shadows) {
      const ask = shadow.open[0];
      if (ask) {
        out.push({ kind: "far-ask", key: `ask:${ask.askId}`, card: shadow.id, tier: 0, far: true, shadow, ask });
      }
    }
    for (const notice of skein.noticeQueue) {
      const conv = skein.convs.find((c) => c.id === notice.conversationId);
      if (conv) {
        out.push({ kind: "notice", key: `notice:${notice.id}`, card: conv.id, tier: 1, far: false, conv, notice });
      }
    }
    for (const shadow of shadows) {
      for (const notice of shadow.notices) {
        out.push({ kind: "far-notice", key: `notice:${notice.id}`, card: shadow.id, tier: 1, far: true, shadow, notice });
      }
    }
    const kept = steady(lastItems, out);
    lastItems = new Map(kept.map((t) => [t.key, t]));
    return kept;
  });

  /** The card in the ring, here or on another wall — never both. */
  const ring = $derived(focused?.id ?? remote?.id ?? null);

  /** Is this card — here or elsewhere — still on the wall? */
  function stands(card: string): boolean {
    return skein.convs.some((c) => c.id === card) || shadows.some((s) => s.id === card);
  }

  function whoOf(t: Item): string {
    const [project, title] =
      t.kind === "ask" || t.kind === "notice"
        ? [t.conv.project, t.conv.title]
        : [`${t.shadow.project} · on ${t.shadow.host}`, t.shadow.title];
    const name = nameBesideProject(title);
    return `${project}${name ? ` · ${name}` : ""}`;
  }

  let hold = $state.raw<Hold | null>(null);
  /* Plain, not `$state`: this effect's own memory of the last ring and the
     last queue it saw, and nothing may re-run on either. */
  let ringed: string | null = null;
  let seen = new Map<string, Item>();
  $effect.pre(() => {
    const now = items;
    const at = ring;
    untrack(() => {
      /* The ring moving is you choosing a card — unless the card it was on is
         gone. Closing the card in the ring moves the ring on by itself
         (`closeConv` in `App.svelte`), and that is the wall tidying up after
         you, not you choosing whichever card it landed on. */
      const moved = at !== ringed && (ringed === null || stands(ringed));
      ringed = at;
      const before = hold;
      hold = settleHold(now, at, hold, moved);
      if (moved || hold?.key !== before?.key) swapped = null;
      /* The held item went without you: guard what you were typing. */
      if (!moved && before && hold && hold.key !== before.key && !replies.byYou(before.key)) {
        const gone = seen.get(before.key);
        if (gone) guardSwap(gone);
      }
      seen = new Map(now.map((t) => [t.key, t]));
    });
  });

  /* What is drawn. Asked of the same rule as the hold rather than read off
     it, so it is right on the very frame an item goes, before the effect above
     has re-settled anything. */
  const shown = $derived(shownItem(items, ring, hold));

  /* ── the held item going while you type into it ────────────────────────
   *
   * Nothing arriving moves the hold, but the held item can still *go*: a
   * question's deadline, a rest notice taken down because its card started a
   * turn, another wall answering it or going quiet. The hold moves on to the
   * next — and when that is the same kind, the same panel is reused, the caret
   * stays where it was, and the rest of your sentence and its Enter would land
   * on a different question. Blurring the field is no answer: a key typed with
   * nothing focused goes to the prompt (`onGlobalKey`), and its Enter would
   * then send the tail of the sentence to the card in the ring.
   *
   * So the field keeps the caret, the note says what happened, and the first
   * Enter after the swap is held — once. Your words for the one that went are
   * still kept under it (`replies`), and handed back by the line below. */
  let swapped = $state<string | null>(null);
  let heldEl = $state<HTMLElement | undefined>(undefined);

  function guardSwap(gone: Item) {
    const el = document.activeElement;
    if (!heldEl || !(el instanceof HTMLElement) || !heldEl.contains(el)) return;
    const kind = gone.kind === "ask" || gone.kind === "far-ask" ? "question" : "notice";
    swapped = `the ${kind} from ${whoOf(gone)} went while you were in it — this is another one, so enter is held once`;
  }

  function guardEnter(e: KeyboardEvent) {
    if (!swapped || e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    swapped = null;
  }

  /* The whole queue, as the "more" line counts it. Questions are counted
     rather than the cards holding them: one card can be parked on several at
     once (`Conversation.asks`), and a line reading "2 more waiting on you"
     over three unanswered questions is an instrument that cannot be trusted
     to have counted the one you have not seen. Arrivals are signalled here and
     only here — never by moving what you are on. */
  const waitingOnYou = $derived(
    skein.pendingAsks +
      skein.noticeQueue.length +
      shadows.reduce((n, s) => n + s.open.length + s.notices.length, 0),
  );

  /** What "more waiting on you" would step to — null when everything else is
   *  queued behind the card's own question, which only answering reaches. */
  const next = $derived(nextItem(items, shown?.key ?? null));

  /** Step to the next item, and put its card in the ring so the transcript
   *  beside it is the one it is about. Setting the hold first is what makes
   *  the ring landing there agree with it rather than re-decide. */
  function more() {
    if (!next) return;
    hold = { key: next.key, card: next.card };
    swapped = null;
    onmore(next.card);
  }

  /* The dock draws whichever card is waiting, which need not be the card in
     the ring — `elsewhere` is that case and it is drawn on the panel. So a
     path in the question belongs to the asking card's directory, and the root
     this falls back to otherwise is the focused one: the same file name in two
     projects would have opened the wrong one, silently. See `scopeFiles`. */
  const shownCard = $derived(
    shown?.kind === "ask" || shown?.kind === "notice" ? shown.conv : null,
  );

  /* ── a reply whose item went first ─────────────────────────────────────
   *
   * What you typed is kept under the item it was typed to (`replies`), and an
   * item can go before its reply is sent: a deadline, a turn taking a rest
   * notice down, a send the other side refused, a question you deferred, the
   * process dying under a parked one. So whatever is kept for an item no
   * longer waiting is said here, with the words, and offered back — derived
   * from the store and the queue alone, which is what makes it survive a
   * reload: nothing has to have watched the item go. A reply is only ever let
   * go on purpose.
   *
   * Not before the queue it belongs to has been read: at launch every notice
   * looks gone until the queue is read, and a far one until its wall is
   * heard. A far card whose wall never comes back keeps its reply until it
   * ages out (`REPLY_KEEP_MS`) — the one case this cannot say anything about. */
  const live = $derived(new Set(items.map((t) => t.key)));
  function ready(r: Reply): boolean {
    const far = shadows.find((s) => s.id === r.card);
    if (far) return !far.face.unheard;
    if (isShadowKey(r.card)) return false;
    return skein.loaded && skein.noticesRead;
  }
  const strays = $derived(replies.orphans(live, ready));
  const stray = $derived(strays[0] ?? null);

  function reachable(o: Orphan): { conv: Conversation | null; shadow: Shadow | null } | null {
    const conv = skein.convs.find((c) => c.id === o.card) ?? null;
    const shadow = conv ? null : (shadows.find((s) => s.id === o.card) ?? null);
    return conv || shadow ? { conv, shadow } : null;
  }

  /** Into the prompt, at the card it was written to — the ring goes there
   *  first, so the words land in that card's draft rather than whichever one
   *  is in hand. Appended to anything already written there. */
  async function reclaim(o: Orphan) {
    const to = reachable(o);
    if (!o.text || !to) return;
    if (to.conv) onselect(to.conv);
    else if (to.shadow) onremoteselect?.(to.shadow);
    await tick();
    field.put(field.text.trim() ? `${field.text.trimEnd()}\n\n${o.text}` : o.text);
    replies.forget(o.item);
    prompt?.focus();
  }

  async function copyStray(o: Orphan) {
    try {
      await navigator.clipboard.writeText(o.text);
      replies.forget(o.item);
    } catch {
      skein.fault = "could not write to the clipboard — the reply is still kept";
    }
  }

  /** The dock's verbs for the leader (`<space>d`, `leader.ts`), so nothing
   *  here is mouse-only. Answers why it did nothing, for the caller to say. */
  export function chord(act: DockChord): string | null {
    if (act === "next") {
      if (!next) return "nothing else is waiting on you";
      more();
      return null;
    }
    if (!stray) return "no unsent reply is waiting";
    if (act === "reclaim") {
      if (!reachable(stray)) return "the card it was for has gone — copy it or drop it";
      void reclaim(stray);
    } else if (act === "copy") void copyStray(stray);
    else replies.forget(stray.item);
    return null;
  }

  let height = $state(0);
  /* Braced, not an arrow expression: an effect that *returns* a value is an
     effect Svelte reads as handing back a teardown, and `(h) => (dockH = h)`
     answers the number it assigned. */
  $effect(() => {
    onheight(height);
  });

  /* A draft that stops being a shell line is a new question, so the dismissal
     does not outlive it — the same rule the palette's has, for the same reason. */
  $effect(() => {
    if (!isBang(field.text)) field.bangOff = false;
  });

  /* A draft that stops being a command being typed is a new question, so the
     dismissal does not outlive it. Without this, one Escape silenced the
     palette for the rest of the session. Both stages count: dismissing over
     `/model son` must not be undone by the very next keystroke.

     Asked of `slashAt` rather than `typingName` now that a name can sit inside
     a sentence: the question is whether the *caret* is still in one, and moving
     it out of the word you dismissed over is as much a new question as deleting
     the word would be. Read against `field.commandsOff` being what suppresses
     `field.token` — this has to ask the draft directly, or the dismissal would
     hide the very thing that clears it. */
  $effect(() => {
    if (
      slashAt(field.text, field.caret) === null &&
      typingChoice(field.text) === null
    ) {
      field.commandsOff = false;
    }
  });

  /** Where the caret is, off the textarea itself.
   *
   *  Everything the palette's first stage does keys on which word the caret is
   *  in, and there is no one event that reports every way it moves — `input`
   *  covers typing, `keyup` the arrows and Home/End, `click` a pointer landing
   *  mid-word, and `focus` coming back to a draft you left. Four cheap handlers
   *  rather than `selectionchange`, which is engine-dependent and would fail
   *  silently by leaving the palette matching the end of the line.
   *
   *  Never called for a write this app made: those go through `Field.put`,
   *  which puts the caret back to meaning the end of the text. */
  function caretMoved() {
    field.caret = prompt?.selectionStart ?? null;
  }

  /** An edit to the draft, as opposed to the caret merely moving in it.
   *
   *  Both are `oninput`'s business here and they are two different questions,
   *  which is why this is not folded into `caretMoved`: that one is also on
   *  `keyup`, `click` and `focus`, and none of those is you writing anything.
   *
   *  What the edit buys is the card's process. A card at rest no longer gets one
   *  at launch (`rousing.ts`), so the first send of the day would otherwise be a
   *  spawn and a `--resume` waited out with the sentence already typed. Starting
   *  it on the first character spends that second on the time you were using
   *  anyway. Nothing is awaited and no answer is read — `Skein.stir` is a head
   *  start, and `#deliver` still asks for a process and still fails honestly if
   *  there is none.
   *
   *  Two things it is asked about first. A `!` line is a shell command run in
   *  the card's directory by `bang.rs` and reaches no agent at all, so a card
   *  you only ever run commands in stays dormant. And an empty box is a draft
   *  you have just cleared or backspaced out of, which is the opposite of
   *  turning towards the card.
   *
   *  The focused card and not `targets`: a gathering of twenty would otherwise
   *  be twenty spawns off one keystroke, which is the thundering herd
   *  `ROUSE_GAP_MS` exists to avoid. A broadcast wakes each of them in
   *  `#deliver` as it reaches them. */
  function edited() {
    caretMoved();
    if (field.banging || !stirsCard(field.text)) return;
    skein.stir(focused);
  }

  /* An image lives by its token, so backspacing over one detaches it — and that
     has to be true of *typing*, not only of the writes that go through
     `Field.put`. The text is two-way bound to the textarea, so an ordinary
     keystroke never reaches `put` at all: without this, deleting `[shot 1]`
     left the picture in the strip above the field and counted against the cap,
     while `compose` — which asks `stillIn` — would not have sent it. The strip
     and the sentence disagreeing about what is attached is the one state this
     feature must not have.

     `untrack` because `prune` both reads and writes the list; depending on what
     it writes would make the effect re-run itself. It only assigns when
     something actually went, so an ordinary keystroke costs a filter and no
     invalidation. Third effect of this shape here — the two above it drop a
     dismissal that has stopped applying to the draft, and this drops a picture
     that has. */
  $effect(() => {
    const text = field.text;
    untrack(() => field.shots.prune(text));
  });

  /** Is the field drawing its own text, so the chips can be drawn in it?
   *
   *  A shell line already owns the tint layer and the two cannot both have it —
   *  `!` is a different vocabulary over the same box. In practice they never
   *  meet: a `!` line is a command run in a directory and has nothing to do with
   *  a picture, and attaching one to a shell command would be nonsense. This is
   *  what makes that true rather than merely likely. */
  const marked = $derived(!field.banging && field.shots.any);

  /** Take an image out of the prompt.
   *
   *  By editing the sentence, which is the only thing an attachment *is* — see
   *  `attach.ts::dropToken`. `Attachments.prune` then drops it on the next
   *  read, so this needs no second call and the two can never disagree about
   *  what is attached. */
  function detach(name: string) {
    field.put(dropToken(field.text, name));
  }

  /** Whichever of the palette's two stages is up. Bound by both, since they are
   *  the arms of one `if` and never both on screen. */
  let palette = $state<HTMLElement | undefined>(undefined);

  /* The lit row is kept in view, because the palette is now long enough to need
     it: Volery's own nine plus everything the agent answers to came to 66 rows
     on the wall this was written for. It scrolls rather than being cut off at some
     number — a list that silently stops at ten says a card has no skill that it
     does have, which is worse than a list you have to scroll. Found by asking
     the DOM rather than by binding the lit button, because which button is lit
     changes with an index and `bind:this` does not take a condition. */
  $effect(() => {
    field.at;
    field.commands;
    field.choices;
    palette?.querySelector(".cmd.on")?.scrollIntoView({ block: "nearest" });
  });

  /* The lit row goes back to the top when the list under it is replaced, or
     stepping from the names to the values would land on whichever value
     happened to share an index with the command you just picked. */
  const stage = $derived(field.choosing ? `values:${field.choosing.cmd.name}` : "names");
  $effect(() => {
    stage;
    field.at = 0;
  });
</script>

<!-- A question parked on another wall, in the panel a local one uses.
     Held still (`stirs={false}`): no touch travels to that wall, so its
     countdown runs on the question's base window, which only a touch over
     there can lengthen. A question that shows something arrives as words and
     is redrawn from the call's own arguments once they are pulled over
     (`flyway/look.rs`), so its designs and files are drawn exactly as a local
     card's are — scripts included, gated as they are here by what kind of card
     asked. Answering goes back down the prompt wire into the parked call, and the
     line in the card's panel says how far it got — the same four readings a
     prompt to that wall has. -->
{#snippet elsewhereAsk(shadow: Shadow, sheet: PendingAsk)}
  <Ask
    ask={sheet}
    card={shadow.id}
    project="{shadow.project} · on {shadow.host}"
    title={shadow.title}
    scripts={shadow.digest.kind !== "chat"}
    stirs={false}
    elsewhere={shadow.id !== ring}
    onanswer={() => onremoteanswer?.(shadow, sheet)}
    ondefer={() => onremotedefer?.(shadow, sheet)}
    onselect={() => onremoteselect?.(shadow)}
  />
{/snippet}

<!-- A notice standing on another wall, in the panel a local one uses. No
     `onstir`: no touch travels, and a notice holding a turn open over there
     counts its own window. Taking it down goes back down the prompt wire. -->
{#snippet elsewhereNotice(shadow: Shadow, notice: NoticeRow)}
  <Notice
    {notice}
    project="{shadow.project} · on {shadow.host}"
    title={shadow.title}
    elsewhere={shadow.id !== ring}
    onack={() => onremotenotice?.(shadow, notice, "")}
    onfollow={(text) => onremotenotice?.(shadow, notice, text)}
    onselect={() => onremoteselect?.(shadow)}
  />
{/snippet}

<footer
  bind:clientHeight={height}
  class="dock"
  class:dropping
  class:moored-top={berth.site === "top"}
  class:afloat={berth.site === "float"}
  style:width={berth.site === "float" ? `${berth.w}px` : undefined}
  style:left={berth.site === "float" ? `calc(${berth.x}px - var(--span-x, 0px))` : undefined}
  style:top={berth.site === "float" ? `calc(${berth.y}px - var(--span-y, 0px))` : undefined}
>
  <!-- The handle that moves the whole dock: to the top, or off both edges.
       Faint until asked for, in the dock's own padding so it is never over
       anything you are reading. The keyboard path is the chord in the title —
       a chord cannot point at a place, so it cycles the three sites. -->
  <div
    class="moor"
    class:on={grabbing}
    role="presentation"
    title="drag to move the dock — top, bottom, or floating · double-click to put it back (space then w d)"
    onpointerdown={onmoor.down}
    onpointermove={onmoor.move}
    onpointerup={onmoor.up}
    onpointercancel={onmoor.up}
    ondblclick={onmoor.reset}
  ></div>
  <!-- A reply typed to something that went before it was sent. Above the
       panel rather than in it, because the panel has already moved on to the
       next thing, and quiet: it is a thing kept for you, not a fault. -->
  <!-- A reply typed to something that went before it was sent. Above the
       panel rather than in it, because the panel has already moved on to the
       next thing, and quiet: it is a thing kept for you, not a fault. -->
  {#if stray}
    {@const s = stray}
    {@const to = reachable(s)}
    <div class="unsent" role="status">
      <span class="why"
        >not sent — {s.about}{s.why ? `: ${s.why}` : " went before your reply did"}{strays.length > 1
          ? ` · 1 of ${strays.length}`
          : ""}</span
      >
      <span class="words">{s.text}</span>
      {#if to}
        <button
          class="keep"
          onclick={() => void reclaim(s)}
          title="Put it in the prompt, aimed at the card it was written to (space then d p)"
          >to its prompt</button
        >
      {/if}
      <button class="keep" onclick={() => void copyStray(s)} title="Copy it, and let it go (space then d c)"
        >copy</button
      >
      <button class="keep" onclick={() => replies.forget(s.item)} title="Let it go (space then d x)"
        >drop</button
      >
    </div>
  {/if}
  {#if swapped}
    <div class="unsent" role="status"><span class="why">{swapped}</span></div>
  {/if}

  <!-- One branch per kind, and the kind of the thing held never changes, so
       the panel drawing it is never torn down and rebuilt while it is held —
       which is what keeps the caret in the field you are typing in. There used
       to be two branches apiece for the far kinds (ahead of this wall's items
       when their card was in the ring, behind otherwise), and an item moving
       between them was remounted mid-sentence.

       `display: contents`, so the wrapper changes no layout; it is here to
       know whether the caret is in the panel, and to hold the first Enter
       after the held item went from under it (`guardEnter`). A pointer in it
       is you acting, and lets the guard go. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="held"
    bind:this={heldEl}
    onkeydowncapture={guardEnter}
    onpointerdowncapture={() => (swapped = null)}
  >
    {#if shown?.kind === "ask"}
      {@const target = shown.conv}
      {@const sheet = shown.ask}
      <Ask
        ask={sheet}
        card={target.id}
        project={target.project}
        title={target.title}
        scripts={target.kind !== "chat"}
        elsewhere={target.id !== ring}
        onanswer={() => skein.answerAsk(target)}
        ondefer={() => skein.deferAsk(target)}
        onstir={() => skein.stirAsk(target)}
        onheld={() => skein.holdAsk(target)}
        onselect={() => onselect(target)}
      />
    {:else if shown?.kind === "far-ask"}
      {@render elsewhereAsk(shown.shadow, shown.ask)}
    {:else if shown?.kind === "notice"}
      {@const n = shown.notice}
      {@const card = shown.conv}
      <Notice
        notice={n}
        project={card.project}
        title={card.title}
        elsewhere={card.id !== ring}
        onack={() => skein.acknowledgeNotice(n)}
        onfollow={(text) => skein.followUpNotice(n, text)}
        onstir={() => skein.stirNotice(n)}
        onselect={() => onselect(card)}
      />
    {:else if shown?.kind === "far-notice"}
      {@render elsewhereNotice(shown.shadow, shown.notice)}
    {/if}
  </div>
  {#if shown && next}
    <button class="more" onclick={more} title="Step to the next thing waiting (space then d n)">
      {waitingOnYou - 1} more waiting on you
    </button>
  {:else if shown && waitingOnYou > 1}
    <!-- Questions queued behind this card's own, which nothing reaches but
         answering it: a count, not a button that would do nothing. -->
    <span class="behind">{waitingOnYou - 1} more queued behind this one</span>
  {/if}

  <div class="targets">
    {#if targets.length > 1}
      <span class="count bcast">Broadcast to {targets.length}</span>
      {#each targets as t (t.id)}
        <span class="tgt" class:clash={clashing.includes(t.id)}>
          <b>{t.project}</b>
          {nameBesideProject(t.title)}
        </span>
      {/each}
    {:else if focused}
      <span class="count">To</span>
      <span class="tgt"><b>{focused.project}</b> {nameBesideProject(focused.title)}</span>
      <!-- "when you type" and not "on send", which is what this said while the
           rousing queue woke the whole wall and a dormant card was the unusual
           one. It is now the ordinary state of most cards, and the true answer
           moved: `Skein.stir` starts the spawn on the first character, so this
           line is gone by the time the sentence is. Worth being exact about,
           because "on send" reads as a wait you are about to be made to do. -->
      {#if focused.dormant}
        <span class="hint">dormant — wakes when you type</span>
      {/if}
      <!-- Said here as well as on the card, because this is the one place
           where it is about to stop being true: a prompt picks the card back
           up, and a card quietly rejoining the waiting cycle is worth one
           clause of warning rather than a surprise later. -->
      {#if focused.aside}
        <span class="hint">set aside — sending picks it back up</span>
      {/if}
      {#if focused.interrupted}
        <span class="hint warn">last turn was interrupted</span>
      {/if}
    {:else if remote}
      <span class="count">To</span>
      <span class="tgt"><b>{remote.project}</b> {nameBesideProject(remote.title)}</span>
      <!-- Where the words will go, and the limits of what can: a prompt is
           carried to the other wall as text, so this wall's commands, a `!`
           line and pictures stay here. Said up front rather than discovered
           as a refusal flash. -->
      {#if remote.face.unheard}
        <span class="hint warn">on {remote.host}, not heard from — a prompt would be refused</span>
      {:else}
        <span class="hint">on {remote.host} — words only, sent there</span>
      {/if}
    {:else}
      <span class="count dim">No card focused</span>
    {/if}
    <!-- The counterpart of the send below it, and only ever offered while
         there is a turn to end. It names the card when the row above is a
         broadcast readout, because "stop" beside a list of four is a
         question rather than a verb — the key and the button both aim at
         the focused card alone. -->
    {#if focused?.working}
      <button class="stop" onclick={() => skein.stop(focused)}>
        <span class="sq"></span>
        stop{targets.length > 1 ? ` ${focused.project}` : ""}
        <span class="kbd">esc</span>
      </button>
    {/if}
    <span class="grow"></span>
    {#if waiting.length}
      <button class="cycle" onclick={() => oncycle(1)}>
        {waiting.length} waiting <span class="kbd">⇥</span>
      </button>
    {/if}
  </div>
  {#if clashing.length > 1}
    <div class="clashwarn">
      <span>⚠</span>
      <span>
        {clashing.length} of these {targets.length} have edited the same files —
        they'll work on one tree
      </span>
    </div>
  {/if}

  <!-- Above the field, so it grows towards the wall rather than pushing the
       field down under the cursor that is typing into it.

       Two stages, never both: the field.commands, and then — for one that takes a
       fixed set of values — the values. Listed here are Skein's own and the
       handful of the CLI's that this window knows the shape of; everything
       else the agent offers is its business, and there is no way to enumerate
       it from here. -->
  {#if field.choices.length && field.choosing}
    <div
      class="palette"
      role="listbox"
      aria-label="/{field.choosing.cmd.name} values"
      bind:this={palette}
    >
      {#each field.choices as choice, i (choice.value)}
        {@const on = choice === field.choicePick}
        <button
          class="cmd"
          class:on
          role="option"
          aria-selected={on}
          onmousedown={(e) => {
            /* mousedown, not click: the field must not lose focus first, or
               the draft is cleared while the caret is somewhere else. */
            e.preventDefault();
            field.at = i;
            void onsendtext(
              completionForChoice(field.choosing!.cmd, choice),
              targets.length > 1,
            );
          }}
          onmouseenter={() => (field.at = i)}
        >
          <span class="name">{choice.value}</span>
          <span class="summary">{choice.summary}</span>
          <span class="grow"></span>
          {#if targets.length > 1}
            <span class="reach">{targets.length} cards</span>
          {/if}
        </button>
      {/each}
      <p class="detail">{field.choosing.cmd.detail}</p>
    </div>
  {:else if field.commands.length}
    <div class="palette" role="listbox" aria-label="skein field.commands" bind:this={palette}>
      {#each field.commands as cmd, i (cmd.name)}
        {@const on = cmd === field.commandPick}
        <button
          class="cmd"
          class:on
          role="option"
          aria-selected={on}
          onmousedown={(e) => {
            /* mousedown, not click: the field must not lose focus first, or
               the draft is cleared while the caret is somewhere else. */
            e.preventDefault();
            field.at = i;
            void onrun(cmd, targets.length > 1);
          }}
          onmouseenter={() => (field.at = i)}
        >
          <!-- The ellipsis is the menus' own convention for a gesture that
               opens something further rather than doing a thing: this row
               leads to the values, and Enter on it says so by showing them.
               `opens` is the same claim for a command that puts up a panel
               instead — `/resume` offers you the sessions on disk. -->
          <span class="name">/{cmd.name}{cmd.choices || cmd.opens ? "…" : ""}</span>
          <!-- What it takes, in the CLI's own words: `[interval] [prompt]`,
               `<model>`, `branch`. Beside the name rather than in the summary,
               because it is the shape of the line you are about to write and
               not a description of what the thing does. Set in mono for the
               same reason a completion is: it is text that will be typed. -->
          {#if cmd.hint}
            <span class="hint">{cmd.hint}</span>
          {/if}
          <span class="summary">{cmd.summary}</span>
          <span class="grow"></span>
          <!-- A click is the one way in here that does not pass through the
               Ctrl gate, so the row has to say how far it reaches. The
               keyboard path still costs the modifier — and a command that acts
               on no card reaches nothing, so it says nothing: "5 cards" beside
               `/resume` would be a claim about a gathering it will not touch. -->
          {#if targets.length > 1 && cmd.needsCard}
            <span class="reach">{targets.length} cards</span>
          {/if}
        </button>
      {/each}
      {#if field.commandPick}
        <p class="detail">{field.commandPick.detail}</p>
      {/if}
    </div>
  {/if}

  <!-- The `!` line's own two rows, above the field like the palette and for
       the same reason: they grow towards the wall rather than pushing the
       field down under the cursor typing into it.

       Never up at the same time as the palette — one needs a leading slash
       and the other a leading bang — so this is its own block rather than
       another arm of that chain. -->
  {#if field.banging}
    {#if bang.offer}
      <div class="palette bang" role="listbox" aria-label="what the shell offers">
        {#each bang.offer.matches as m, i (m.text + i)}
          {@const on = m === bang.lit}
          <button
            class="cmd"
            class:on
            role="option"
            aria-selected={on}
            onmousedown={(e) => {
              /* mousedown, not click: the field must not lose focus first, or
                 the caret is somewhere else by the time the text lands. */
              e.preventDefault();
              bang.at = i;
              void ontake(bang.offer!, m);
            }}
            onmouseenter={() => (bang.at = i)}
          >
            <span class="name">{m.label}</span>
            <span class="summary">{kindLabel(m.kind)}</span>
            <span class="grow"></span>
          </button>
        {/each}
      </div>
    {/if}
    <!-- Which directory, because that is the whole of what a `!` line needs
         you to know and the one thing the field itself cannot say. It also
         replaces the dock's usual claim about reach: a run is one directory,
         so the target line's "5 cards" would be a lie here. -->
    <p class="bangbar">
      <span class="where">{bangCard ? promptPath(bangCard.cwd, "") : "no card"}</span>
      {#if bangCard?.bangCmd}
        <span class="going">running {bangCard.bangCmd} · esc stops it</span>
      {:else if bang.asking}
        <span class="going">asking the shell…</span>
      {:else}
        <span class="hint">↵ run · ctrl ↵ run and tell the agent · tab completes</span>
      {/if}
    </p>
  {/if}

  <!-- What is attached to the draft. Above the field rather than below it, so
       the pictures sit between the target line and the sentence that refers to
       them — and so the field itself never moves as you type.

       Drawn only when there is something to draw: an empty strip on every card
       all day is a row of chrome saying nothing, and the dock is already four
       stacked things deep. -->
  {#if field.shots.any}
    <div class="shots">
      {#each field.shots.list as a (a.id)}
        <button
          class="shot"
          type="button"
          title="{a.name} — {sizeNote(a)}. Click to take it out of the prompt."
          onclick={() => detach(a.name)}
        >
          <img src={a.thumb} alt="" />
          <span class="what">
            <span class="who">{a.name}</span>
            <span class="how">{sizeNote(a)}</span>
          </span>
          <span class="off" aria-hidden="true">✕</span>
        </button>
      {/each}
    </div>
  {/if}
  <!-- A refusal is said once and where the gesture was made, rather than in the
       fault bar — dropping eighty files on the dock is a thing that happens by
       accident and the answer belongs beside the thing you dropped them on. -->
  {#if field.shots.refused}
    <p class="line refused-shot">{field.shots.refused}</p>
  {/if}

  <div class="field">
    <!-- The highlight is drawn *behind* a transparent textarea, which is why
         both `tokens` and `runsOf` have to concatenate back to exactly what went
         in: one dropped space and every colour on the line sits over the wrong
         character. The `!` is drawn here rather than tokenised, since it is the
         mode marker and not part of the command — and the remainder is passed
         untrimmed, because trimming it would shift everything after a leading
         space.

         `marked` is the same mechanism over the other vocabulary, and it is
         switched on *only* while something is attached. That is deliberate
         rather than lazy: drawing the text underneath means the textarea's own
         glyphs go transparent, which is a real cost — an IME's composition text
         would be invisible while you typed it — and it is a cost worth paying
         only on the drafts that have a chip to show. An ordinary prompt is
         exactly the field it has always been. -->
    <div
      class="ink"
      class:shell={field.banging}
      class:marked={marked}
    >
      {#if field.banging}
        <div class="tint" aria-hidden="true"><span class="t-mark"
            >{BANG}</span
          >{#each tokens(field.text.slice(BANG.length)) as t, i (i)}<span
              class="t-{t.kind}">{t.text}</span
            >{/each}</div>
      {:else if marked}
        <div class="tint" aria-hidden="true">{#each runsOf(field.text, field.shots.list) as r, i (i)}{#if r.chip}<span
                class="chip">{r.text}</span
              >{:else}{r.text}{/if}{/each}</div>
      {/if}
      <textarea
        bind:this={prompt}
        bind:value={field.text}
        onkeydown={onkey}
        oninput={edited}
        onkeyup={caretMoved}
        onclick={caretMoved}
        onfocus={caretMoved}
        placeholder={field.banging
          ? "run a command in this card's directory…"
          : targets.length > 1
            ? `Say something to all ${targets.length}…`
            : focused
              ? "Say something…"
              : remote
                ? `Say something to ${remote.host}…`
                : "Open a conversation first"}
        disabled={targets.length === 0 && !remote}
        spellcheck={!field.banging}
        rows="1"
      ></textarea>
    </div>
    <!-- Keyed on the refusal count so the flash retriggers: a second press
         with the modifier still missing has to be a second answer, and a CSS
         animation on a node that was never replaced runs exactly once. The
         class is what keeps it off the first paint, when nothing has been
         refused yet. -->
    {#key field.refused}
      <span class="key" class:refused={field.refused > 0}
        >{field.banging || targets.length <= 1 ? "↵" : "Ctrl ↵"}</span
      >
    {/key}
  </div>
</footer>

<style>
  .dock {
    /* Above `.studio::after`, the horizon that carries the day's spend. Was one
       arm of a `.bar, .dock, .wall` group in `App.svelte`; a component cannot be
       reached by its parent's selector, so the dock now says it itself. */
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    border-top: 1px solid var(--edge);
    padding: 0.6rem 0.9rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  /* ── the dock's berth ─────────────────────────────────────────────────
     At the top, which is `order` and a mirrored border and nothing else — the
     studio is a column, everything in it is at the default order, and the bar
     is pushed one lower so the dock lands under the title bar rather than over
     it. */
  .dock.moored-top {
    order: -1;
    border-top: 0;
    border-bottom: 1px solid var(--edge);
  }
  /* Off both edges. Window coordinates, so it can be put on a monitor the
     chrome does not live on, and therefore owing `--span-*` like everything
     else placed at viewport coordinates — the studio root is the containing
     block for anything fixed inside it while spread (`span.ts`), and both
     variables are zero when nothing is. Above the wall, which carries its own
     `z-index: 1`, and above the glass inside it: this is chrome you are typing
     into, and the one thing in the window that must never be covered. */
  .dock.afloat {
    position: fixed;
    z-index: 6;
    border: 1px solid var(--edge);
    border-radius: var(--ch-radius, 4px);
    /* Opaque, for the reason nothing standing on the wall may be transparent. */
    background: var(--ink);
    box-shadow: 0 24px 48px -18px rgba(0, 0, 0, 0.9);
  }
  /* The mooring handle: a pill centred on the dock's top edge, inside its own
     padding so it is never over anything you are reading, and faint until the
     pointer is near it — a dock wearing a visible handle all day is a dock with
     a button on it. Centred rather than in a corner because the dock is a line
     rather than a box, and the middle of its top edge is the one part of it
     that holds nothing.

     Mirrors `.moor` in `App.svelte`, which is the panel's. A component is the
     only CSS scope this codebase has, so the two say a similar thing in two
     places rather than sharing a selector neither of them owns. */
  .moor {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 34px;
    height: 10px;
    z-index: 2;
    cursor: grab;
    opacity: 0.25;
    transition: opacity 0.12s ease;
    user-select: none;
    touch-action: none;
  }
  /* The pill, drawn smaller than the thing you can hit — the dock's top
     padding is ten pixels and the handle has to live entirely inside it, so
     the bar is three and the hit area is all of them. */
  .moor::after {
    content: "";
    position: absolute;
    inset: 3px 0;
    border-radius: 2px;
    background: var(--paper-faint);
  }
  .moor:hover,
  .moor.on {
    opacity: 0.8;
  }
  .moor.on {
    cursor: grabbing;
  }
  :global(html[data-motion="still"]) .moor {
    transition: none;
  }

  .targets {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .count {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--paper);
  }
  .count.dim {
    color: var(--paper-faint);
  }
  .tgt {
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.08rem 0.42rem;
    color: var(--paper-dim);
    font-size: 0.69rem;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tgt b {
    color: var(--paper-faint);
    font-weight: 600;
  }
  .hint {
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
  .hint.warn {
    color: var(--st-soft);
  }
  .count.bcast {
    color: var(--st-ask);
  }
  .tgt.clash {
    border-color: color-mix(in srgb, var(--st-ask) 50%, var(--edge));
  }
  .clashwarn {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--st-ask);
  }

  .cycle {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-ask) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-ask);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .cycle:hover {
    background: color-mix(in srgb, var(--st-ask) 12%, transparent);
  }
  /* Celadon, like the card it acts on: this button only exists while something
     is working, so the colour is that status rather than a decoration. */
  .stop {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-work) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-work);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .stop:hover {
    background: color-mix(in srgb, var(--st-work) 12%, transparent);
  }
  /* Drawn, not typed. `■` falls through to Segoe UI Emoji on this machine and
     comes out as somebody else's blue — the same trap the ambience panel's
     layer-order buttons avoid by saying "back" and "front" in words. */
  .stop .sq {
    width: 0.42rem;
    height: 0.42rem;
    background: currentColor;
    border-radius: 1px;
  }

  .more {
    align-self: flex-start;
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 0;
    color: var(--st-ask);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .kbd {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .held {
    display: contents;
  }
  .behind {
    align-self: flex-start;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  /* Achromatic: nothing here is waiting on you or has failed — it is your own
     words, kept. */
  .unsent {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    border: 1px dashed var(--edge);
    border-radius: 4px;
    background: var(--well);
    padding: 0.35rem 0.6rem;
    font-family: var(--util);
    font-size: 0.66rem;
  }
  .unsent .why {
    flex: 0 0 auto;
    color: var(--paper-mute);
  }
  .unsent .words {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--body);
    font-size: 0.8rem;
    color: var(--paper-dim);
  }
  .unsent .keep {
    flex: 0 0 auto;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-mute);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .unsent .keep:hover {
    color: var(--paper);
  }

  /* Achromatic, like the rest of the chrome: colour on this wall is status, and
     a command that has not run yet has none. */
  .palette {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.25rem;
    gap: 1px;
    /* About twelve rows, then it scrolls. The list was nine entries long for
       the whole of this palette's life and is now nine plus every skill the
       card declares — 31 on the wall this was measured on, which unbounded is a
       popup taller than the transcript it covers. Scrolled rather than cut,
       because a list that silently stops says a card has no skill that it does
       have; `Dock`'s effect keeps the lit row in view. */
    max-height: 17rem;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .palette .cmd {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    width: 100%;
    background: none;
    border: 0;
    border-radius: 2px;
    padding: 0.3rem 0.45rem;
    text-align: left;
    cursor: pointer;
    color: var(--paper-dim);
    font-family: var(--util);
    font-size: 0.74rem;
  }
  .palette .cmd.on {
    background: var(--raised);
    color: var(--paper);
  }
  .palette .name {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  /* Faint, and in the mono a completion lands in: this is the shape of what
     you are about to type rather than prose about it. */
  .palette .hint {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .palette .cmd.on .hint {
    color: var(--paper-mute);
  }
  .palette .summary {
    color: var(--paper-mute);
  }
  .palette .grow {
    flex: 1 1 auto;
  }
  .palette .reach {
    color: var(--paper-mute);
    font-size: 0.68rem;
  }
  .palette .cmd.on .summary {
    color: var(--paper-dim);
  }
  /* One line about the lit entry, since a summary short enough to scan cannot
     also say what will be lost.

     Stuck to the bottom of the box now that the box scrolls: it describes
     whichever row is lit, which is a row you are looking at, so it must not
     scroll out of sight along with the rows you are not. Opaque for the same
     reason — the entries pass underneath it. */
  .palette .detail {
    position: sticky;
    bottom: -0.25rem;
    margin: 0.15rem 0 -0.25rem;
    padding: 0.3rem 0.45rem 0.25rem;
    border-top: 1px solid var(--edge);
    background: var(--surface);
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.7rem;
  }

  .field {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
  }
  /* ── the `!` line ────────────────────────────────────────────────────────
     The field holds two things in the same box: a textarea whose text is
     transparent, and the coloured copy of it underneath. */
  .ink {
    position: relative;
    flex: 1 1 auto;
    display: flex;
  }
  /* Named for what it does rather than for how it looks, and deliberately not
     `.ghost` — that is this stylesheet's chrome-button class, one bare rule of
     it sits further up, and a second bare `.ghost` here won on being later in
     the file. Every button in the header took `position: absolute; inset: 0;
     pointer-events: none` and collapsed into one unclickable stack. */
  .tint {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: hidden;
  }
  /* Both halves get the same metrics, or the colours drift off the characters as
     the line grows. */
  .ink.shell textarea,
  .ink.shell .tint {
    font-family: var(--mono);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .ink.shell textarea {
    /* The caret stays, which is the whole trick: the text is drawn once,
       underneath, and this is only where it is typed. */
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.shell textarea::selection {
    /* Transparent text with an ordinary selection is an invisible highlight, so
       the selection has to be something you can see against the ghost. */
    background: var(--edge);
  }

  /* ── an image written into the prompt ────────────────────────────────────
     The same trick as the `!` line one box over: the text is drawn once
     underneath and the textarea is only where it is typed. Both halves take the
     *same* metrics — the field's own, not the mono the shell line uses — or the
     chips drift off the characters they are meant to be sitting on. */
  .ink.marked textarea,
  .ink.marked .tint {
    font-family: var(--body);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .ink.marked textarea {
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.marked textarea::selection {
    background: var(--edge);
  }
  .ink.marked .tint {
    color: var(--paper);
  }
  /* A chip is the *same glyphs* with a background behind them, and that is the
     whole reason this works: anything that changed the token's width — padding,
     a different face, a border — would move every character after it out from
     under the caret. So it is colour and a radius and nothing else, and the
     background is drawn with `box-decoration-break` so a token that wraps
     across two lines gets a rounded end on each rather than one box spanning
     the gap. Achromatic: colour on this wall means status, and a picture you
     attached is not one. */
  .chip {
    background: var(--edge);
    color: var(--paper);
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  /* ── the strip of what is attached ───────────────────────────────────────── */
  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
  }
  .shot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.3rem 0.2rem 0.2rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--paper-mute);
  }
  .shot:hover {
    border-color: var(--paper-faint);
    color: var(--paper);
  }
  .shot img {
    /* A fixed box with the picture covering it, so a wide screenshot and a tall
       one make the same shape and the strip does not go ragged. */
    width: 2rem;
    height: 2rem;
    object-fit: cover;
    border-radius: 2px;
    /* Nothing standing on this wall may be transparent, and a PNG with an alpha
       corner drawn straight onto the dock would show the ambience through the
       middle of a thumbnail. */
    background: var(--surface);
  }
  .shot .what {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .shot .who {
    font-size: 0.72rem;
  }
  .shot .how {
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .shot .off {
    font-size: 0.7rem;
    color: var(--paper-faint);
    padding-left: 0.1rem;
  }
  .shot:hover .off {
    color: var(--paper);
  }
  .refused-shot {
    color: var(--paper-mute);
  }

  /* A drag is overhead and would land here. An outline rather than a fill: the
     dock is where you are about to read a sentence, and washing it over hides
     the very draft the picture is about to be written into. Achromatic — the
     four colours on this wall are the three statuses and the shell line, and a
     drop is none of them. */
  .dock.dropping {
    outline: 1px dashed var(--paper-faint);
    outline-offset: -3px;
  }

  /* Colour on a shell line, which is the one place on this wall it is not
     status. The exemption is `ansi.ts`'s, already taken and for the same reason:
     a terminal register reads by hue — that is how every shell on earth is read
     — and these are the same warm-neutral takes on the standard 16 that the
     console panel renders output with, so a `!` line looks like it belongs on an
     ink wall rather than in somebody else's editor. Amber is deliberately absent:
     it means "wants you" here, and nothing in a line you are typing does. */
  .t-mark {
    color: var(--paper-mute);
  }
  .t-cmd {
    color: var(--paper);
    font-weight: 600;
  }
  .t-param {
    color: #9bb8d8;
  }
  .t-str {
    color: #9bd4bf;
  }
  .t-var {
    color: #c4a8d8;
  }
  .t-num {
    color: #8fd0d0;
  }
  .t-op {
    color: var(--paper-mute);
  }
  .t-comment {
    color: var(--paper-faint);
    font-style: italic;
  }
  .t-plain {
    color: var(--paper-dim);
  }

  /* Where it will run, and what the keys do. The register of a meta note — this
     is the dock talking about itself rather than anything an agent said. */
  .bangbar {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.35rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  .bangbar .where {
    font-family: var(--mono);
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Celadon, because a run is working and that is what celadon means here. */
  .bangbar .going {
    color: var(--st-work);
  }
  .bangbar .hint {
    margin-left: auto;
    white-space: nowrap;
  }
  /* The offering reuses the palette's rows — it is the same gesture over a
     different vocabulary — and only the leading column differs: a completion is
     a thing you are about to type, so it is set in the mono it will land in. */
  .palette.bang .name {
    font-family: var(--mono);
  }

  .field textarea {
    flex: 1 1 auto;
    background: none;
    border: 0;
    resize: none;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.9rem;
    line-height: 1.45;
    max-height: 7rem;
    field-sizing: content;
  }
  .field textarea:focus {
    outline: none;
  }
  .field textarea::placeholder {
    color: var(--paper-faint);
  }
  .key {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0.32rem;
  }

  /* The answer to a press that wanted a modifier it did not have. It points at
     the reading rather than replacing it — the words already say `Ctrl ↵`, and
     what was missing was any acknowledgement that the key had been pressed at
     all. Achromatic, like the rest of the chrome: colour on this wall is
     reserved for status, and a keystroke is not a status. */
  .key.refused {
    animation: refused 0.5s ease-out 2;
  }

  @keyframes refused {
    0% {
      color: var(--paper-faint);
      border-color: var(--edge);
    }
    18% {
      color: var(--paper);
      border-color: var(--paper-mute);
    }
    100% {
      color: var(--paper-faint);
      border-color: var(--edge);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    /* Still an answer, just not a moving one. */
    .key.refused {
      animation: none;
      color: var(--paper);
      border-color: var(--paper-mute);
    }
  }

  /* The dock's own spacer. `App.svelte` has one too — the same three
     declarations under the same name, and deliberately not shared: a rule this
     small is cheaper duplicated than it is coupled, and one stylesheet reaching
     into another is exactly what this component was cut out to stop. */
  .grow {
    flex: 1 1 auto;
  }

</style>
