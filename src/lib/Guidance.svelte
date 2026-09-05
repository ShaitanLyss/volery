<script lang="ts">
  /* Standing instructions: what you tell every card once instead of every turn.
   *
   * The subsystem's reasoning lives in `src-tauri/src/guidance.rs` — why this
   * reaches the agent as a system prompt rather than a `CLAUDE.md` or a hook,
   * and why a card already running does not hear an edit. `guidance.ts` has the
   * arithmetic. This file is the face, and it makes three judgements of its own.
   *
   * **One panel, every scope.** The wall and each territory are the same kind of
   * thing said at different reaches, and two panels would mean two places to
   * look when an instruction surprises you. The rail on the left is the list of
   * reaches; the column on the right is whichever you are writing.
   *
   * **Drafts survive switching.** A textarea whose contents vanish because you
   * clicked another row to check what it said is a textarea you stop typing
   * long things into. So `drafts` holds one per scope, the rail marks the ones
   * with unsaved work, and nothing is discarded without being asked.
   *
   * **The lock is drawn as a lock, not as another box.** A territory can also be
   * set read-only, and that is the same thought at the same scope — so it is in
   * this panel rather than a second one. But it is not the same *kind* of thing:
   * the box asks, the switch refuses the tools (`hooks::settings`). Drawn as a
   * bar above the box with a real state, its own frame and a sentence naming
   * what it takes away, because the one way to get this wrong is to leave
   * somebody believing prose is enforcement — which is what it was until sink
   * `8dde1cc1`.
   *
   * **It says when an edit takes effect.** This is the one thing about the
   * feature that will otherwise be discovered as a bug: you write "keep answers
   * short", the card you are looking at goes on writing long ones, and there is
   * nothing on screen to say the text was fixed when its process started. The
   * note says so, and the foot says so again against the count of cards it is
   * currently true of. */

  import { untrack } from "svelte";

  import type { Project, Skein } from "./skein.svelte";
  import { changed, gist, LIMIT, lockGist, room, set, tidy } from "./guidance";

  let {
    skein,
    focus = null,
    onclose,
  }: {
    skein: Skein;
    /** Which territory to open on, when the panel was reached from one. `null`
     *  opens on the wall, which is the answer for the header button. */
    focus?: string | null;
    onclose: () => void;
  } = $props();

  /** `null` is the wall; anything else is a project id. The same shape the
   *  store speaks, so nothing has to be translated on the way out.
   *
   *  `untrack` because `focus` is where to *open*, read once, and the panel is
   *  mounted fresh every time it is opened — App.svelte's `{#if guiding}` is
   *  the lifetime. Without it this reads as a subscription that would yank the
   *  rail out from under you mid-edit if the prop ever changed. */
  let scope = $state<string | null>(untrack(() => focus));

  /** Unsaved text, per scope, keyed by `scope`'s value stringified — `Map` with
   *  a `null` key works, but a plain record keyed by `"wall"` reads at a glance
   *  in a debugger and there is no third kind of scope coming. */
  let drafts = $state<Record<string, string>>({});

  let said = $state<string | null>(null);
  let fault = $state<string | null>(null);
  /** Escape with unsaved work asks once. The same one-press-arms shape the
   *  theme panel's destructive buttons use. */
  let armed = $state(false);
  let saving = $state(false);
  let box = $state<HTMLTextAreaElement | undefined>();

  const key = (s: string | null) => s ?? "wall";

  /** Territories, by name, so the list does not reorder itself as projects are
   *  opened. The wall is drawn above them and is not in here. */
  const territories = $derived(
    [...skein.projects].sort((a, b) => a.name.localeCompare(b.name)),
  );

  const storedOf = (s: string | null): string =>
    s === null ? skein.guidance : (skein.projects.find((p) => p.id === s)?.instructions ?? "");

  /** What is in the box: the draft if one has been started, otherwise what is
   *  stored. `??` rather than `||`, so a draft that has been emptied on purpose
   *  — which is how you take an instruction back — is not read as no draft. */
  const draft = $derived(drafts[key(scope)] ?? storedOf(scope));
  const stored = $derived(storedOf(scope));
  const dirty = $derived(changed(draft, stored));
  const left = $derived(room(draft));

  /** Every scope with unsaved work, so the rail can mark them and Escape knows
   *  whether it has anything to ask about. */
  const unsaved = $derived(
    Object.keys(drafts).filter((k) =>
      changed(drafts[k], k === "wall" ? skein.guidance : storedOf(k)),
    ),
  );

  const nameOf = (s: string | null) =>
    s === null ? "the wall" : (skein.projects.find((p) => p.id === s)?.name ?? "this project");

  /** Cards whose process is already running, and which therefore will not hear
   *  this edit until they next start one. The honest number to put next to the
   *  save, and it is only ever a reason to know — nothing here restarts one. */
  const running = $derived(skein.convs.filter((c) => !c.dormant).length);

  function pick(s: string | null) {
    scope = s;
    said = null;
    fault = null;
    armed = false;
    /* Focus follows the pick, because the rail is a way to get to a box rather
       than a thing to look at. Deferred a frame: the textarea is keyed on the
       scope, so the one being focused does not exist yet. */
    queueMicrotask(() => box?.focus());
  }

  function edit(text: string) {
    drafts = { ...drafts, [key(scope)]: text };
    said = null;
    armed = false;
  }

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    fault = null;
    const at = scope;
    const text = tidy(draft);
    try {
      if (at === null) await skein.setGuidance(text);
      else await skein.setProjectGuidance(at, text);
      /* The draft is dropped rather than set to what was stored, so the box
         falls back to the store and the two cannot disagree afterwards. */
      const next = { ...drafts };
      delete next[key(at)];
      drafts = next;
      said = running
        ? `saved — ${running} card${running === 1 ? "" : "s"} already running won't hear it until it next starts`
        : "saved";
    } catch (err) {
      fault = String(err);
    } finally {
      saving = false;
    }
  }

  /** Put the box back to what is stored. The way out of an edit you did not
   *  mean, and the only way to see what is stored once you have typed over it. */
  function revert() {
    const next = { ...drafts };
    delete next[key(scope)];
    drafts = next;
    said = null;
    armed = false;
  }

  function leave() {
    if (unsaved.length && !armed) {
      armed = true;
      said = `${unsaved.length === 1 ? nameOf(unsaved[0] === "wall" ? null : unsaved[0]) : `${unsaved.length} of these`} has unsaved edits — escape again to discard`;
      return;
    }
    onclose();
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      leave();
    }
    /* Ctrl+Enter saves, because this is a box you write paragraphs in and Enter
       has to stay a newline. The same bargain the dock strikes one panel over. */
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  }

  const marked = (p: Project) => set(drafts[p.id] ?? p.instructions);

  /** The territory being written, when one is — the switch has no meaning at the
   *  wall's scope, since the wall is not a repository anything is locked to. */
  const territory = $derived(
    scope === null ? null : (skein.projects.find((p) => p.id === scope) ?? null),
  );

  /** Its own in-flight flag rather than `saving`, so a slow lock does not grey
   *  out the save button beside it and read as the panel having seized. */
  let locking = $state(false);

  async function toggleLock() {
    const p = territory;
    if (!p || locking) return;
    locking = true;
    fault = null;
    try {
      await skein.setProjectReadOnly(p.id, !p.readOnly);
      /* Said in the same place a save is said, and with the same honesty about
         when it lands: the deny is in the settings layer a card's process was
         handed at spawn, so a running card keeps the state it started with. */
      said = !p.readOnly
        ? running
          ? `locked — ${running} card${running === 1 ? "" : "s"} already running keep their tools until they next start`
          : "locked"
        : "unlocked";
    } catch (err) {
      fault = String(err);
    } finally {
      locking = false;
    }
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="scrim" onmousedown={leave} role="presentation">
  <div
    class="panel"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="standing instructions"
    tabindex="-1"
  >
    <div class="head">
      <span class="mark">instructions</span>
      <span class="grow"></span>
      <span class="hint">ctrl+enter saves</span>
      <button class="x" onclick={leave} title="close">✕</button>
    </div>

    <p class="note">
      What you'd otherwise say at the top of every conversation. The wall's reach every card;
      a territory's reach the cards standing in it, and <b>win where the two disagree</b>. They
      are handed over as part of the agent's system prompt, so a card that is already running
      keeps the ones it started with until it next starts a process.
    </p>

    <div class="body">
      <div class="rail">
        <button class="reach" class:on={scope === null} onclick={() => pick(null)}>
          <span class="who">the wall</span>
          <span class="says">
            {#if unsaved.includes("wall")}<i class="edited">edited</i>{/if}
            {gist(drafts.wall ?? skein.guidance, 34) || "—"}
          </span>
        </button>

        <div class="rule"></div>

        {#each territories as p (p.id)}
          <button class="reach" class:on={scope === p.id} onclick={() => pick(p.id)}>
            <span class="who" class:quiet={!marked(p)}>{p.name}</span>
            <span class="says">
              {#if unsaved.includes(p.id)}<i class="edited">edited</i>{/if}
              {gist(drafts[p.id] ?? p.instructions, 34) || "—"}
            </span>
          </button>
        {/each}

        {#if !territories.length}
          <p class="none">No territories on this wall yet — open a folder and one appears here.</p>
        {/if}
      </div>

      <div class="write">
        {#if territory}
          <div class="lock" class:shut={territory.readOnly}>
            <button
              class="switch"
              role="switch"
              aria-checked={territory.readOnly}
              disabled={locking}
              onclick={toggleLock}
            >
              <span class="pip" aria-hidden="true">{territory.readOnly ? "▪" : ""}</span>
              <span class="what">read-only</span>
            </button>
            <span class="why">{lockGist(territory.name, territory.readOnly)}</span>
          </div>
        {/if}

        <label class="cap" for="guidance-box">
          {scope === null
            ? "Told to every card on this wall"
            : `Told to every card in ${nameOf(scope)}`}
        </label>
        {#key key(scope)}
          <textarea
            id="guidance-box"
            bind:this={box}
            class="box"
            spellcheck="true"
            value={draft}
            oninput={(e) => edit(e.currentTarget.value)}
            placeholder={scope === null
              ? "my name is Lyss. I have ADHD — lead with the answer, keep it short, and say plainly when something is unfinished."
              : "this repository is read-only to you: read and explain, don't edit or commit."}
          ></textarea>
        {/key}
      </div>
    </div>

    <div class="foot">
      <button class="act" onclick={save} disabled={!dirty || saving}>
        {saving ? "saving…" : "save"}
      </button>
      <button class="act" onclick={revert} disabled={!dirty}>revert</button>
      <span class="grow"></span>
      {#if fault}
        <span class="fault">{fault}</span>
      {:else if said}
        <span class="said">{said}</span>
      {/if}
      <span class="count" class:full={left === 0}>{left} left of {LIMIT}</span>
    </div>
  </div>
</div>

<style>
  /* The switch reads as a thing with a state, where the box below reads as a
     thing you write in — same panel, two kinds of gesture. Achromatic, per the
     house rule: `shut` is a heavier frame and a filled pip, never a colour,
     because colour on this wall means a card's status and nothing else. */
  .lock {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.4rem 0.55rem;
  }

  .lock.shut {
    border-color: color-mix(in srgb, var(--ink) 45%, transparent);
    background: color-mix(in srgb, var(--ink) 4%, transparent);
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex: none;
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .switch:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .pip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 0.9rem;
    height: 0.9rem;
    border: 1px solid color-mix(in srgb, var(--ink) 45%, transparent);
    border-radius: 2px;
    font-size: 0.6rem;
    line-height: 1;
  }

  .lock.shut .pip {
    border-color: var(--ink);
  }

  .what {
    font-size: 0.8rem;
    letter-spacing: 0.02em;
  }

  .lock.shut .what {
    font-weight: 600;
  }

  .why {
    font-size: 0.74rem;
    line-height: 1.35;
    opacity: 0.68;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: min(84ch, 94vw);
    height: min(38rem, 84vh);
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.6rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .grow {
    flex: 1 1 auto;
  }
  .hint {
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-mute);
    max-width: 78ch;
  }
  .note b {
    color: var(--paper-dim);
    font-weight: 600;
  }

  /* The rail stays put while the box scrolls, the arrangement the theme panel
     uses for the same reason: switching reach is the gesture you repeat, and it
     must not move under you because one territory's instructions are longer. */
  .body {
    display: grid;
    grid-template-columns: 22ch 1fr;
    gap: 0.7rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    overflow-y: auto;
    padding-right: 0.3rem;
    border-right: 1px solid var(--edge);
  }
  .rule {
    height: 1px;
    background: var(--edge);
    margin: 0.3rem 0.2rem;
    flex: 0 0 auto;
  }

  .reach {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.05rem;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0.28rem 0.4rem;
    text-align: left;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .reach:hover {
    border-color: var(--edge);
  }
  .reach.on {
    background: var(--raised);
    border-color: var(--rule);
  }
  .who {
    font-family: var(--body);
    font-size: 0.8rem;
    color: var(--paper-dim);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reach.on .who {
    color: var(--paper);
  }
  /* A territory with nothing set is drawn back, so the ones that are saying
     something to their cards are the ones your eye lands on. */
  .who.quiet {
    color: var(--paper-faint);
  }
  .says {
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edited {
    font-style: normal;
    color: var(--st-work);
    margin-right: 0.3rem;
  }
  .none {
    margin: 0.4rem 0.3rem;
    font-family: var(--util);
    font-size: 0.65rem;
    line-height: 1.4;
    color: var(--paper-faint);
  }

  .write {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-height: 0;
  }
  .cap {
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-mute);
  }
  .box {
    flex: 1 1 auto;
    resize: none;
    min-height: 0;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.82rem;
    line-height: 1.55;
    padding: 0.45rem 0.55rem;
  }
  .box:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .box::placeholder {
    color: var(--paper-faint);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.5rem;
    flex: 0 0 auto;
  }
  .act {
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.24rem 0.55rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-dim);
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .act:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .said {
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--paper-mute);
  }
  .fault {
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--st-fail);
  }
  .count {
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    margin-left: 0.5rem;
  }
  .count.full {
    color: var(--st-ask);
  }
</style>
