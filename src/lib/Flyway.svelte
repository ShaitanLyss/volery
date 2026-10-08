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
   * It shows the key only when asked. `flyway_held` is a boolean, and the phrase
   * — whether it came from `flyway_start` or from `flyway_invite` — is held in
   * this component and dropped when the panel closes. The rule is that a secret
   * must not be on screen at a time nobody chose; a press is a time somebody
   * chose, and `key.rs::invite` has why making it unreadable was worse. */

  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import {
    acceptingReading,
    flywayError,
    flywayReading,
    nothingHeard,
    otherWalls,
    wallLine,
    worthJoining,
    type Wall,
  } from "./flyway";

  let { onclose }: { onclose: () => void } = $props();

  let held = $state<boolean | null>(null);
  let host = $state("");
  let typed = $state("");
  let phrase = $state(""); // hidden until asked for, and dropped when the panel closes
  let linked = $state(false);
  let busy = $state(false);
  let fault = $state("");
  let copied = $state(false);
  /* Whether this wall takes work from other walls — a person's switch, and
     `flyway/here.rs` reads anything but a yes as no. */
  let accepting = $state<boolean | null>(null);
  let walls = $state<Wall[]>([]);

  async function ask() {
    try {
      held = await invoke<boolean>("flyway_held");
      host = await invoke<string>("flyway_host");
      /* Holding a key and being *on* the flyway are two different facts, and
         they must not look alike: a wall whose endpoint could not bind has a
         key and syncs nothing. `flyway_linked` is the second question. */
      linked = await invoke<boolean>("flyway_linked");
      if (held) {
        accepting = (await invoke<{ accepting: boolean }>("flyway_setup")).accepting;
        walls = await invoke<Wall[]>("flyway_roster");
      }
    } catch (e) {
      fault = flywayError(e);
    }
  }
  $effect(() => {
    void ask();
  });
  /* The roster as it changes, while the panel is up. Folded off the event the
     link already emits every time a wall is heard from — nothing here asks
     again on a clock. */
  $effect(() => {
    const off = listen<Wall[]>("flyway:roster", (e) => (walls = e.payload));
    return () => void off.then((f) => f());
  });

  const toggle = () =>
    act(async () => {
      await invoke("flyway_set_accepting", { on: !accepting });
    });

  /* `a` throws the switch while the panel is up and nothing is being typed —
     the keyboard reaches everything here, per the house rule. */
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") return onclose();
    const typing = e.target instanceof HTMLInputElement;
    if (!typing && held && e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      void toggle();
    }
  }

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

  /* The invite again, for the machine that was not in front of you when the
     flyway was started — which is the ordinary case, since you start one here
     and join from the office tomorrow. It was once unreadable on the argument
     that a secret the UI can ask for at any time is on screen at times nobody
     chose; that hazard is real and it lives in the *drawing*, which is where it
     is answered. Hidden until this press, and `phrase` is dropped when the
     panel closes exactly as the started one always was. `key.rs::invite` has
     the whole argument, including what the old shape cost: with the clipboard
     gone the only gesture left was `start`, which mints a fresh key and
     silently orphans every wall holding the old one. */
  const reveal = () =>
    act(async () => {
      phrase = await invoke<string>("flyway_invite");
      copied = false;
    });

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

<svelte:window onkeydown={onKey} />

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
      <span class="reading">{flywayReading(held, host, linked)}</span>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    <p class="aside">
      Your walls on several machines, linked. Membership is one secret — the wall key — and
      entering it on a machine is the whole of joining. It lives in the Windows credential
      vault and is shown only when you ask for it.
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
          Enter it on every other machine that should be on this flyway. It is kept hidden
          here, not thrown away — "show my invite" brings it back.
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
          <button class="act" disabled={busy || !!phrase} onclick={reveal}>show my invite</button>
          <button class="act" disabled={busy} onclick={leave}>leave the flyway</button>
        </div>
      </section>
      <section>
        <h3>work from other walls</h3>
        <p class="aside">{acceptingReading(accepting)}</p>
        <div class="pair">
          <button
            class="act"
            class:go={!accepting}
            disabled={busy || accepting === null}
            onclick={toggle}
            title="take work from other walls, or stop (a)"
          >
            {accepting ? "stop taking work" : "take work from other walls"}
          </button>
        </div>
      </section>
      <section>
        <h3>the other walls</h3>
        {#if otherWalls(walls).length === 0}
          <p class="aside">
            None heard from yet. A wall is learned from the one it joined through, and from
            any wall that dials this one. If one was expected, it is one of these:
          </p>
          <ul class="causes">
            {#each nothingHeard(linked) as why (why)}
              <li class="aside">{why}</li>
            {/each}
          </ul>
        {:else}
          <ul class="walls">
            {#each otherWalls(walls) as w (w.host)}
              <li title={w.reason ?? ""}>
                <code>{w.host}</code>
                <span class="aside">{wallLine(w)}</span>
              </li>
            {/each}
          </ul>
        {/if}
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
  /* Marked, where `.walls` is not: these are candidates to read down and rule
     out one by one, and a bare stack of sentences reads as a paragraph that has
     lost its commas. The roster above is a list of things, which needs no mark. */
  .causes {
    margin: 0.3rem 0 0;
    padding-left: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .walls {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .walls li {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
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
