<script lang="ts">
  /* One place for every integration's credential.
   *
   * It was the Azure DevOps token panel, and the generalisation is presentation
   * and plumbing rather than a new mechanism: `vault.rs` has taken a target
   * since Spotify wanted the same treatment, `creds.rs` maps a service id to
   * one, and `integrations.ts` is the table of what exists. A row is drawn per
   * entry in that table, so the third integration costs one entry and nothing
   * here.
   *
   * Its own component for the reason `Dock` and `Carry` are: a subsystem with
   * its own vocabulary of class names wants its own file, and a component is the
   * only CSS scope this codebase has.
   *
   * **This is still the only text field in Skein that configures anything**, and
   * the module header in `azdo.rs` used to argue that no such thing could exist
   * — which is why an Azure DevOps organisation is read off `git remote` rather
   * than typed. That argument still holds for the org and does not hold here,
   * and the difference is worth keeping stated: an organisation is a *fact about
   * the wall*, derivable from what is standing on it, so asking would be asking
   * you to retype something the app can see. A token is not derivable from
   * anything. It exists only because somebody went and minted it, and no amount
   * of looking at the wall will turn one up.
   *
   * Two things it deliberately does not do. It never shows a token back — there
   * is no command that returns one, so `held` is a boolean and every field
   * starts empty; pasting over is how you replace one. And it does not tell you
   * which rung of the Azure DevOps ladder is in use, because that resolves per
   * organisation and per endpoint family and any single answer would be wrong
   * somewhere.
   *
   * What is new is the **check**. A stored token that is wrong is
   * indistinguishable from a missing one until something fails hours later, in a
   * widget, in a voice that names the network rather than the credential — so
   * every row has one cheap authenticated GET behind a button, run when you ask
   * and never on a clock, and the answer sits beside the row. It runs itself
   * once after a store, which is the moment it is cheapest to act on: you are
   * looking at the row with the page you minted the token on still open. */

  import type { DevOps } from "./devops.svelte";
  import type { Creds } from "./creds.svelte";
  import { INTEGRATIONS, checkFailed, checkReading, type ServiceId } from "./integrations";

  let {
    keyring,
    devops,
    onclose,
  }: { keyring: Creds; devops: DevOps; onclose: () => void } = $props();

  /** What is typed into each row's field, cleared as it is sent. Keyed by
   *  service so two rows are two independent fields — pasting an Asana token
   *  while an Azure DevOps one is half-typed must not disturb either. */
  let typed = $state<Record<string, string>>({});

  /* Asked on open rather than held by the class, because Credential Manager is
     reachable without us — the whole point of putting it there — so a cached
     answer can be stale in the one direction that matters. */
  $effect(() => {
    void keyring.askAll();
  });

  /** Which row takes the caret. The first one with nothing in it, since that is
   *  overwhelmingly why the panel is open; the first row otherwise, so opening
   *  it to replace a token still lands somewhere you can type. */
  const focus = $derived(
    INTEGRATIONS.find((i) => !keyring.heldFor(i.id))?.id ?? INTEGRATIONS[0].id,
  );

  function save(id: ServiceId) {
    const token = typed[id] ?? "";
    if (!token.trim()) return;
    typed[id] = "";
    void keyring.store(id, token);
  }
</script>

<!-- Escape closes it, which is what puts `showKeyring` in App's Escape guard:
     anything that closes on the key owns it while it is open. -->
