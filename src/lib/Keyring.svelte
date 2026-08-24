<script lang="ts">
  /* The Azure DevOps token, entered here because the machine's own two
   * credentials are not always enough.
   *
   * Its own component for the reason `Dock` and `Carry` are: a subsystem with
   * its own vocabulary of class names wants its own file, and a component is the
   * only CSS scope this codebase has.
   *
   * **This is the first text field in Skein that configures anything**, and the
   * module header in `azdo.rs` used to argue that no such thing could exist —
   * which is why the organisation is read off `git remote` rather than typed.
   * That argument still holds for the org and does not hold here, and the
   * difference is worth stating: an organisation is a *fact about the wall*,
   * derivable from what is standing on it, so asking would be asking you to
   * retype something the app can see. A PAT is not derivable from anything. It
   * exists only because somebody went and minted it, and no amount of looking at
   * the wall will turn one up.
   *
   * Two things it deliberately does not do. It never shows the token back —
   * there is no command that returns one, so `held` is a boolean and the field
   * always starts empty; pasting over is how you replace one. And it does not
   * tell you which rung is in use, because the ladder resolves per organisation
   * and per endpoint family and any single answer would be wrong somewhere. What
   * it shows instead is the pipelines fault verbatim, which names the rung that
   * was refused. */

  import type { DevOps } from "./devops.svelte";

  let { devops, onclose }: { devops: DevOps; onclose: () => void } = $props();

  let typed = $state("");
  let busy = $state(false);
  let note = $state<string | null>(null);
  let fault = $state<string | null>(null);

  /* Asked on open rather than held by the class, because Credential Manager is
     reachable without us — the whole point of putting it there — so a cached
     answer can be stale in the one direction that matters. */
  $effect(() => {
    void devops.askHeld();
  });

  async function save() {
    const token = typed.trim();
    if (!token || busy) return;
    busy = true;
    note = null;
    fault = null;
    try {
      await devops.store(token);
      typed = "";
      note = "stored — the next reading will use it";
    } catch (err) {
      fault = String(err);
    } finally {
      busy = false;
    }
  }

  async function forget() {
    if (busy) return;
    busy = true;
    note = null;
    fault = null;
    try {
      await devops.forget();
      note = "removed from the vault";
    } catch (err) {
      fault = String(err);
    } finally {
      busy = false;
    }
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
    aria-label="azure devops token"
    tabindex="-1"
  >
    <header>
      <h2>azure devops token</h2>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    <p class="what">
      Volery tries the credential Git Credential Manager already holds, then an <code>az</code>
      sign-in, then this, then <code>VOLERY_AZDO_PAT</code> — each until one is accepted rather
      than until one is found. The first is usually enough for pull requests and not for builds:
      it is code-scoped, so the pipelines widget gets a 401 where reviews works fine. A token
      minted with <strong>Build (read)</strong> is what fixes that.
    </p>

    <section>
      <h3>{devops.held ? "replace it" : "store one"}</h3>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="pat"
        type="password"
        autocomplete="off"
        spellcheck="false"
        autofocus
        placeholder={devops.held ? "paste a new one" : "paste the token"}
        bind:value={typed}
        onkeydown={(e) => {
          if (e.key === "Enter") void save();
        }}
        disabled={busy}
      />
      <div class="pair">
        <button class="act go" disabled={busy || !typed.trim()} onclick={() => void save()}>
          {busy ? "storing…" : "store it"}
        </button>
        {#if devops.held}
          <button class="act" disabled={busy} onclick={() => void forget()}>forget it</button>
        {/if}
      </div>
      <p class="aside">
        It goes in the Windows credential vault under <code>dev.skein.studio/azdo-pat</code> — the
        same place Git Credential Manager keeps this organisation's other token, so you can see
        and delete it in Control Panel → Credential Manager without Volery's help. Not in the
        wall's database, which is a plaintext file that layouts are exported out of. Nothing
        hands it back once stored: no command returns it, so no panel and no snapshot can carry
        it.
      </p>
    </section>

    <section>
      <h3>where to get one</h3>
      <p class="aside">
        Azure DevOps → User settings → Personal access tokens → New token, scoped to
        <strong>Build (read)</strong> for pipelines. Mint it as the account you clone with — a
        token from a different identity can only see the projects that identity is on, which is
        the failure that reads as an empty widget rather than as an error.
      </p>
    </section>

    {#if devops.runs.fault}
      <section>
        <h3>pipelines last said</h3>
        <p class="said">{devops.runs.fault}</p>
        <p class="aside">
          The rung is named, which is the useful half: <em>the git credential</em> is the one
          Credential Manager holds, <em>an az sign-in</em> came from <code>az login</code>, and
          <em>the stored token</em> is this one.
        </p>
      </section>
    {/if}

    {#if devops.runs.unseen > 0}
      <p class="aside">
        {devops.runs.unseen === 1 ? "1 project was" : `${devops.runs.unseen} projects were`}
        invisible to every credential on the ladder — not an error, just projects this identity
        is not on.
      </p>
    {/if}

    {#if note}
      <p class="note">{note}</p>
    {/if}
    {#if fault}
      <button class="oops" onclick={() => (fault = null)}>{fault}</button>
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
  code {
    font-family: var(--mono);
    font-size: 0.92em;
    color: var(--paper-mute);
  }

  /* The field. Monospace because a PAT is an opaque string you check character
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

  /* What the widget itself is reporting, quoted rather than reworded: it names
     the rung, and rewording it here would be a second vocabulary to keep true. */
  .said {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--st-fail);
  }

  .note {
    font-family: var(--mono);
    font-size: 0.68rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.6rem;
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
