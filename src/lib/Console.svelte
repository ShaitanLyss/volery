<script lang="ts">
  import { tick } from "svelte";
  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import { stickToTail, snapToTail } from "./follow";
  import type { Shell } from "./shell.svelte";

  let { shell }: { shell: Shell } = $props();

  let draft = $state("");
  let field: HTMLInputElement | undefined = $state();
  let scroller: HTMLDivElement | undefined = $state();

  /* Following the tail — as against having scrolled back to read something —
     is `stickToTail` on the scroller below and nothing here. A console that
     yanks you to the bottom every time a build prints a line is one you cannot
     read a build in; one that has to be scrolled to see what it just said is
     one you cannot watch a build in. It used to measure its own slack against
     24px, which was the same judgement without the correction for its own
     writes: a burst of output landing in the beat before the scroll event
     arrived read as a hand on the wheel and the console quietly stopped
     following. See follow.ts.

     Opening puts the caret in the field: the panel exists to be typed into, and
     there is nothing else in it to click. */
  $effect(() => {
    if (shell.open) void tick().then(() => field?.focus());
  });

  async function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = draft;
      draft = "";
      await shell.send(text);
      /* Asked for, not printed: you want to watch what this one does even if you
         had scrolled back to read what the last one did. */
      snapToTail(scroller);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      shell.hide();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.altKey) {
      /* The field is one line, so there is no caret movement to take away —
         which is what makes bare arrows the history here and not in the draft
         on the wall. */
      const line = shell.step(e.key === "ArrowUp" ? -1 : 1, draft);
      if (line === null) return;
      e.preventDefault();
      draft = line;
      void tick().then(() => field?.setSelectionRange(draft.length, draft.length));
      return;
    }
    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      shell.clear();
      return;
    }
    if (e.key === "c" && e.ctrlKey && !field?.selectionStart) {
      /* Only when there is nothing selected to copy — the other thing ctrl+C
         means in a console, and the one people reach for by reflex. */
      if (field && field.selectionEnd !== field.selectionStart) return;
      e.preventDefault();
      void shell.stop();
    }
  }
</script>

<!-- No scrim, deliberately. This floats *over* the wall rather than instead of
     it: the reason to open a shell beside a card is usually the card, and a
     panel that greys out everything you were reading has taken that away.
     Nothing behind it is blocked either — the wall stays clickable, and Alt+I
     is what puts the panel away. -->
<div class="pane" role="dialog" aria-label="shell">
  <header>
    <span class="mark">shell</span>
    {#if shell.program}<span class="prog">{shell.program}</span>{/if}
    <span class="path" title={shell.cwd}>{shell.where}</span>
    {#if shell.busy}<span class="run" title="running">working</span>{/if}
    <span class="grow"></span>
    <!-- One shell per project means a build can be running in a project you are
         not looking at, and the panel used to *be* every shell there was. So it
         says how many others are alive; the title names them, since the count
         alone would only tell you to go looking. -->
    {#if shell.others.length}
      <span
        class="others"
        title={shell.others
          .map((o) => `${o.where}${o.busy ? " — working" : ""}`)
          .join("\n")}>{shell.others.length} more</span
      >
    {/if}
    {#if shell.live}
      <button
        class="ghost"
        onclick={() => shell.stop()}
        title="Kill what is running and open a fresh shell here — these children have no console, so there is no ctrl+C to send them"
        >stop</button
      >
    {/if}
    <button class="ghost" onclick={() => shell.clear()} title="Clear the scrollback (ctrl+L)"
      >clear</button
    >
    <button class="x" onclick={() => shell.hide()} title="Put it away (alt+I) — the shell keeps running">✕</button>
  </header>

  <div class="out" bind:this={scroller} {@attach stickToTail}>
    {#if !shell.lines.length}
      <p class="empty">
        {shell.busy
          ? "starting — the shell is reading your profile"
          : "nothing yet"}
      </p>
    {/if}
    {#each shell.lines as l, i (i)}
      {#if l.kind === "you"}
        <div class="ln you" class:failed={l.failed}><span class="caret">❯</span>{l.text}</div>
      {:else if l.kind === "note"}
        <div class="ln note">{l.text}</div>
      {:else}
        <div class="ln" class:err={l.kind === "err"}>{#each parseAnsi(l.text) as s}<span
              style:color={s.color === null ? null : ANSI_PALETTE[s.color]}
              style:font-weight={s.bold ? "600" : null}
              style:opacity={s.dim ? 0.6 : null}>{s.text}</span
            >{/each}</div>
      {/if}
    {/each}
  </div>

  <footer>
    <span class="prompt">{shell.where}<span class="caret">❯</span></span>
    <input
      bind:this={field}
      bind:value={draft}
      onkeydown={onKey}
      spellcheck="false"
      autocomplete="off"
      placeholder={shell.live ? "" : "enter starts a shell"}
    />
  </footer>
</div>

<style>
  /* Middle of the window, over the wall. Fixed rather than placed on the
     canvas: this is a piece of window chrome you summon, not a thing that
     stands in the studio and can be panned away from. */
  .pane {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: min(118ch, 84cqw);
    height: min(62cqh, 620px);
    border: 1px solid var(--rule);
    border-radius: 5px;
    /* Opaque, like everything else standing on this wall — the backdrop draws
       behind the whole app, and a leaf drifting through a console would be the
       same bug a dormant card once had. */
    background: var(--surface);
    box-shadow: 0 30px 90px -28px rgba(0, 0, 0, 0.95);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem 0.4rem 0.6rem;
    border-bottom: 1px solid var(--edge);
    background: var(--raised);
    flex: 0 0 auto;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .prog {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-dim);
  }
  .path {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Celadon, because it is the same fact the cards state in it: something is
     working. Colour is status here and nothing else. */
  .run {
    font-family: var(--util);
    font-size: 0.63rem;
    color: var(--st-work);
  }
  .grow {
    flex: 1 1 auto;
  }
  /* Achromatic: how many shells exist is chrome, not status. The one of them
     that is a status — something working — is said on the active shell alone,
     in celadon, as everywhere else. */
  .others {
    font-family: var(--util);
    font-size: 0.63rem;
    color: var(--paper-faint);
  }

  .ghost {
    font-family: var(--util);
    font-size: 0.66rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.1rem 0.38rem;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0 0.15rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .out {
    flex: 1 1 auto;
    overflow-y: auto;
    background: var(--ink);
    padding: 0.5rem 0.65rem;
    font-family: var(--mono);
    font-size: 0.71rem;
    line-height: 1.5;
    color: var(--paper-dim);
  }
  .ln {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ln.err {
    color: var(--st-fail);
  }
  .ln.note {
    color: var(--paper-faint);
  }
  .ln.you {
    color: var(--paper);
    margin-top: 0.3rem;
  }
  /* The command is marked, not its output: which line failed is a question you
     ask having scrolled past a screenful of what it printed. */
  .ln.you.failed .caret {
    color: var(--st-fail);
  }
  .caret {
    color: var(--paper-faint);
    margin-right: 0.5ch;
  }
  .empty {
    margin: 0;
    color: var(--paper-faint);
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex: 0 0 auto;
    border-top: 1px solid var(--edge);
    padding: 0.35rem 0.6rem 0.4rem;
    background: var(--surface);
  }
  .prompt {
    font-family: var(--mono);
    font-size: 0.71rem;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  footer input {
    flex: 1 1 auto;
    background: none;
    border: none;
    outline: none;
    font-family: var(--mono);
    font-size: 0.71rem;
    color: var(--paper);
    padding: 0;
  }
  footer input::placeholder {
    color: var(--paper-faint);
  }
</style>