<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag that started inside the panel does not dismiss it. The
     same shell every other panel here uses. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="keyring"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="integration tokens"
    tabindex="-1"
  >
    <header>
      <h2>integration tokens</h2>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    <p class="what">
      A token for each service Volery reads. They go in the Windows credential vault, under
      <code>dev.skein.studio/&hellip;</code> — the same place Git Credential Manager keeps this
      organisation's other token, so you can see and delete them in Control Panel &rarr;
      Credential Manager without Volery's help. Not in the wall's database, which is a plaintext
      file that layouts are exported out of. Nothing hands one back once stored: no command
      returns a token, so no panel and no snapshot can carry one.
    </p>

    {#each INTEGRATIONS as row (row.id)}
      {@const held = keyring.heldFor(row.id)}
      {@const check = keyring.checkFor(row.id)}
      {@const busy = keyring.busy[row.id] ?? false}
      <section>
        <div class="head">
          <h3>{row.label}</h3>
          <span class="reading" class:bad={checkFailed(held, check)}>
            {checkReading(held, check, row.sole)}
          </span>
        </div>
        <p class="aside why">{row.why}</p>

        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="pat"
          type="password"
          autocomplete="off"
          spellcheck="false"
          autofocus={row.id === focus}
          placeholder={held ? "paste a new one" : `paste the ${row.credential}`}
          value={typed[row.id] ?? ""}
          oninput={(e) => (typed[row.id] = e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") save(row.id);
          }}
          disabled={busy}
        />
        <div class="pair">
          <button
            class="act go"
            disabled={busy || !(typed[row.id] ?? "").trim()}
            onclick={() => save(row.id)}
          >
            {busy ? "storing…" : "store it"}
          </button>
          {#if held}
            <!-- Only where there is a probe to run. A button that could answer
                 nothing is worse than a missing one: it reads as broken rather
                 than as absent, which is the argument `widgets.ts`'s `only`
                 guard makes about knobs. -->
            {#if row.probe}
              <button class="act" disabled={busy} onclick={() => void keyring.verify(row.id)}>
                check it
              </button>
            {/if}
            <button class="act" disabled={busy} onclick={() => void keyring.forget(row.id)}>
              forget it
            </button>
          {/if}
          {#if keyring.note[row.id]}
            <span class="note">{keyring.note[row.id]}</span>
          {/if}
        </div>

        <p class="aside">
          {row.mint}{#if row.scope}, scoped to <strong>{row.scope}</strong>{/if}. Mint it as the
          account you work as — a token from a different identity is accepted and then sees none
          of your projects, which is the failure that reads as an empty widget rather than as an
          error{#if row.probe}, and is what <em>check it</em> names{/if}. It lands in the vault
          under <code>{row.target}</code>.
        </p>

        {#if keyring.fault[row.id]}
          <button class="oops" onclick={() => (keyring.fault[row.id] = "")}>
            {keyring.fault[row.id]}
          </button>
        {/if}

        <!-- The one service-specific thing in this panel, and it is specific for
             a reason no table column could carry: Azure DevOps is the only
             integration whose token is *one rung of a ladder* rather than the
             whole credential. So the widget's own fault says something a probe
             cannot — which rung was refused — and rewording it here would be a
             second vocabulary to keep true. Anything else with a ladder gets the
             same treatment; nothing else has one. -->
        {#if row.id === "azdo" && devops.runs.fault}
          <p class="said">{devops.runs.fault}</p>
          <p class="aside">
            What pipelines last said. The rung is named, which is the useful half:
            <em>the git credential</em> is the one Credential Manager holds, <em>an az sign-in</em>
            came from <code>az login</code>, and <em>the stored token</em> is this one. A
            code-scoped credential reads pull requests perfectly well and gets a 401 on builds,
            which is the whole reason this row exists.
          </p>
        {/if}
        {#if row.id === "azdo" && devops.runs.unseen > 0}
          <p class="aside">
            {devops.runs.unseen === 1 ? "1 project was" : `${devops.runs.unseen} projects were`}
            invisible to every credential on the ladder — not an error, just projects this
            identity is not on.
          </p>
        {/if}
      </section>
    {/each}
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

  .keyring {
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
    margin: 0;
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

  /* A row per integration, ruled off from the one above it rather than boxed —
     these are the same kind of thing repeated, and a border on four sides of
     each would read as five panels stacked. */
  section {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--edge);
    padding-top: 0.7rem;
  }

  /* The row's name and what its token is doing, on one line: the name is what
     you are looking for and the reading is why you opened the panel, so putting
     the second under the first would make every row twice as tall for a phrase
     that is usually four words. */
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }
  .reading {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    flex: 1 1 auto;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Colour is status in this app, and a refused token is one. Not having a token
     is not — see `checkFailed`. */
  .reading.bad {
    color: var(--st-fail);
  }

  .what,
  .aside,
  .said,
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
  .why {
    margin-top: 0;
    margin-bottom: 0.4rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.92em;
    color: var(--paper-mute);
  }

  /* The field. Monospace because a token is an opaque string you check character
     by character when it goes wrong, and `-webkit-text-security` keeps the dots
     evenly spaced so a paste of the wrong length is visible as one. */
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
  }
  .pat:focus {
    outline: none;
    border-color: var(--rule);
  }
  .pat::placeholder {
    color: var(--paper-faint);
  }
  .pat:disabled {
    color: var(--paper-faint);
  }

  .pair {
    display: flex;
    align-items: center;
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
  /* The press that changes something. Not a colour — colour is status, and
     wanting to be pressed is not a status — but a heavier edge, the way the
     dock's own commit and `Carry`'s do it. */
  .go {
    color: var(--paper);
    border-color: var(--paper-faint);
  }

  /* What a widget itself is reporting, quoted rather than reworded: it names the
     rung, and rewording it here would be a second vocabulary to keep true. */
  .said {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--st-fail);
    margin-top: 0.5rem;
  }

  /* Beside the buttons rather than under them: it is one word, and a line of its
     own for "stored" would move everything below it every time you pressed. */
  .note {
    font-family: var(--mono);
    font-size: 0.68rem;
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
    margin-top: 0.5rem;
  }
</style>
