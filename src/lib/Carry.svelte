<script lang="ts">
  /* Carrying the wall off, and bringing one in.
   *
   * Its own component for the reason `Dock.svelte` is one: a subsystem with its
   * own vocabulary of class names wants its own file, and a component is the
   * only CSS scope this codebase has.
   *
   * Two halves, and the asymmetry between them is the design. Going out is one
   * press — a document is a file, and writing one changes nothing. Coming in is
   * two: the tally first, the press that commits to it second. An import adds to
   * the wall and cannot be taken back in one press, so it gets the same shape a
   * broadcast gets, where the gesture has to be meant.
   *
   * The third section is the one that is not obviously a panel's business:
   * territories that point nowhere. It is here because this is where the need
   * arises — you have just imported a layout and none of its projects are
   * rooted — and because from here it is a list you can work down, where on the
   * wall it is one territory at a time. The wall draws it too now, on each
   * territory's own row; both faces press the same `adrift.pick`, which is the
   * point of that being a singleton rather than a method on `Portage`.
   */

  /* The component is `Carry` and the class it draws is `Portage`, which is the
     same split `Console`/`Shell` and `Pomodoro`/`Cycle` already have: a
     `.svelte.ts` module and a `.svelte` component of the same name are one file
     to a case-insensitive filesystem, and TypeScript says so. */
  import { adrift, type Portage } from "./portage.svelte";
  import type { Project } from "./skein.svelte";
  import { sayTally } from "./portage";

  let {
    carry,
    projects,
    onclose,
  }: {
    carry: Portage;
    projects: Project[];
    onclose: () => void;
  } = $props();

  /* Which roots are not directories on this machine is `adrift`'s to know — the
     panel takes no prop for it and asks nothing itself. It used to be handed
     one, asked by `App.svelte` while this panel was open, and that stopped
     being the only reader the moment the wall began drawing it on each
     territory's row. Named `nowhere` because `adrift` is the class. */
  const nowhere = $derived(projects.filter((p) => adrift.has(p.root_path)));
  const waiting = $derived(carry.pending ? sayTally(carry.pending) : null);
