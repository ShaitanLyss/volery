<script lang="ts">
  /* The order, the ceilings, and the state of the machine underneath them.
   *
   * This panel holds no policy: `standingOf` and `choose` in the pure
   * `accounts.ts` answer every question it draws, and `waterfall.svelte.ts` is
   * the reader behind it. What is local here is the three half-typed things —
   * a name being entered, a cap mid-edit, and a delete half-armed — which is
   * the same split `Themes.svelte` draws for the same reason.
   *
   * The order is the feature, so it is what the panel is arranged around: the
   * list reads top to bottom in the order work actually falls through it, and
   * the row that is next has the mark. See `.claude/rules/accounts.md`.
   */
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { waterfall } from "./waterfall.svelte";
  import {
    accountsDoc,
    cleanSignIns,
    exportAccounts,
    importAccounts,
    mergeAccounts,
    planSignins,
    sayBlocked,
    sayCarried,
    sayFileWarning,
    sayImported,
    sayInstalled,
    sayLife,
    sayTier,
    sayUnmeasured,
    sayUnsigned,
    standingOf,
    tiers,
    type Install,
    type Merge,
    type SignIn,
  } from "./accounts";
  import { pct, said as windowSaid, until } from "./limits";
  import { Listeners } from "./listeners";
  import { codeFrom, looksLikeCode, readSignin } from "./signin";

  let { onclose }: { onclose: () => void } = $props();

  const WATCHER = "accounts-panel";

  /** The name being typed for a new account. */
  let naming = $state("");
  /** Which account has a destructive gesture half-made, and which one. Armed
   *  rather than confirmed in a dialog: a second click on a button that has
   *  visibly changed its mind is a smaller interruption than a modal, and it
   *  disarms on any other press in the panel. */
  let arming = $state<string | null>(null);
  /** What the panel last said back, beside the thing that happened rather than
   *  in a bar at the top — the bargain `Themes.svelte` strikes with `said`. */
  let note = $state("");
  let noteTimer = 0;
  /** True while the installer is running, which is minutes rather than
   *  moments and must not look like a button that did nothing. */
  let installing = $state(false);
  /** Everything each in-flight sign-in has said, by label. Accumulated rather
   *  than parsed as it arrives: `signin.rs` sends chunks off a pipe, since the
   *  prompt the fallback needs has no newline to wait for, so the whole text is
   *  the only thing a match can be made against. */
  let signinOut = $state<Record<string, string>>({});
  /** Whether each sign-in's process is still up. */
  let signinRunning = $state<Record<string, boolean>>({});
  /** What is half-typed in each account's paste field. */
  let pasting = $state<Record<string, string>>({});
  /** Labels the last import put here, and what the rename did to them.
   *
   *  Kept so the one thing an export cannot carry can be said for as long as it
   *  is true rather than once in a note that fades — `sayUnmeasured`'s rule. Not
   *  persisted, though: this is a remark about a gesture you have just made, and
   *  a session opening with "imported, not signed in" about a row from last week
   *  would be reporting the state of the world as news. The durable half is the
   *  row itself, which `standingOf` draws unusable in its own words. */
  let imported = $state<string[]>([]);
  let renames = $state<{ from: string; to: string }[]>([]);
  /** True while a file is being written or read. Both are a dialog and a disk,
   *  which is long enough that a button doing nothing would look broken. */
  let carrying = $state(false);
  /** Carried sign-ins that will not be installed without a press — the file's
   *  credential is older than the one here, the same age, or of an age nothing
   *  can compare. `planSignins` decides which; this is what is left to ask. */
  let waiting = $state<Install[]>([]);
  /** What the last loaded file's sign-ins are worth, so a row that is waiting
   *  can say what taking it would get you. Two timestamps and a plan name per
   *  account: no token ever reaches this process. */
  let carried = $state<SignIn[]>([]);
  /** The file the last load came from, named in what the panel says back. */
  let carriedFrom = $state("");

  const listeners = new Listeners();

  const now = $derived(Date.now());

  /** The last component of a path, for saying which file something came from.
   *  Both separators, since a path typed into a Windows dialog may use either. */
  function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
  }

  function say(word: string) {
    note = word;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note = ""), 2600);
  }

  /** How one account's sign-in is going, read off what it has said. */
  function progressOf(label: string) {
    return readSignin(signinOut[label] ?? "");
  }

  onMount(() => {
    waterfall.attach(WATCHER);

    /* Subscriptions are kept so they can be let go of — `Listeners` exists
       because `tauri dev` rebuilds this component on every edit, and a
       superseded copy still appending to `signinOut` would draw two sign-ins
       into one box. */
    listeners.keep(
      listen<{ label: string; text: string }>("signin:out", (e) => {
        const { label, text } = e.payload;
        signinOut = { ...signinOut, [label]: (signinOut[label] ?? "") + text };
      }),
    );
    listeners.keep(
      listen<{ label: string; ok: boolean; signed_in: boolean }>("signin:done", (e) => {
        const { label, signed_in: signedIn } = e.payload;
        signinRunning = { ...signinRunning, [label]: false };
        /* The registry is what the rest of the panel reads, and `signedIn` is a
           file on disk rather than an exit code — so a flow abandoned in the
           browser leaves the row exactly as it was. */
        void waterfall.refresh();
        say(signedIn ? `${label} is signed in` : `${label} was not signed in`);
      }),
    );

    /* A sign-in outlives this panel: closing it does not cancel the browser
       round trip. So on mount, ask what is already in flight rather than
       showing an empty box for something that is halfway done. */
    void invoke<{ label: string; running: boolean; out: string }[]>("signin_states")
      .then((states) => {
        for (const s of states) {
          signinOut = { ...signinOut, [s.label]: s.out };
          signinRunning = { ...signinRunning, [s.label]: s.running };
        }
      })
      .catch(() => {});
  });
  onDestroy(() => {
    waterfall.detach(WATCHER);
    listeners.detach();
    clearTimeout(noteTimer);
    /* Whatever a loaded file left parked in Rust goes when the panel does. A
       credential in a mutex for as long as a panel is open is a much smaller
       thing than one there for the life of the process, and this is the whole
       cost of the difference. Anything still `waiting` is abandoned by that,
       which is the right way round: not installing is the safe outcome. */
    void invoke("drop_carried").catch(() => {});
  });

  /** Where each account stands, in the order work falls through them. Bypass is
   *  false here on purpose: this panel draws the ordinary state of the world,
   *  and a bypass is a property of one conversation rather than of the wall. */
  const standings = $derived(
    waterfall.list.map((a) => ({
      account: a,
      standing: standingOf(a, waterfall.allowances[a.label], false),
    })),
  );

  /** The same thing in bands, which is what the panel is actually arranged as.
   *
   *  The grouping is `tiers` in the pure module rather than an inline reduce
   *  here, so what a band *is* has one definition and it is the one `choose`
   *  partitions by. `above` is carried on each band because the header says
   *  what has to be spent before this one is touched, and that sentence needs
   *  its neighbour's number — which only the list knows. */
  const bands = $derived.by(() => {
    const byLabel = new Map(standings.map((s) => [s.account.label, s.standing]));
    return tiers(waterfall.list).map((t, i, all) => ({
      priority: t.priority,
      above: i === 0 ? null : all[i - 1]!.priority,
      rows: t.accounts.map((a) => ({ account: a, standing: byLabel.get(a.label)! })),
    }));
  });

  /** Put an account in a tier, from the field on its row. Blank and anything
   *  unreadable leave it where it is — unlike a cap, where blank is the real
   *  and different instruction "no ceiling", every account is in exactly one
   *  tier and there is no such thing as none. */
  async function setTier(label: string, raw: string) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    try {
      await waterfall.setPriority(label, n);
    } catch (err) {
      say(String(err));
    }
  }

  /** Which account the next new turn would go to, drawn as a mark on the row so
   *  the order is legible as a consequence rather than as a number. */
  const nextUp = $derived.by(() => {
    const c = waterfall.next();
    return c.kind === "use" ? c.label : null;
  });

  /** Which of the imported rows are still unsigned. Derived rather than stored,
   *  so the line clears itself as they are signed in — and as they are removed,
   *  since a row that has gone is not a row to say anything about. */
  const unsigned = $derived(
    imported.filter((l) => waterfall.list.some((a) => a.label === l && !a.signedIn)),
  );

  /** The window kinds worth offering a cap for on this account: the ones its
   *  allowance actually reports, plus any it already carries a cap for — so a
   *  cap set against a window the server has stopped mentioning stays visible
   *  and removable rather than becoming invisible and still in force. */
  function capKinds(label: string): string[] {
    const a = waterfall.allowances[label];
    const fromReport = a?.ok ? a.windows.map((w) => w.kind) : [];
    const acct = waterfall.list.find((x) => x.label === label);
    const fromCaps = Object.keys(acct?.caps ?? {});
    return [...new Set([...fromReport, ...fromCaps])];
  }

  function capOf(label: string, kind: string): number | null {
    const acct = waterfall.list.find((x) => x.label === label);
    const v = acct?.caps?.[kind];
    return typeof v === "number" ? v : null;
  }

  function usedOf(label: string, kind: string): number | null {
    const a = waterfall.allowances[label];
    if (!a?.ok) return null;
    return a.windows.find((w) => w.kind === kind)?.used ?? null;
  }

  function nameOf(label: string, kind: string): string {
    const a = waterfall.allowances[label];
    const w = a?.ok ? a.windows.find((x) => x.kind === kind) : null;
    return w ? windowSaid(w) : kind.replace(/_/g, " ");
  }

  async function setCap(label: string, kind: string, raw: string) {
    const acct = waterfall.list.find((x) => x.label === label);
    const caps: Record<string, number> = { ...(acct?.caps ?? {}) };
    const n = Number(raw);
    /* Blank clears the ceiling rather than setting zero — zero is a real and
       very different instruction ("never start work here"), so it has to be
       typed rather than arrived at by emptying a field. */
    if (raw.trim() === "" || !Number.isFinite(n)) delete caps[kind];
    else caps[kind] = Math.max(0, Math.min(100, Math.round(n)));
    await waterfall.setCaps(label, caps);
  }

  async function addAccount() {
    const label = naming.trim();
    if (!label) return;
    try {
      await waterfall.add(label);
      naming = "";
      say(`added ${label} — sign in to it next`);
    } catch (err) {
      say(String(err));
    }
  }

  async function signIn(label: string) {
    /* Cleared rather than appended to: a second attempt after a failure must
       not be read against the first one's output, or a dead URL and a spent
       fault would both still be on screen. */
    signinOut = { ...signinOut, [label]: "" };
    signinRunning = { ...signinRunning, [label]: true };
    pasting = { ...pasting, [label]: "" };
    try {
      await waterfall.signIn(label);
    } catch (err) {
      signinRunning = { ...signinRunning, [label]: false };
      say(String(err));
    }
  }

  /** Hand the code over. `codeFrom` takes either what the CLI asks for or the
   *  whole callback URL, which is the thing actually to hand in a browser. */
  async function paste(label: string) {
    const code = codeFrom(pasting[label] ?? "");
    if (!code) return;
    try {
      await invoke("paste_signin", { label, code });
      pasting = { ...pasting, [label]: "" };
      say("handed over — waiting for it to finish");
    } catch (err) {
      say(String(err));
    }
  }

  async function cancelSignin(label: string) {
    try {
      await invoke("cancel_signin", { label });
    } catch (err) {
      say(String(err));
    }
    signinRunning = { ...signinRunning, [label]: false };
  }

  async function openAuthorize(url: string) {
    try {
      await invoke("open_external", { url });
    } catch (err) {
      say(String(err));
    }
  }

  /* ── carrying the waterfall off the machine ─────────────────────────────
     Its own affordance, and deliberately not folded into anything else that
     exports: what this carries is the order and the ceilings, which is a
     different document with a different caveat from a wall's layout. The
     clipboard rather than a file, for `theme.ts`'s reasons — the text is small,
     the app has no filesystem plugin, and this is the idiom it already
     teaches. */

  async function exportAll() {
    if (!waterfall.list.length) return say("no accounts to copy");
    try {
      await navigator.clipboard.writeText(exportAccounts(waterfall.list));
      say(`copied ${waterfall.list.length}`);
    } catch {
      say("no clipboard");
    }
  }

  /** Create the rows a merge calls for, and put the whole order back. Returns
   *  a fault to say, or null.
   *
   *  Straight at the commands rather than through `waterfall`'s gestures, each
   *  of which refreshes — and a refresh reads every signed-in account's
   *  allowance over the network. Three accounts arriving would be a dozen of
   *  those passes for one paste, against an endpoint that has answered 429 to a
   *  single account polled on a minute. One refresh at the end reaches the same
   *  state and is the only reading anybody sees.
   *
   *  `add_account` is `ON CONFLICT DO NOTHING`, so a collision here would be
   *  silent — which is exactly why the rename and the match both happen in
   *  `mergeAccounts` before any of this, rather than being left to the store to
   *  absorb. Nothing here writes to a row the merge only *matched*: that row is
   *  the one you have been using, and a credential is all a matched document
   *  gets to offer it. */
  async function applyMerge(merge: Merge): Promise<string | null> {
    try {
      for (const a of merge.added) {
        await invoke("add_account", { label: a.label });
        /* Always, not only when it differs from what `add_account` chose. That
           default is "a tier of its own at the end", which is right for a row
           somebody typed and wrong for an import — `mergeAccounts` has already
           worked out which incoming rows shared a tier and where the lot of
           them lands, and letting the store's default win for some of them
           would flatten exactly the shape the document was carrying. */
        await invoke("set_account_priority", { label: a.label, priority: a.priority });
        if (Object.keys(a.caps).length > 0) {
          await invoke("set_account_caps", { label: a.label, caps: a.caps });
        }
        /* Only when it is off: a fresh row is on already, and `add_account` has
           just written that default. */
        if (!a.enabled) {
          await invoke("set_account_enabled", { label: a.label, enabled: false });
        }
      }
      await invoke("reorder_accounts", { labels: merge.order });
    } catch (err) {
      return String(err);
    } finally {
      /* Refreshed on the way out too. An import that failed halfway has still
         put rows in the store, and a panel that cannot see them is a panel you
         cannot clean up with. */
      await waterfall.refresh();
    }
    return null;
  }

  async function importAll() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return say("no clipboard");
    }
    const incoming = importAccounts(text);
    /* Zero is the answer for text that is not JSON, for a document with no
       accounts in it, and for one whose accounts were all fragments — from here
       those are the same event, and naming which would be guessing. */
    if (!incoming.length) return say(sayImported(0, 0));

    const merge = mergeAccounts(waterfall.list, incoming);
    const fault = await applyMerge(merge);
    if (fault) return say(fault);
    imported = merge.added.map((a) => a.label);
    renames = merge.renamed;
    /* Counted after the refresh, so it is the registry's answer rather than a
       guess: a label that matches a credential store already on this machine —
       signed in from a terminal, or left behind by a `remove`, which does not
       delete the store — lands genuinely usable, and "sign in to each" would be
       wrong about it. */
    const ready = imported.filter((l) =>
      waterfall.list.some((a) => a.label === l && a.signedIn),
    ).length;
    say(sayImported(merge.added.length, ready));
  }

  /* ── and carrying the sign-ins with them ────────────────────────────────
     A file rather than the clipboard, and its own row rather than a modifier on
     the buttons above, because the two documents are not the same kind of
     thing: one is safe to paste anywhere and one holds live credentials in
     plain text. Windows keeps a clipboard history and can sync it to another
     device, which is the whole argument. See `.claude/rules/accounts.md`. */

  /** Every account whose store has something to carry. */
  const signable = $derived(waterfall.list.filter((a) => a.signedIn).map((a) => a.label));

  async function saveFile() {
    if (carrying) return;
    carrying = true;
    try {
      /* Imported lazily, as the rest of the app does it: the dialog plugin
         pulls in a chunk nothing on the first paint needs. */
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        title: "Carry these accounts off",
        defaultPath: "accounts.volery-accounts.json",
        filters: [{ name: "volery accounts", extensions: ["volery-accounts.json", "json"] }],
      });
      if (typeof picked !== "string") return;
      /* The extension is insisted on rather than corrected — `accounts.rs`
         refuses anything else, and silently renaming what somebody typed is a
         file saved where they cannot find it. */
      const path = picked.toLowerCase().endsWith(".volery-accounts.json")
        ? picked
        : `${picked.replace(/\.json$/i, "")}.volery-accounts.json`;
      const saved = await invoke<{ signins: string[]; missing: string[] }>(
        "save_accounts_file",
        {
          path,
          /* The object rather than text, and `withSignIns` so the note inside
             the file tells the truth about what is in it. Rust splices the
             credentials in after this and never touches that line. */
          doc: accountsDoc(waterfall.list, { withSignIns: signable.length > 0 }),
          signins: signable,
        },
      );
      say(sayCarried(saved.signins, saved.missing, baseName(path)));
    } catch (err) {
      say(String(err));
    } finally {
      carrying = false;
    }
  }

  async function loadFile() {
    if (carrying) return;
    carrying = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: "Accounts to bring in",
        filters: [{ name: "volery accounts", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;

      /* Rust takes the credentials out before this sees the document and parks
         them; `text` is the same shape a paste has, so it goes through the same
         tested reader rather than a second path that could drift from it. */
      const loaded = await invoke<{ text: string; signins: unknown[] }>(
        "load_accounts_file",
        { path: picked },
      );
      carried = cleanSignIns(loaded.signins);
      const incoming = importAccounts(loaded.text);
      if (incoming.length === 0 && carried.length === 0) {
        return say(`there is nothing in ${baseName(picked)}`);
      }

      /* `carrying` here is the *document's* labels that came with a credential.
         A colliding one is the same subscription arriving again, so it is
         matched to the row already here instead of added beside it — see
         `mergeAccounts`. */
      const merge = mergeAccounts(waterfall.list, incoming, {
        carrying: carried.map((s) => s.label),
      });
      const fault = await applyMerge(merge);
      if (fault) return say(fault);
      imported = merge.added.map((a) => a.label);
      renames = merge.renamed;

      /* Asked after the rows exist, so `signedIn` is the truth about the store
         rather than about the document — a label that had a store lying around
         unregistered arrives already signed in, and its credential deserves the
         same protection as any other. */
      const locals = cleanSignIns(
        await invoke<unknown[]>("signin_ages", {
          labels: waterfall.list.map((a) => a.label),
        }),
      );
      const plan = planSignins(carried, merge.landings, waterfall.list, locals);
      let done = 0;
      for (const one of plan) {
        if (one.how !== "now") continue;
        try {
          await invoke("install_signin", { label: one.label, from: one.from });
          done++;
        } catch (err) {
          say(String(err));
        }
      }
      waiting = plan.filter((one) => one.how === "ask");
      carriedFrom = baseName(picked);
      await waterfall.refresh();

      const rows = merge.added.length > 0 ? `took ${merge.added.length} · ` : "";
      say(`${rows}${sayInstalled(done, waiting.length)}`);
    } catch (err) {
      say(String(err));
    } finally {
      carrying = false;
    }
  }

  /** Take a sign-in the plan would not install on its own. */
  async function useCarried(one: Install) {
    try {
      await invoke("install_signin", { label: one.label, from: one.from });
      waiting = waiting.filter((x) => x.from !== one.from);
      await waterfall.refresh();
      say(`${one.label} is signed in`);
    } catch (err) {
      say(String(err));
    }
  }

  /** Stop saying anything about the last import, and forget what it parked.
   *  Dropping the parked credentials is the point rather than a tidy-up: this
   *  button is how you say you do not want the ones still waiting. */
  function dismiss() {
    imported = [];
    renames = [];
    waiting = [];
    carried = [];
    carriedFrom = "";
    void invoke("drop_carried").catch(() => {});
  }

  async function install() {
    installing = true;
    try {
      say(await waterfall.install());
    } catch (err) {
      say(String(err));
    } finally {
      installing = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- mousedown rather than click, so letting go of a drag that started inside the
     panel does not dismiss it — the same call Themes.svelte makes. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="panel"
    onmousedown={(e) => {
      e.stopPropagation();
      arming = null;
    }}
    role="dialog"
    aria-label="accounts"
    tabindex="-1"
  >
    <div class="head">
      <span class="mark">accounts</span>
      <span class="grow"></span>
      {#if note}<span class="said">{note}</span>{/if}
      <button class="x" onclick={onclose} title="close">✕</button>
    </div>

    <p class="note">
      Work falls through these in priority order — a whole priority is spent before the next one
      is touched. Accounts sharing a priority share the work: whichever has spent least of its
      allowance takes the next turn, so they run down together. A cap is <b>yours</b>: the
      account's own limit still applies underneath it, and nothing here can spend past that.
    </p>

    <!-- ── the machine ───────────────────────────────────────────────── -->
    <div class="cli" class:bad={waterfall.claude?.state === "missing"}>
      {#if !waterfall.claude}
        <span class="dim">looking for claude code…</span>
      {:else if waterfall.claude.state === "ready"}
        <span class="ok">claude code {waterfall.claude.version}</span>
        {#if !waterfall.claude.onPath}
          <span class="warn">
            not on PATH — found via {waterfall.claude.foundIn}, and spawned by full path
          </span>
        {/if}
      {:else}
        <span class="warn">claude code was not found on this machine</span>
        <button class="go" onclick={install} disabled={installing}>
          {installing ? "installing…" : "install it"}
        </button>
      {/if}
    </div>

    <div class="body">
      {#if !waterfall.ready}
        <p class="empty">reading the registry…</p>
      {:else if waterfall.list.length === 0}
        <p class="empty">
          No accounts yet. Add one below and sign in to it — until then every card spawns as
          whoever <code>claude</code> is signed in as, which is exactly how it worked before.
        </p>
      {/if}

      {#each bands as band (band.priority)}
        <!-- ── one priority ──────────────────────────────────────────────
             Drawn in `--edge` and nothing else: a band is structure, like the
             wall's other furniture, and colour here is reserved for status.
             The header carries the two facts the rows cannot show on their own
             — whether this tier shares its work, and what has to be spent
             before it is touched at all. -->
        <div class="band">
          <div class="bandhead">
            <span class="tiermark">priority {band.priority}</span>
            <span class="tierwhat">{sayTier(band.rows.length, band.above)}</span>
          </div>

          <div class="bandrows">
            {#each band.rows as { account, standing }, i (account.label)}
              <div class="acct" class:off={!account.enabled} class:next={account.label === nextUp}>
                <div class="row">
                  <span class="label">{account.label}</span>

                  {#if account.label === nextUp}
                    <span class="tag next-tag">next</span>
                  {/if}

                  {#if standing.state === "ready"}
                    {#if standing.unmeasured}
                      <!-- Ready, and saying so, but the ceiling you set cannot be
                           checked against a reading nobody has. Its own tag rather
                           than a dimmed "ready": the difference is whether your caps
                           are in force, which is not a detail. -->
                      <span class="tag unmeasured">ready · unmeasured</span>
                      <span class="dim">{sayUnmeasured(standing.unmeasured)}</span>
                    {:else}
                      <span class="tag ready">ready</span>
                    {/if}
                  {:else if standing.state === "blocked"}
                    <span class="tag held">{sayBlocked(standing.blockers)}</span>
                    {#if standing.availableAt !== null}
                      <span class="dim">back in {until(standing.availableAt - now)}</span>
                    {:else}
                      <span class="dim">no reset named</span>
                    {/if}
                  {:else}
                    <span class="tag bad">{standing.why}</span>
                  {/if}

                  <span class="grow"></span>

                  <!-- Which tier, typed rather than nudged. The user's own words for
                       this feature were "assign priority 1 to both my company
                       accounts", so the control is the number they said: one press
                       reaches any arrangement, and there is none of the ambiguity a
                       pair of move-me-a-band-over arrows has about whether it means
                       "join the band below" or "make a new one". -->
                  <label class="tierset" title="which priority this account is in">
                    <span class="tierlab">priority</span>
                    <input
                      class="tierin"
                      type="number"
                      min="1"
                      value={account.priority}
                      onchange={(e) => setTier(account.label, e.currentTarget.value)}
                    />
                  </label>
                  <!-- Within the band only. Across one these would write two ranks
                       and change nothing visible, since the priorities still decide
                       the order — see `waterfall.move`. -->
                  <button
                    class="chip"
                    disabled={i === 0}
                    onclick={() => waterfall.move(account.label, -1)}
                    title="earlier inside this priority">↑</button>
                  <button
                    class="chip"
                    disabled={i === band.rows.length - 1}
                    onclick={() => waterfall.move(account.label, 1)}
                    title="later inside this priority">↓</button>
                  <button
                    class="chip"
                    onclick={() => waterfall.setEnabled(account.label, !account.enabled)}
                    title={account.enabled ? "stop using this account" : "use this account again"}
                  >{account.enabled ? "on" : "off"}</button>
                </div>

                <!-- ── the ceilings ─────────────────────────────────────────── -->
                {#if account.signedIn}
                  <div class="caps">
                    {#each capKinds(account.label) as kind (kind)}
                      {@const used = usedOf(account.label, kind)}
                      {@const cap = capOf(account.label, kind)}
                      <label class="cap">
                        <span class="capname">{nameOf(account.label, kind)}</span>
                        <span class="used">{used === null ? "—" : pct(used)}</span>
                        <span class="of">stop at</span>
                        <input
                          class="capin"
                          type="number"
                          min="0"
                          max="100"
                          placeholder="—"
                          value={cap ?? ""}
                          onchange={(e) => setCap(account.label, kind, e.currentTarget.value)}
                        />
                        <span class="pc">%</span>
                      </label>
                    {:else}
                      <span class="dim">no windows read yet</span>
                    {/each}
                  </div>
                {/if}

                <div class="acts">
                  {#if !account.signedIn}
                    <button
                      class="go"
                      disabled={signinRunning[account.label]}
                      onclick={() => signIn(account.label)}
                    >{signinRunning[account.label] ? "signing in…" : "sign in"}</button>
                  {:else}
                    <button
                      class="chip"
                      onclick={() => signIn(account.label)}
                      title="sign in again, replacing this account's credential"
                    >
                      sign in again
                    </button>
                    <button
                      class="chip danger"
                      onmousedown={(e) => e.stopPropagation()}
                      onclick={() => {
                        if (arming === `signout:${account.label}`) {
                          void waterfall.signOut(account.label);
                          arming = null;
                          say(`signed ${account.label} out`);
                        } else arming = `signout:${account.label}`;
                      }}
                    >{arming === `signout:${account.label}` ? "really sign out?" : "sign out"}</button>
                  {/if}
                  <span class="grow"></span>
                  <button
                    class="chip danger"
                    onmousedown={(e) => e.stopPropagation()}
                    onclick={() => {
                      if (arming === `remove:${account.label}`) {
                        void waterfall.remove(account.label);
                        arming = null;
                        say(`removed ${account.label} — it is still signed in`);
                      } else arming = `remove:${account.label}`;
                    }}
                  >{arming === `remove:${account.label}` ? "really remove?" : "remove"}</button>
                </div>

                <!-- ── a sign-in in progress ──────────────────────────────────
                     No terminal: `claude auth login` runs on pipes and opens the
                     browser itself, so what is left to draw is the waiting, the URL
                     for a browser that did not open, and the paste field for the
                     manual path. Shown while running and kept after a failure, since
                     the failure is the thing worth reading. -->
                {#if signinRunning[account.label] || progressOf(account.label).fault}
                  {@const p = progressOf(account.label)}
                  <div class="signin">
                    {#if p.fault}
                      <span class="tag bad">{p.fault}</span>
                    {:else if p.prompting}
                      <span class="dim">
                        waiting in the browser — if it asks you for a code, paste it here
                      </span>
                    {:else if p.opened}
                      <span class="dim">a browser is open — finish signing in there</span>
                    {:else}
                      <span class="dim">starting…</span>
                    {/if}

                    {#if signinRunning[account.label]}
                      <div class="signin-row">
                        {#if p.url}
                          <!-- The browser was opened by the CLI. This is for when it
                               could not be — and it is a button rather than a link
                               because a webview must not navigate itself to it. -->
                          <button class="chip" onclick={() => openAuthorize(p.url!)}>
                            open the sign-in page
                          </button>
                        {/if}
                        <input
                          class="codein"
                          placeholder="paste the code, or the whole callback url"
                          value={pasting[account.label] ?? ""}
                          oninput={(e) =>
                            (pasting = { ...pasting, [account.label]: e.currentTarget.value })}
                          onkeydown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void paste(account.label);
                            }
                          }}
                        />
                        <button
                          class="chip"
                          disabled={!(pasting[account.label] ?? "").trim()}
                          onclick={() => paste(account.label)}
                        >hand it over</button>
                        <span class="grow"></span>
                        <button class="chip" onclick={() => cancelSignin(account.label)}>stop</button>
                      </div>
                      {#if (pasting[account.label] ?? "").trim() && !looksLikeCode(pasting[account.label] ?? "")}
                        <!-- A hint and never a block: this is a guess about a format
                             the CLI defines, and a wrong guess must not be able to
                             stop a sign-in finishing. -->
                        <span class="dim">
                          that does not look like a code — it is usually two parts joined by a #
                        </span>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}

      <!-- ── accounts signed in but not in the order ───────────────────── -->
      {#if waterfall.unregistered.length > 0}
        <div class="loose">
          <span class="dim">signed in elsewhere, not in the order:</span>
          {#each waterfall.unregistered as label (label)}
            <button class="chip" onclick={() => waterfall.add(label)}>add {label}</button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- ── what the last import left behind ──────────────────────────────
         Up for as long as it is true rather than in the note that fades, and
         achromatic: an imported account is not a status the wall is waiting on,
         it is an ordinary row with the one thing an export cannot carry
         missing. The rows themselves already say "not signed in" where it
         counts; this says why they all do at once, and what the rename did. -->
    {#if unsigned.length > 0 || renames.length > 0 || waiting.length > 0}
      <div class="landed">
        {#if unsigned.length > 0}
          <span class="dim">{sayUnsigned(unsigned)}</span>
        {/if}
        {#each renames as r (r.to)}
          <span class="dim">
            {r.from} was already here — the pasted one arrived as {r.to}, with no credential
            behind it
          </span>
        {/each}

        <!-- A carried sign-in that will not go in on its own: the file's is
             older than what is here, the same age, or of an age nothing can
             compare. Armed, because replacing a working credential with an
             older one costs the browser round trip this whole thing exists to
             save. -->
        {#each waiting as one (one.from)}
          {@const what = carried.find((c) => c.label === one.from)}
          <span class="dim">
            {one.label}: {one.why}{#if what} · the file's has {sayLife(what, now)}{/if}
          </span>
          <button
            class="chip danger"
            onmousedown={(e) => e.stopPropagation()}
            onclick={() => {
              if (arming === `use:${one.from}`) {
                arming = null;
                void useCarried(one);
              } else arming = `use:${one.from}`;
            }}
          >{arming === `use:${one.from}`
              ? "really replace it?"
              : "use the file's sign-in"}</button>
        {/each}

        <button class="chip" onclick={dismiss} title="stop saying this">ok</button>
      </div>
    {/if}

    <div class="foot">
      <input
        class="namein"
        placeholder="a name for the account — work, perso, team"
        bind:value={naming}
        onkeydown={(e) => e.key === "Enter" && addAccount()}
      />
      <!-- No spacer: `.namein` is already `flex: 1`, and a second flexing child
           would take half the row off the field you type a name into. -->
      <button class="go" onclick={addAccount} disabled={!naming.trim()}>add</button>
      <button
        class="chip"
        onclick={exportAll}
        title="the order and your caps, to the clipboard — never a credential"
      >export</button>
      <button
        class="chip"
        onclick={importAll}
        title="a waterfall from the clipboard, renamed on a clash and appended to this order"
      >import</button>
    </div>

    <!-- ── the sign-ins themselves ───────────────────────────────────────
         Its own row, below the clipboard pair and deliberately not folded into
         it. What goes in this file is three live credentials; what goes on the
         clipboard never is. Armed on the way out, and the warning is up while
         it is armed rather than in a tooltip nobody opens. -->
    <div class="carry">
      <span class="dim">sign-ins</span>
      <button
        class="chip danger"
        disabled={carrying || signable.length === 0}
        onmousedown={(e) => e.stopPropagation()}
        onclick={() => {
          if (arming === "carry") {
            arming = null;
            void saveFile();
          } else arming = "carry";
        }}
        title="the order, the ceilings and the credentials, to a file you pick"
      >{arming === "carry" ? "yes, write the file" : "save to a file…"}</button>
      <button
        class="chip"
        disabled={carrying}
        onclick={loadFile}
        title="an accounts file from another machine"
      >{carrying ? "working…" : "load a file…"}</button>
      {#if arming === "carry"}
        <span class="caution">{sayFileWarning(signable.length)}</span>
      {:else if signable.length === 0}
        <span class="dim">nothing is signed in here yet, so there is nothing to carry</span>
      {:else if carriedFrom}
        <span class="dim">from {carriedFrom}</span>
      {/if}
    </div>

    {#if waterfall.fault}
      <p class="fault">{waterfall.fault}</p>
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

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: min(86ch, 94vw);
    max-height: 84vh;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.7rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-dim);
  }
  .grow {
    flex: 1;
  }
  .said {
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--paper-mute);
  }
  .x {
    border: 0;
    background: none;
    color: var(--paper-mute);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--paper-mute);
  }

  .cli {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    font-family: var(--util);
    font-size: 0.74rem;
  }
  .cli.bad {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--rule));
  }
  .ok {
    color: var(--paper-dim);
  }
  .warn {
    color: var(--st-fail);
  }

  /* The gap between bands is deliberately wider than the gap inside one.
     Proximity is the strongest grouping cue there is and it costs no ink, which
     matters here because the alternatives are all colour or weight and neither
     is available to structure on this wall. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    overflow-y: auto;
    padding-right: 0.2rem;
  }
  .empty {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--paper-mute);
  }

  .acct {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.45rem 0.55rem;
    background: var(--raised);
  }
  .acct.off {
    opacity: 0.55;
  }
  .acct.next {
    border-color: color-mix(in srgb, var(--st-work) 45%, var(--rule));
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }
  /* A band is structure, so it is drawn the way the wall draws furniture: one
     rule in `--edge` down its left and nothing else. No fill, no colour, no
     border round the group — the accounts inside already have boxes, and a box
     inside a box reads as two things rather than as a heading over a list. */
  .band {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  /* The header is a section rule with words on it — the quietest way to say
     "a group starts here" that does not need a box. The hairline runs to the
     right margin so the band reads as a full-width division of the list rather
     than as a caption that happens to sit above some rows. */
  .bandhead {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .bandhead::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--edge);
  }
  /* And the rows are held together by one rule down their left, which is what
     carries the band's *extent* — the header says a group starts, this says
     how far it goes. Indented enough to clear the account boxes' own borders,
     which are `--rule` and lighter than this: a group rule the same weight as
     its members' would read as a fourth box rather than as the thing holding
     them. */
  .bandrows {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-left: 1px solid var(--edge);
    padding-left: 0.6rem;
    margin-left: 0.15rem;
  }
  .tiermark {
    font-family: var(--util);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--paper-dim);
  }
  .tierwhat {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }

  .tierset {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.68rem;
  }
  .tierlab {
    color: var(--paper-faint);
  }
  .tierin {
    /* `.capin`'s arithmetic, two digits narrower: nobody has ninety tiers, and
       the spinners go for the same reason — Chromium reserves room for them on
       hover, which clips the figure in a field this size. */
    width: 4.5ch;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.05rem 0.2rem;
    text-align: right;
    appearance: textfield;
  }
  .tierin::-webkit-outer-spin-button,
  .tierin::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }
  .label {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper);
  }

  .tag {
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    border: 1px solid var(--rule);
    color: var(--paper-mute);
  }
  .next-tag {
    border-color: color-mix(in srgb, var(--st-work) 55%, var(--rule));
    color: var(--st-work);
  }
  .ready {
    color: var(--paper-dim);
  }
  /* Achromatic on purpose, where amber would have been the obvious reach:
     colour here is reserved for status, and amber already means asking. An
     account taking work without a reading is not a state the wall is waiting
     on — it is an ordinary ready with one guarantee missing — so it is drawn as
     a ready whose edge is not solid. */
  .unmeasured {
    border-style: dashed;
    color: var(--paper-mute);
  }
  .held {
    border-color: color-mix(in srgb, var(--st-ask) 50%, var(--rule));
    color: var(--st-ask);
  }
  .bad {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--rule));
    color: var(--st-fail);
  }
  .dim {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }

  .caps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.9rem;
    padding-left: 1.5ch;
  }
  .cap {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-mute);
  }
  .capname {
    color: var(--paper-dim);
  }
  .used {
    color: var(--paper);
    min-width: 3.5ch;
    text-align: right;
  }
  .of {
    color: var(--paper-faint);
  }
  .capin {
    /* Three digits, and `box-sizing: border-box` means the border and the
       padding come out of this — so the figure gets what is left, not the
       whole of it. The spinners go because Chromium reserves room for them
       the moment the field is hovered, which is what clipped `100`; nobody
       nudges a ceiling one point at a time anyway. */
    width: 7ch;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    text-align: right;
    appearance: textfield;
  }
  .capin::-webkit-outer-spin-button,
  .capin::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }
  .pc {
    color: var(--paper-faint);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    padding-left: 1.5ch;
  }

  .chip {
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--rule);
    border-radius: 3px;
    background: none;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .chip:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--edge);
  }
  .chip:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .danger:hover:not(:disabled) {
    color: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--rule));
  }

  .go {
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--raised);
    color: var(--paper);
    cursor: pointer;
  }
  .go:hover:not(:disabled) {
    border-color: var(--paper-faint);
  }
  .go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .loose {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.1rem;
  }

  /* The sign-ins' own row, ruled off from the clipboard pair above it because
     the two carry different things and the difference is the point. */
  .carry {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    border-top: 1px dashed var(--rule);
    padding-top: 0.45rem;
  }
  /* The one place in this panel that is loud, and it earns it: everything else
     here can be undone by pressing something else, and a plaintext credential
     written into a synced folder cannot. Rust, which is what `.bad` and the
     danger chips already mean — not a new colour. */
  .caution {
    flex: 1;
    min-width: 18rem;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.45;
    color: var(--st-fail);
  }

  /* What the last import left behind. Dashed like `.signin`, which is the other
     thing in this panel that is up only while something is in an unfinished
     state, and achromatic because colour here is reserved for status. */
  .landed {
    display: flex;
    align-items: center;
    gap: 0.4rem 0.6rem;
    flex-wrap: wrap;
    border: 1px dashed var(--rule);
    border-radius: 4px;
    padding: 0.3rem 0.45rem;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-top: 1px solid var(--rule);
    padding-top: 0.5rem;
  }
  .namein {
    flex: 1;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.74rem;
    padding: 0.2rem 0.4rem;
  }

  /* ── a sign-in in progress ─────────────────────────────────────────── */

  .signin {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.3rem;
    padding-top: 0.35rem;
    border-top: 1px dashed var(--rule);
  }
  .signin-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  /* Wider than it looks like it needs to be: what gets pasted here is often a
     whole callback URL rather than the short code, and a field that shows eight
     characters of one is a field you cannot check before pressing the button. */
  .codein {
    flex: 1;
    min-width: 12rem;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.72rem;
    padding: 0.15rem 0.35rem;
  }

  .fault {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--st-fail);
  }
</style>
