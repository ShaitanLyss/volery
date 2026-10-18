<script lang="ts">
  /* What has to be true before a first message can go anywhere, said above the
     message box rather than in a fault bar (`docs/chat-mode.md` §5.9 step 2).

     Two cards, and nothing drawn while looking — a card that flashed up and
     went again on every launch would teach people to ignore it:

     - **Claude Code not found.** The one PowerShell line, a copy button and
       *look again*. Nothing runs it for them: a failed lookup is a question,
       never a licence to run a script off the network (`accounts.md`).
     - **Not signed in.** `signin.rs`'s browser flow, which comes back on its
       own; the sign-in page as a link only if the browser did not open, and the
       paste-a-code field only if the CLI asks for one (`signin.ts`).

     The message box stays usable throughout: what is typed is a draft. */
  import { invoke } from "@tauri-apps/api/core";
  import type { Starter } from "./starting.svelte";
  import { codeFrom } from "./signin";
  import { INSTALL_LINE } from "./starting";

  let { starter }: { starter: Starter } = $props();

  let copied = $state(false);
  let code = $state("");
  const p = $derived(starter.progress);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_LINE);
      copied = true;
      setTimeout(() => (copied = false), 1600);
    } catch {
      /* The line is on screen and selectable; a refused clipboard costs a
         select-and-copy, nothing more. */
    }
  }

  async function hand() {
    const c = codeFrom(code);
    if (!c) return;
    await starter.paste(c);
    code = "";
  }
</script>

{#if starter.ready === "missing"}
  <section class="ready" aria-label="getting ready">
    <h2>Volery runs Claude Code, which isn't on this computer yet</h2>
    <p>Paste this into PowerShell to install it, then come back here.</p>
    <div class="line">
      <code>{INSTALL_LINE}</code>
      <button type="button" class="btn" onclick={copy}>{copied ? "copied" : "copy"}</button>
    </div>
    <div class="acts">
      <button type="button" class="btn" onclick={() => void starter.lookAgain()}>look again</button>
    </div>
  </section>
{:else if starter.ready === "signed-out"}
  <section class="ready" aria-label="getting ready">
    <h2>sign in to Claude</h2>
    {#if starter.signing?.running}
      <p>Waiting for your browser — it comes back here by itself once you have signed in.</p>
      {#if p?.url && !p.opened}
        <div class="acts">
          <button type="button" class="btn" onclick={() => void invoke("open_external", { url: p.url })}>open the sign-in page</button>
        </div>
      {/if}
      {#if p?.prompting}
        <form
          class="line"
          onsubmit={(e) => {
            e.preventDefault();
            void hand();
          }}
        >
          <input bind:value={code} placeholder="paste the code the page shows" aria-label="sign-in code" />
          <button type="submit" class="btn">hand it over</button>
        </form>
      {/if}
    {:else}
      <p>Conversations run on your Claude account. Signing in opens your browser and comes back on its own.</p>
      {#if starter.signing?.fault}<p class="fault">{starter.signing.fault}</p>{/if}
      <div class="acts">
        <button type="button" class="btn primary" onclick={() => void starter.signIn()}>sign in to Claude</button>
        <button type="button" class="btn" onclick={() => void starter.lookAgain()}>look again</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .ready {
    width: min(700px, calc(100% - 48px));
    margin: 0 auto 14px;
    padding: 14px 16px 14px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: linear-gradient(
      180deg,
      color-mix(in oklab, var(--surface) 70%, transparent),
      color-mix(in oklab, var(--surface) 45%, transparent)
    );
    font-family: var(--cv-ui, var(--util));
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  :global(html[data-motion="still"]) .ready {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ready {
      animation: none;
    }
  }
  h2 {
    margin: 0 0 4px;
    font: 500 14px/1.35 var(--cv-ui, var(--util));
    color: var(--paper);
  }
  p {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--paper-mute);
  }
  .fault {
    color: color-mix(in oklab, var(--st-fail) 60%, var(--paper-dim));
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  code {
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    border-radius: var(--cv-r-s, 7px);
    font: 350 12.5px var(--mono);
    color: var(--paper);
    background: color-mix(in oklab, var(--cv-sheet, var(--ink)) 80%, transparent);
    border: 1px solid var(--cv-hair, var(--edge));
    user-select: all;
    overflow-x: auto;
    white-space: nowrap;
  }
  input {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--cv-r-s, 7px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--cv-sheet, var(--ink)) 80%, transparent);
    color: var(--paper);
    font: 13px var(--cv-ui, var(--util));
  }
  .acts {
    display: flex;
    gap: 8px;
  }
  .btn {
    height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
    color: var(--paper-dim);
    font: 12.5px var(--cv-ui, var(--util));
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .btn.primary {
    color: var(--cv-sheet, var(--ink));
    background: var(--paper);
    border-color: transparent;
  }
</style>
