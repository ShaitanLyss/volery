<script lang="ts">
  /* Starting or joining a flyway: one person's walls on several machines,
   * linked by a single secret, the wall key.
   *
   * Its own panel rather than a row in `Keyring`/`integrations.ts`, and the table's
   * own comment is why: a row there is a token you paste from a website, with
   * set/clear and a probe. This one is *generated here* and has start/join/leave,
   * so fitting it in would mean either a row that lies about its shape or a table
   * whose third entry costs code. A thing that does not fit is better out.
   *
   * It never shows the key back. `flyway_held` is a boolean and the phrase from
   * `flyway_start` is held in this component for the one reading and dropped when
   * the panel closes — a secret the UI can ask for at any time is a secret on
   * screen at times nobody chose. */

  import { invoke } from "@tauri-apps/api/core";
  import { flywayError, flywayReading, worthJoining } from "./flyway";

  let { onclose }: { onclose: () => void } = $props();

  let held = $state<boolean | null>(null);
  let host = $state("");
  let typed = $state("");
  let phrase = $state(""); // shown once, never re-fetched
  let linked = $state(false);
  let busy = $state(false);
  let fault = $state("");
  let copied = $state(false);

  async function ask() {
    try {
      held = await invoke<boolean>("flyway_held");
      host = await invoke<string>("flyway_host");
      /* Holding a key and being *on* the flyway are two different facts, and
         they must not look alike: a wall whose endpoint could not bind has a
         key and syncs nothing. `flyway_linked` is the second question. */
      linked = await invoke<boolean>("flyway_linked");
    } catch (e) {
      fault = flywayError(e);
    }
  }
  $effect(() => {
    void ask();
  });

  async function act(f: () => Promise<void>) {
    if (busy) return;
    busy = true;
    fault = "";
    try {
      await f();
    } catch (e) {
      fault = flywayError(e);
    } finally {
      busy = false;
      await ask();
    }
  }

  const start = () =>
    act(async () => {
      phrase = await invoke<string>("flyway_start");
      copied = false;
      /* **Bring the link up now.** Without this a key takes effect at the next
         launch and nothing says so — you paste an invite, the panel says you
         are on a flyway, and nothing ever syncs. `arrive` is idempotent, so
         calling it on a wall that is already linked costs a lock. */
      await invoke("flyway_arrive");
    });

  const join = () => {
    if (!worthJoining(typed)) return;
    const sent = typed;
    return act(async () => {
      await invoke("flyway_join", { phrase: sent });
      typed = "";
      await invoke("flyway_arrive");
    });
  };

  const leave = () =>
    act(async () => {
      await invoke("flyway_leave");
      phrase = "";
    });

  async function copy() {
    try {
      await navigator.clipboard.writeText(phrase);
      copied = true;
    } catch (e) {
      fault = flywayError(e);
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="flyway"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="flyway"
    tabindex="-1"
  >
    <header>
      <h2>flyway</h2>
      <span class="reading">{flywayReading(held, host)}</span>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    <p class="aside">
      Your walls on several machines, linked. Membership is one secret — the wall key — and
      entering it on a machine is the whole of joining. It lives in the Windows credential
      vault and nothing hands it back.
    </p>

    {#if phrase}
      <section>
        <h3>your invite</h3>
        <p class="phrase">{phrase}</p>
        <div class="pair">
          <button class="act go" onclick={copy}>{copied ? "copied" : "copy it"}</button>
          <button class="act" onclick={() => (phrase = "")}>i have it</button>
        </div>
        <p class="aside">
          This is the only time it will be shown. Enter it on the other machine now — it cannot
          be read back from here afterwards.
        </p>
      </section>
    {/if}

    {#if held === false}
      <section>
        <h3>start one</h3>
        <p class="aside">
          Makes a fresh key on this machine and shows the invite once. The invite is that key
          and this machine's name — the name is how the other wall finds this one, so copy the
          whole of it.
        </p>
        <div class="pair">
          <button class="act go" disabled={busy} onclick={start}>start a flyway</button>
        </div>
      </section>
      <section>
        <h3>join one</h3>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="pat"
          type="text"
          autocomplete="off"
          spellcheck="false"
          autofocus
          placeholder="paste the invite from another machine"
          value={typed}
          oninput={(e) => (typed = e.currentTarget.value)}
          onkeydown={(e) => e.key === "Enter" && void join()}
          disabled={busy}
        />
        <div class="pair">
          <button class="act go" disabled={busy || !worthJoining(typed)} onclick={join}>
            {busy ? "joining…" : "join"}
          </button>
        </div>
      </section>
    {:else if held === true}
      <section>
        <h3>linked</h3>
        <p class="aside">
          This machine calls itself <code>{host}</code>. The key is held and is not shown.
          {#if linked}
            The link is up.
          {:else}
            The link is not up — nothing is syncing. Restarting may be enough; if it is not,
            this machine could not take a place on the flyway.
          {/if}
        </p>
        <div class="pair">
          <button class="act" disabled={busy} onclick={leave}>leave the flyway</button>
        </div>
      </section>
    {/if}

    {#if fault}
      <button class="oops" onclick={() => (fault = "")}>{fault}</button>
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
  .flyway {
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
    max-height: 84cqh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 0.9rem 1rem 1rem;
    width: 30rem;
    max-width: 92cqw;
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
  }
  .reading {
    flex: 1 1 auto;
    text-align: right;
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
  h3 {
    font-family: var(--util);
    font-size: 0.64rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    margin: 0 0 0.35rem;
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
    border-top: 1px solid var(--edge);
    padding-top: 0.7rem;
  }
  .aside {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  section .aside {
    margin-top: 0.1rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.92em;
    color: var(--paper-mute);
  }
  .phrase {
    margin: 0;
    font-family: var(--mono);
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--paper);
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.6rem;
    word-break: break-all;
    user-select: all;
  }
  .pat {
    font-family: var(--mono);
    font-size: 0.72rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.35rem 0.5rem;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.3rem;
  }
  .pat:focus {
    outline: none;
    border-color: var(--rule);
  }
  .pat::placeholder {
    color: var(--paper-faint);
  }
  .pair {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.5rem 0;
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
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .act:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
  .go {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .oops {
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
