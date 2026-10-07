<script lang="ts">
  /* Leaving something in the sink without going and finding the sink.
   *
   * The Basin is a *widget* — something you hang on the wall and read the pile
   * from. That is the right shape for working the pile and the wrong one for the
   * gesture this exists for: you are in the middle of something else, you have
   * just noticed a thing, and the whole value of writing it down is that it
   * costs you nothing to do and nothing to go back to. A widget you have to find
   * first is a widget you do not use at the moment it would have helped.
   *
   * So: `<space>s`, type, enter. See `.claude/rules/sink.md` for what the pile
   * is for, and `leader.ts` for why this is one letter rather than a family.
   *
   * ## A title alone is enough, and the body is left empty rather than faked
   *
   * `sink.ts::refusal` argues that an item with no body is "a thing nobody will
   * be able to act on in a month", and it is right about a *finished* item —
   * it still governs the edit surface. It is the wrong bar for capture: the
   * cost of refusing a one-line note is the note never being written, which is
   * worse than a thin one. Lyss decided this; the friction was mine to propose
   * and not to keep.
   *
   * What this does **not** do is the Basin's trick of copying the title into
   * the body when the body is empty. That satisfies `refusal` by writing the
   * same sentence twice, so the pile reads as though somebody wrote a body when
   * nobody did. An empty body is the truthful record, and it is what lets the
   * item be told apart later from one that was actually filled in.
   *
   * ## Wall-wide, like the Basin's
   *
   * Something you write by hand is not standing in any one project — you are.
   * That is the Basin's reasoning and it is right; the scope is not offered here
   * for the same reason it is not offered there, rather than being an omission.
   */
  import { KINDS, type Edit, type Kind } from "./sink";
  import type { Sink } from "./sink.svelte";

  let { sink, onclose }: { sink: Sink; onclose: () => void } = $props();

  let title = $state("");
  let body = $state("");
  let kind = $state<Kind>("note");
  let busy = $state(false);
  let fault = $state("");

  const edit = $derived<Edit>({ title: title.trim(), body: body.trim(), kind, paths: [] });
  /* The one thing an item cannot be without. `sink_add` refuses an empty title
     too, so this is the same bar said early rather than a second opinion. */
  const why = $derived(edit.title ? null : "an item needs a title");

  async function put() {
    if (busy || why) return;
    busy = true;
    fault = "";
    try {
      await sink.add(edit.title, edit.body, kind, [], null);
      onclose();
    } catch (e) {
      fault = String(e);
      busy = false;
    }
  }

  /* Enter drops from the title, because a title you have finished typing is a
     thing you want to get out of your hands. In the body it is a newline — a
     body is prose and the one field here anybody writes two lines in — so that
     one takes the modifier. */
  const onTitleKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void put();
    }
  };
  const onBodyKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void put();
    }
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="drop"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="leave something in the sink"
    tabindex="-1"
  >
    <h2>leave something in the sink</h2>
    <p class="aside">
      Something you noticed and are not stopping for. It outlives this card and every card —
      write it for somebody with none of your context.
    </p>

    <!-- Four buttons rather than a dropdown, which is the Basin's call and the
         right one: there are four, and a dropdown hides three behind a click.
         Achromatic, per the house rule that colour is status. -->
    <div class="kinds">
      {#each KINDS as k (k)}
        <button
          class="kind"
          class:on={kind === k}
          onclick={() => (kind = k)}
          title="file it as {k}"
        >
          {k}
        </button>
      {/each}
    </div>

    <input
      class="title"
      bind:value={title}
      placeholder="the thing itself, in one line"
      spellcheck="false"
      onkeydown={onTitleKey}
      {@attach (el: HTMLInputElement) => el.focus()}
    />
    <textarea
      class="body"
      bind:value={body}
      placeholder="what somebody picking this up needs — where, what you saw, how they would know it was fixed"
      onkeydown={onBodyKey}
    ></textarea>

    <div class="foot">
      <!-- The refusal is shown rather than the button merely being dead: a
           control that does nothing and says nothing teaches you to distrust
           the ones that work. -->
      <span class="why"
        >{fault || why || (edit.body ? "enter to drop it in" : "a body is worth it, but enter will do")}</span
      >
      <div class="pair">
        <button class="act" onclick={onclose}>never mind</button>
        <button class="act go" disabled={busy || !!why} onclick={put}>drop it in</button>
      </div>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    /* The studio root is the containing block for anything fixed while the wall
       is spread, so a full-window catcher is sized off the span rather than
       `inset: 0`. See CLAUDE.md on `--span-*`. */
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    right: calc(-1 * var(--span-r, 0px));
    background: var(--scrim);
    display: grid;
    place-items: center;
    z-index: 90;
  }
  .drop {
    width: min(42rem, 90cqw);
    max-height: 80cqh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1.1rem 1.3rem 1rem;
    background: var(--paper-bg, var(--surface));
    border: 1px solid var(--edge);
    border-radius: 6px;
  }
  h2 {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .aside {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .kinds {
    display: flex;
    gap: 0.3rem;
  }
  .kind {
    font-family: var(--util);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--edge);
    border-radius: 999px;
    background: transparent;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .kind:hover {
    color: var(--paper-mute);
  }
  .kind.on {
    color: var(--paper);
    border-color: var(--paper-mute);
    background: var(--well);
  }
  .title,
  .body {
    font-family: inherit;
    font-size: 0.82rem;
    color: var(--paper);
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
  }
  .title:focus,
  .body:focus {
    outline: none;
    border-color: var(--paper-mute);
  }
  .body {
    min-height: 7rem;
    resize: vertical;
    line-height: 1.5;
  }
  .title::placeholder,
  .body::placeholder {
    color: var(--paper-faint);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
  }
  .why {
    font-size: 0.7rem;
    color: var(--paper-faint);
    line-height: 1.4;
  }
  .pair {
    display: flex;
    gap: 0.4rem;
    flex: 0 0 auto;
  }
  .act {
    font-family: var(--util);
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: transparent;
    color: var(--paper-mute);
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--paper-mute);
  }
  .act.go {
    color: var(--paper);
    border-color: var(--paper-mute);
  }
  .act:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