</script>

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag that started inside the panel does not dismiss it. The
     same shell every other panel here uses. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="carry"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="layout"
    tabindex="-1"
  >
  <header>
    <h2>layout</h2>
    <button class="x" onclick={onclose} aria-label="Close">&times;</button>
  </header>

  <p class="what">
    Everything about how this room is arranged — the territories and where they sit, the
    server groups they run, the widgets and images on the wall, the ambiences, the themes you
    wrote, and the standing instructions the wall and its territories give their cards. Not
    the cards themselves: a conversation is a session on this machine, and one carrying a
    resume id that resolves to nothing is worse than no card. Accounts have their own export
    in the accounts panel, because no document carries a credential.
  </p>

  <section>
    <h3>out</h3>
    <button class="act" disabled={carry.busy} onclick={() => void carry.write()}>
      {carry.busy ? "reading the wall…" : "write a layout file…"}
    </button>
    <p class="aside">image files travel inside the document, so it is as big as they are.</p>
  </section>

  <section>
    <h3>in</h3>
    {#if carry.pending}
      <p class="tally">
        {carry.pendingFrom} holds {waiting ?? "nothing"}
      </p>
      <p class="aside">
        This adds to the wall — it never replaces and never deletes, and furniture of the same
        kind already in the same place is left alone. Undo takes it back one thing at a time
        rather than in one press. An ambience the document was wearing becomes the one showing.
        Standing instructions are only taken where you have none: anything already telling its
        cards something goes on saying it, and the document's version is left out and named.
      </p>
      <div class="pair">
        <button class="act go" disabled={carry.busy} onclick={() => void carry.settle()}>
          {carry.busy ? "putting it up…" : "bring it in"}
        </button>
        <button class="act" onclick={() => carry.forget()}>leave it</button>
      </div>
    {:else}
      <button class="act" disabled={carry.busy} onclick={() => void carry.read()}>
        read a layout file…
      </button>
    {/if}
  </section>

  {#if nowhere.length > 0}
    <section>
      <h3>pointing nowhere</h3>
      <p class="aside">
        {nowhere.length === 1 ? "one territory" : `${nowhere.length} territories`} whose folder is
        not on this machine — imported, moved or on a drive that is not mounted. Nothing in one
        can be worked in until it has somewhere to be.
      </p>
      <ul class="adrift">
        {#each nowhere as p (p.id)}
          <li>
            <span class="pname">{p.name}</span>
            <span class="was" title={p.root_path}>{p.root_path}</span>
            <button
              class="act"
              disabled={carry.busy || adrift.busy}
              onclick={() => void adrift.pick(p.root_path)}>point it at a folder…</button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if carry.landed && carry.landed.skipped.length > 0}
    <section>
      <h3>left out</h3>
      <ul class="skipped">
        {#each carry.landed.skipped as s, i (i)}
          <li>{s}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- Rooting says its own piece, because it is `adrift`'s gesture rather than
       this panel's — and it keeps a fault of its own rather than deferring to
       the wall's bar, which the scrim above covers. -->
  {#if adrift.note}
    <p class="note">{adrift.note}</p>
  {/if}
  {#if adrift.fault}
    <button class="fault" onclick={() => (adrift.fault = null)}>{adrift.fault}</button>
  {/if}
  {#if carry.note}
    <p class="note">{carry.note}</p>
  {/if}
  {#if carry.fault}
    <button class="fault" onclick={() => (carry.fault = null)}>{carry.fault}</button>
  {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .carry {
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
    max-height: 84vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 0.9rem 1rem 1rem;
    max-width: 30rem;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  h2 {
    font-family: var(--display);
    font-size: 1rem;
    font-weight: 400;
    margin: 0;
    flex: 1 1 auto;
  }
  h3 {
    font-family: var(--util);
    font-size: 0.64rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    margin: 0 0 0.4rem;
    font-weight: 400;
  }
  .x {
    background: none;
    border: 0;
    color: var(--paper-mute);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  section {
    display: flex;
    flex-direction: column;
  }

  .what,
  .aside,
  .tally,
  .note {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.5;
    color: var(--paper-mute);
  }
  .what {
    color: var(--paper-faint);
  }
  .aside {
    margin-top: 0.4rem;
    color: var(--paper-faint);
  }
  .tally {
    color: var(--paper);
    font-family: var(--mono);
    font-size: 0.7rem;
  }
  .note {
    font-family: var(--mono);
    font-size: 0.68rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.6rem;
  }

  .pair {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .act {
    font-family: var(--util);
    font-size: 0.72rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    align-self: flex-start;
    text-align: left;
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .act:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
  /* The one press in here that changes the wall. Not a colour — colour is
     status, and wanting to be pressed is not a status — but a heavier edge, the
     way the dock's own commit does it. */
  .go {
    color: var(--paper);
    border-color: var(--paper-faint);
  }

  .adrift,
  .skipped {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .adrift li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.15rem 0.5rem;
    align-items: baseline;
    border-left: 1px solid var(--edge);
    padding-left: 0.6rem;
  }
  .pname {
    font-size: 0.78rem;
    color: var(--paper);
  }
  .adrift .act {
    grid-row: span 2;
    align-self: center;
  }
  /* The path it wants, small and whole rather than elided: it is the only clue
     about which folder this territory is for, and the tail of it is the part
     that says so. */
  .was {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--paper-faint);
    word-break: break-all;
  }

  .skipped li {
    font-size: 0.7rem;
    color: var(--paper-faint);
    font-family: var(--mono);
  }

  .fault {
    text-align: left;
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--st-fail);
    background: color-mix(in srgb, var(--st-fail) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-fail) 30%, var(--edge));
    border-radius: 3px;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
  }
</style>
