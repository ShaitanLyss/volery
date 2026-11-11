<script lang="ts">
  /* The prompts tab (§11.11, §11.12): the trace, the hall, and the vault's own
   * face.
   *
   * One drawing in two skins. The room's tab is an instrument: a dense list, a
   * detail pane beside it, and the hall under both. The page's tab is the same
   * rows read as a document: a 64rem measure, the book's face for prose, the
   * ground the shell already replaces, and more air between sections. `v` swaps
   * them and the tab is the same tab (§11.15).
   *
   * **The body is the one thing that is not a fact**, and its whole path is
   * here: `prompt_body`, only when the vault is open, straight into this
   * component's state, dropped when the selection moves, the vault locks, or the
   * surface closes. It is never stored, never in a URL, never in a log, and
   * never in the fixture's "real" path — the fixture's bodies are invented.
   * Locking clears it on purpose: a pane holding unsealed words behind a lock
   * would be a lock that only changed the icon.
   *
   * **The passphrase is never kept.** It lives in an input's own state while
   * being typed, is cleared in a `finally` whether the command took it or not,
   * and no code path copies it anywhere else — not a store, not localStorage,
   * not a fault string. `password` fields, so it is not drawn either.
   *
   * Keyboard, because the house rule is that the mouse is optional: `j`/`k` or
   * the arrows walk the rows, Enter opens the detail, Escape closes it (or a
   * confirmation, or leaves the surface), `p` marks or unmarks the selected
   * prompt, `o` the kind correction, `u` the passphrase field, `l` locks, `f`
   * the filters, `[`/`]` page a busy day. Every control is also a native
   * control, so Tab reaches it.
   */
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { count, left } from "./usage";
  import { pct } from "./analytics";
  import {
    PROMPT_KINDS,
    addDays,
    bodyNote,
    bodyReadable,
    bodyTag,
    bodyTagLabel,
    cardLabel,
    costLabel,
    dayKey,
    dayLabel,
    daysOf,
    effectiveKind,
    filterFavourites,
    filterPrompts,
    forgetSaid,
    groupByDay,
    hallProjects,
    hallTags,
    hallYears,
    isCorrected,
    lengthLabel,
    noteLabel,
    orderFavourites,
    pageOf,
    projectsOf,
    redactionLabel,
    resetSaid,
    sealSaid,
    startOfDay,
    statsOf,
    traceWindow,
    vaultReady,
    type FavouriteRow,
    type HallSort,
    type PromptBody,
    type PromptReader,
    type PromptRow,
    type VaultState,
  } from "./analyticstrace";
  import type { Presentation } from "./analyticpage";

  let {
    reader,
    presentation,
  }: {
    reader: PromptReader;
    presentation: Presentation;
  } = $props();

  /* ── what came back ──────────────────────────────────────────────────── */

  let rows = $state<PromptRow[]>([]);
  let hall = $state<FavouriteRow[]>([]);
  let vault = $state<VaultState | null>(null);
  let vaultAt = $state(0);
  let loading = $state(true);
  let fault = $state<string | null>(null);
  let readAt = $state(0);
  let now = $state(Date.now());
  /** True once the hall has pulled a day older than the trace window in; the
   *  strip then says "recorded" rather than "this week". */
  let stretched = $state(false);

  /* ── the filters, which are facts ────────────────────────────────────── */

  let filter = $state({ kind: "", project: "", day: "" });
  let filters = $state<HTMLElement>();

  const filtered = $derived(
    filterPrompts(rows, {
      kind: filter.kind || null,
      project: filter.project || null,
      day: filter.day || null,
    }),
  );
  const days = $derived(groupByDay(filtered, now));
  const stats = $derived(statsOf(filtered));
  const projects = $derived(projectsOf(rows));
  const dayChoices = $derived(daysOf(rows, now));
  const today = $derived(filtered.filter((r) => dayKey(r.at) === dayKey(now)).length);

  /** Each day's page, by day key. A day that is not here is on page 0, which is
   *  what makes a filter change start at the newest end. */
  const PAGE = 40;
  let pages = $state<Record<string, number>>({});

  const shown = $derived(
    days.map((d) => ({ ...d, page: pageOf(d.rows, pages[d.day] ?? 0, PAGE) })),
  );
  const flat = $derived(shown.flatMap((d) => d.page.rows));

  /* ── the selection and its body ──────────────────────────────────────── */

  let picked = $state<{ host: string; promptId: string } | null>(null);
  const keyOf = (r: { host: string; promptId: string }) => `${r.host}/${r.promptId}`;
  const selected = $derived.by(() => {
    const at = picked;
    return at ? (rows.find((r) => r.host === at.host && r.promptId === at.promptId) ?? null) : null;
  });

  let body = $state<PromptBody | null>(null);
  let bodyBusy = $state(false);
  let bodyFault = $state<string | null>(null);
  /** Which row the in-flight body read was for. A selection that moved while
   *  the command was out must not land another prompt's words in this pane. */
  let bodyFor = "";

  async function readBody(row: PromptRow) {
    const id = keyOf(row);
    bodyFor = id;
    bodyBusy = true;
    bodyFault = null;
    try {
      const answer = await reader.body(row.host, row.promptId);
      if (bodyFor === id) body = answer;
    } catch (e) {
      if (bodyFor === id) bodyFault = e instanceof Error ? e.message : String(e);
    } finally {
      if (bodyFor === id) bodyBusy = false;
    }
  }

  function select(row: PromptRow) {
    /* Clicking the row that is already open is not a new selection: clearing
       the body here would drop the words and then decline to fetch them again,
       leaving an open pane that says a sealed body is unread. */
    if (picked && keyOf(picked) === keyOf(row)) return;
    picked = { host: row.host, promptId: row.promptId };
    body = null;
    bodyFault = null;
    bodyFor = "";
    bodyBusy = false;
    if (bodyReadable(row, openFor(row))) void readBody(row);
  }

  function closeDetail() {
    const was = picked ? keyOf(picked) : "";
    picked = null;
    body = null;
    bodyFault = null;
    bodyFor = "";
    /* Removing the pane can take the focused control with it, and a focus that
       disappears fires no event — the shell's `holdFocus` only hears `focusin`.
       Put it back on the row that was open. */
    void tick().then(() => {
      const row = was ? listHost?.querySelector<HTMLElement>(`[data-key="${was}"]`) : null;
      (row ?? listHost)?.focus();
    });
  }

  /* A lock must take the words with it. The shell unmounts this whole component
     when the surface closes, which drops the same state; this is the mid-session
     lock and the idle expiry. */
  $effect(() => {
    if (!unlocked && body !== null) body = null;
  });

  /* ── the vault ───────────────────────────────────────────────────────── */

  const unlocked = $derived(vaultReady(vault));

  /* One wall may hold several vaults and open only some of them (§3.8), so a
     sealed body is readable when **its** vault is open, not when any is. A
     `locked` body has no vault yet, and what it waits on is the active one,
     which is why that case asks the global reading instead. */
  function openFor(row: { bodyState: string; vaultId: string }): boolean {
    if (row.bodyState === "locked") return unlocked;
    return Boolean(vault?.vaults.some((v) => v.vaultId === row.vaultId && v.unlocked));
  }

  let tickNow = $state(Date.now());

  const idleLeft = $derived(
    vault && vault.idleMs !== null ? Math.max(0, vault.idleMs - (tickNow - vaultAt)) : null,
  );

  /* The countdown is a lifetime about a secret, so it is a timer of its own
     while the key is in memory and nothing otherwise. It reads no store: the
     key's own expiry, in Rust, is the truth, and this only says how long the
     face has left before the next command will find it locked. */
  $effect(() => {
    if (!unlocked) return;
    const t = setInterval(() => (tickNow = Date.now()), 1_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    if (!unlocked || idleLeft === null || idleLeft > 0) return;
    vault = vault
      ? {
          ...vault,
          active: null,
          idleMs: null,
          vaults: vault.vaults.map((v) => ({ ...v, unlocked: false })),
        }
      : vault;
    body = null;
    /* A note is sealed text too. An expiry that only took the body would leave
     * the hall's notes on screen behind a lock that says locked. */
    hall = hall.map((f) => (f.note ? { ...f, note: null, noteLocked: true } : f));
    vaultSaid = "the vault locked itself after fifteen minutes idle";
  });

  let pass = $state("");
  let passAgain = $state("");
  let vaultBusy = $state(false);
  let vaultFault = $state<string | null>(null);
  let vaultSaid = $state<string | null>(null);
  let armedForget = $state(false);
  let resetStage = $state(0);
  let passField = $state<HTMLInputElement>();

  async function vaultDo(work: () => Promise<void>) {
    vaultBusy = true;
    vaultFault = null;
    vaultSaid = null;
    try {
      await work();
    } catch (e) {
      vaultFault = e instanceof Error ? e.message : String(e);
    } finally {
      vaultBusy = false;
      /* The field is cleared whether the command took the passphrase or not,
         and it is cleared *after* the call, so nothing needs to hold it. */
      pass = "";
      passAgain = "";
    }
  }

  async function create() {
    const min = vault?.minPassphrase ?? 12;
    if (pass.length < min) {
      vaultFault = `a passphrase must be at least ${min} characters, and this one is ${pass.length}`;
      return;
    }
    if (pass !== passAgain) {
      vaultFault = "the two passphrases do not match";
      return;
    }
    await vaultDo(async () => {
      vault = await reader.createVault(pass);
      vaultAt = Date.now();
      tickNow = vaultAt;
      vaultSaid = "vault created and open. new bodies will be sealed as they are recorded";
      await reloadRows();
    });
  }

  async function unlock() {
    if (!pass) {
      vaultFault = "the passphrase is what opens the vault, and the field is empty";
      return;
    }
    await vaultDo(async () => {
      vault = await reader.unlockVault(pass);
      vaultAt = Date.now();
      tickNow = vaultAt;
      vaultSaid = "unlocked. the bodies held here are readable until it is locked";
      await reloadRows();
      await reloadHall();
      if (selected && bodyReadable(selected, openFor(selected))) void readBody(selected);
    });
  }

  async function lock() {
    await vaultDo(async () => {
      vault = await reader.lockVault();
      vaultAt = Date.now();
      body = null;
      /* Re-read the hall with the key gone, so a note that was on screen is
       * `sealed` a moment later. Dropping the body and keeping the notes would
       * be a lock that changed one of its two texts. */
      await reloadHall();
      vaultSaid = "locked. the counts stay, and the bodies are opaque again";
    });
  }

  async function seal() {
    await vaultDo(async () => {
      const report = await reader.sealPending();
      vaultSaid = sealSaid(report);
      vault = await reader.vault();
      vaultAt = Date.now();
      await reloadRows();
      /* Sealing moves a body's state, and the hall draws the same fact. */
      await reloadHall();
    });
  }

  async function forget() {
    if (!armedForget) {
      armedForget = true;
      resetStage = 0;
      vaultSaid = null;
      return;
    }
    armedForget = false;
    await vaultDo(async () => {
      const report = await reader.forget();
      vaultSaid = forgetSaid(report);
      vault = await reader.vault();
      vaultAt = Date.now();
      body = null;
      await reloadRows();
      await reloadHall();
    });
  }

  async function reset() {
    armedForget = false;
    if (resetStage < 2) {
      resetStage += 1;
      vaultSaid = null;
      return;
    }
    resetStage = 0;
    await vaultDo(async () => {
      const report = await reader.resetVault(true);
      vaultSaid = resetSaid(report);
      vault = await reader.vault();
      vaultAt = Date.now();
      body = null;
      await reloadRows();
      await reloadHall();
    });
  }

  function disarm() {
    armedForget = false;
    resetStage = 0;
  }

  const bodyCounts = $derived(vault?.bodies ?? { sealed: 0, locked: 0, withheld: 0, deleted: 0, none: 0 });

  /* ── the kind correction ─────────────────────────────────────────────── */

  let kindField = $state<HTMLSelectElement>();
  let correctFault = $state<string | null>(null);

  async function correct(kind: string) {
    if (!selected) return;
    correctFault = null;
    try {
      await reader.overrideKind(selected.host, selected.promptId, kind);
      await reloadRows();
      await reloadHall();
    } catch (e) {
      correctFault = e instanceof Error ? e.message : String(e);
    }
  }

  /* ── the hall ────────────────────────────────────────────────────────── */

  let hallFilter = $state({ tag: "", project: "", kind: "", year: "" });
  let hallSort = $state<HallSort>("date");
  const tags = $derived(hallTags(hall));
  const hallProjectChoices = $derived(hallProjects(hall));
  const years = $derived(hallYears(hall));
  const gallery = $derived(
    orderFavourites(
      filterFavourites(hall, {
        tag: hallFilter.tag || null,
        project: hallFilter.project || null,
        kind: hallFilter.kind || null,
        year: hallFilter.year ? Number(hallFilter.year) : null,
      }),
      hallSort,
    ),
  );

  let favTitle = $state("");
  let favTags = $state("");
  let favNote = $state("");
  let favSaid = $state<string | null>(null);
  let favFault = $state<string | null>(null);
  let titleField = $state<HTMLInputElement>();
  let formFor = "";

  const kept = $derived.by(() => {
    const at = picked;
    return at ? (hall.find((f) => f.host === at.host && f.promptId === at.promptId) ?? null) : null;
  });

  /* The form follows the selection, not every hall change: saving a favourite
     updates the hall, and re-seeding the fields from it would wipe what you
     just typed. */
  $effect(() => {
    const id = picked ? keyOf(picked) : "";
    if (id === formFor) return;
    formFor = id;
    favTitle = kept?.title ?? "";
    favTags = kept?.tags.join(", ") ?? "";
    favNote = "";
    favSaid = null;
    favFault = null;
  });

  async function keep() {
    if (!selected) return;
    favFault = null;
    favSaid = null;
    try {
      await reader.keepFavourite({
        host: selected.host,
        promptId: selected.promptId,
        title: favTitle,
        tags: favTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        note: favNote.trim() ? favNote : null,
      });
      favSaid = "kept in the hall";
      await reloadHall();
    } catch (e) {
      favFault = e instanceof Error ? e.message : String(e);
    }
  }

  async function clearNote() {
    if (!selected) return;
    favFault = null;
    favSaid = null;
    try {
      await reader.keepFavourite({
        host: selected.host,
        promptId: selected.promptId,
        title: favTitle || kept?.title || "kept",
        tags: kept?.tags ?? [],
        note: "",
      });
      favNote = "";
      favSaid = "note cleared";
      await reloadHall();
    } catch (e) {
      favFault = e instanceof Error ? e.message : String(e);
    }
  }

  async function unkeep(row?: FavouriteRow) {
    const target = row ?? kept;
    if (!target) return;
    try {
      await reader.removeFavourite(target.host, target.promptId);
      favSaid = null;
      await reloadHall();
    } catch (e) {
      favFault = e instanceof Error ? e.message : String(e);
    }
  }

  /** `p`: unmark what is marked, otherwise put a sensible title in the field and
   *  send the cursor there. Enter then keeps it, so the gesture has a full
   *  keyboard path with no typing at all. */
  function toggleMark() {
    if (!selected) return;
    if (kept) {
      void unkeep(kept);
      return;
    }
    if (!favTitle) {
      favTitle = `${dayLabel(dayKey(selected.at), now)} · ${selected.project} · ${effectiveKind(selected)}`;
    }
    void tick().then(() => titleField?.focus());
  }

  /** A hall entry read: bring its prompt into the trace and open it.
   *
   *  The filters are cleared first, because a selection behind a filter is a
   *  pane nobody can see. A marked prompt from last month is older than the
   *  trace's week, so its own day is read on demand and merged in; `stretched`
   *  stops the strip from calling the result "this week".
   */
  async function openHallEntry(f: FavouriteRow) {
    filter = { kind: "", project: "", day: "" };
    let row = rows.find((r) => r.host === f.host && r.promptId === f.promptId);
    if (!row) {
      try {
        const from = startOfDay(f.at);
        const extra = await reader.facts(from, startOfDay(addDays(from, 1)));
        const known = new Set(rows.map(keyOf));
        rows = [...rows, ...extra.filter((r) => !known.has(keyOf(r)))];
        stretched = true;
        row = extra.find((r) => r.host === f.host && r.promptId === f.promptId);
      } catch (e) {
        favFault = message(e);
        return;
      }
    }
    if (row) {
      /* Land on the page that holds it. A hall prompt from a busy day can be
         forty rows down, and a detail pane with no visible source row is a pane
         whose selection cannot be walked back to. */
      const day = dayKey(row.at);
      const group = groupByDay(rows, now).find((g) => g.day === day);
      const index = group ? group.rows.findIndex((r) => keyOf(r) === keyOf(row)) : -1;
      pages = { ...pages, [day]: Math.max(0, Math.floor(index / PAGE)) };
      select(row);
      void tick().then(() => detailHost?.focus());
    }
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function reloadRows() {
    const { from, to } = traceWindow(now);
    rows = await reader.facts(from, to);
    readAt = Date.now();
  }

  async function reloadHall() {
    hall = await reader.favourites();
  }

  /** Everything the tab reads. Called on mount, by `r` from the shell, and by
   *  the surface's one 65-second refresh; never on a timer of its own. */
  export async function reload() {
    loading = true;
    try {
      const at = Date.now();
      const { from, to } = traceWindow(at);
      const [nextRows, nextHall, nextVault] = await Promise.all([
        reader.facts(from, to),
        reader.favourites(),
        reader.vault(),
      ]);
      rows = nextRows;
      hall = nextHall;
      vault = nextVault;
      vaultAt = Date.now();
      tickNow = vaultAt;
      now = at;
      readAt = Date.now();
      /* The window is the seven days again, so a day the hall pulled in is
         gone with the rows and the strip's label has to stop saying
         "recorded". `openHallEntry` sets it again if you do that. */
      stretched = false;
      fault = null;
    } catch (e) {
      fault = message(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void reload();
  });

  /* ── keyboard ────────────────────────────────────────────────────────── */

  let listHost = $state<HTMLElement>();
  let detailHost = $state<HTMLElement>();

  function move(delta: number) {
    if (flat.length === 0) return;
    const at = picked ? flat.findIndex((r) => keyOf(r) === keyOf(picked!)) : -1;
    const next = Math.min(flat.length - 1, Math.max(0, (at === -1 ? (delta > 0 ? -1 : flat.length) : at) + delta));
    const row = flat[next];
    select(row);
    void tick().then(() => {
      listHost?.querySelectorAll<HTMLElement>(".ap-row")[next]?.focus();
    });
  }

  function pageSelected(delta: number) {
    if (!selected) return;
    const day = dayKey(selected.at);
    const group = days.find((d) => d.day === day);
    if (!group) return;
    const pagesIn = Math.max(1, Math.ceil(group.rows.length / PAGE));
    const next = Math.min(pagesIn - 1, Math.max(0, (pages[day] ?? 0) + delta));
    pages = { ...pages, [day]: next };
    void tick().then(() => {
      const row = flat.find((r) => keyOf(r) === keyOf(selected));
      if (row) listHost?.querySelector<HTMLElement>(`[data-key="${keyOf(row)}"]`)?.focus();
    });
  }

  /** The shell calls this before its own keys. `true` means the key was the
   *  prompts tab's and must not reach the surface behind it. */
  export function key(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    const field = target?.closest("input, textarea, select, [contenteditable='true']");
    if (field) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        (field as HTMLElement).blur();
        return true;
      }
      return false;
    }

    if (e.key === "Escape") {
      if (armedForget || resetStage > 0) {
        e.preventDefault();
        e.stopPropagation();
        disarm();
        return true;
      }
      if (picked) {
        e.preventDefault();
        e.stopPropagation();
        closeDetail();
        return true;
      }
      return false;
    }
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      move(1);
      return true;
    }
    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      move(-1);
      return true;
    }
    /* Enter on the row that is already open moves into its detail. It must not
       be taken anywhere else: every control on this tab is a real button, and
       preventing Enter's default is how a keyboard user activates one. The tab
       row, the vault's buttons and the hall's cards all keep native Enter. */
    if (e.key === "Enter" && picked) {
      const row = target?.closest<HTMLElement>(".ap-row");
      if (row?.dataset.key === selectedKey()) {
        e.preventDefault();
        e.stopPropagation();
        void tick().then(() => detailHost?.focus());
        return true;
      }
      return false;
    }
    if (e.key === "p") {
      e.preventDefault();
      e.stopPropagation();
      toggleMark();
      return true;
    }
    if (e.key === "o") {
      e.preventDefault();
      e.stopPropagation();
      kindField?.focus();
      return true;
    }
    if (e.key === "u") {
      e.preventDefault();
      e.stopPropagation();
      passField?.focus();
      return true;
    }
    if (e.key === "l" && unlocked) {
      e.preventDefault();
      e.stopPropagation();
      void lock();
      return true;
    }
    if (e.key === "f") {
      e.preventDefault();
      e.stopPropagation();
      filters?.querySelector<HTMLElement>("select")?.focus();
      return true;
    }
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      e.stopPropagation();
      pageSelected(e.key === "]" ? 1 : -1);
      return true;
    }
    return false;
  }

  /* ── drawing helpers ─────────────────────────────────────────────────── */

  function timeOf(at: number): string {
    return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function lengthSaid(n: number | null): string {
    return n === null ? "—" : `${count(n)} words`;
  }

  function rateSaid(rate: number | null): string {
    return rate === null ? "—" : pct(rate * 100);
  }

  function perPrompt(n: number | null): string {
    return n === null ? "—" : n.toFixed(1);
  }

  function selectedKey(): string {
    return picked ? keyOf(picked) : "";
  }

  /** What the note speaks for: the answer, when one came back, because a read
   *  that said `locked` under a vault the face thought was open is the reading
   *  the note has to explain, not the row's stored state. */
  function noteTag(row: PromptRow, answer: PromptBody | null): ReturnType<typeof bodyTag> {
    return answer?.state ? bodyTag({ bodyState: answer.state }) : bodyTag(row);
  }
</script>

<div class="ap" class:reading={presentation === "page"}>
  <!-- ── the vault, at the top because a locked archive is not an empty one ── -->
  <section class="ap-vault" aria-labelledby="ap-vault-head">
    <header class="ap-vault-head">
      <span class="ap-vault-mark" aria-hidden="true"><Icon name="key" small /></span>
      <h3 id="ap-vault-head">vault</h3>
      <span class="ap-state" class:on={unlocked} class:off={!unlocked}>
        {#if !vault}reading…{:else if vault.vaults.length === 0}no vault{:else if unlocked}unlocked{:else}locked{/if}
      </span>
      {#if unlocked && idleLeft !== null}
        <span class="ap-idle" title="the key drops itself after fifteen minutes without a gesture">
          locks in {left(idleLeft)}
        </span>
      {/if}
      <span class="ap-grow"></span>
      {#if vault && vault.vaults.length > 0}
        <span class="ap-counts" title={Object.entries(bodyCounts).map(([k, v]) => `${k} ${v}`).join(" · ")}>
          {count(bodyCounts.sealed)} sealed · {count(bodyCounts.locked)} locked · {count(bodyCounts.deleted)} forgotten
        </span>
      {/if}
    </header>

    {#if !vault}
      <p class="ap-note">reading the vault…</p>
    {:else if vault.vaults.length === 0}
      <p class="ap-note">
        no vault yet. every prompt's form is recorded, and the words stay in their transcript. a vault keeps
        the redacted bodies under a passphrase only you hold, so the archive travels without being readable.
      </p>
      <div class="ap-row-form">
        <label class="ap-field grow">
          <span>passphrase</span>
          <input
            bind:this={passField}
            bind:value={pass}
            type="password"
            autocomplete="off"
            placeholder="twelve characters minimum"
            onkeydown={(e) => e.key === "Enter" && void create()}
          />
        </label>
        <label class="ap-field grow">
          <span>again</span>
          <input
            bind:value={passAgain}
            type="password"
            autocomplete="off"
            placeholder="the same one"
            onkeydown={(e) => e.key === "Enter" && void create()}
          />
        </label>
        <button type="button" class="ap-btn on" disabled={vaultBusy} onclick={() => void create()}>
          create vault
        </button>
      </div>
      <p class="ap-hint">
        {vault.minPassphrase} characters minimum, and there is no recovery: a forgotten passphrase is a lost
        archive. the passphrase is never stored, shown or logged.
      </p>
    {:else if !unlocked}
      <p class="ap-note">
        locked. the counts below are drawn from the facts and need no key; the bodies do. unlock with the
        passphrase to read them, or seal what was recorded while it was locked. forget and reset below need no
        key either.
      </p>
      <div class="ap-row-form">
        <label class="ap-field grow">
          <span>passphrase</span>
          <input
            bind:this={passField}
            bind:value={pass}
            type="password"
            autocomplete="off"
            placeholder="the passphrase for this wall's vault"
            onkeydown={(e) => e.key === "Enter" && void unlock()}
          />
        </label>
        <button type="button" class="ap-btn on" disabled={vaultBusy} onclick={() => void unlock()}>
          <Icon name="key" small /> unlock
        </button>
      </div>
      <p class="ap-hint">wrong passphrases open none of this wall's vaults and change nothing.</p>
    {:else}
      <div class="ap-row-form">
        <button type="button" class="ap-btn" disabled={vaultBusy} onclick={() => void lock()}>
          <Icon name="key" small /> lock <kbd>l</kbd>
        </button>
        <button
          type="button"
          class="ap-btn"
          disabled={vaultBusy || vault.locators === 0}
          title={vault.locators === 0 ? "nothing is waiting" : "seek each waiting transcript line and seal it now"}
          onclick={() => void seal()}
        >
          <Icon name="check" small /> seal pending
          {#if vault.locators > 0}<span class="ap-badge">{count(vault.locators)}</span>{/if}
        </button>
      </div>
      <p class="ap-hint">
        a lock drops the key; the counts stay readable. forget keeps every count and takes every body and its
        hall entry. reset is the bigger gesture and asks twice.
      </p>
    {/if}

    <!-- Forget and reset are **not** behind the lock. Neither needs the key:
         forget deletes bodies, and reset throws the key away, which is exactly
         the gesture a person who has forgotten the passphrase needs. Hiding
         them while locked would make "there is no recovery" also mean "there
         is no way out". -->
    {#if vault && vault.vaults.length > 0}
      <div class="ap-row-form ap-danger-row">
        <span class="ap-grow"></span>
        <button
          type="button"
          class="ap-btn"
          class:armed={armedForget}
          onclick={() => void forget()}
          title="delete every sealed body and every hall entry, keeping the counts"
        >
          {armedForget ? "click again: forget every body" : "forget prompts"}
          {#if armedForget}<kbd>esc</kbd>{/if}
        </button>
        <button
          type="button"
          class="ap-btn danger"
          class:armed={resetStage > 0}
          onclick={() => void reset()}
          title="delete the key and every body. there is no recovery"
        >
          {resetStage === 0 ? "reset vault" : resetStage === 1 ? "click again to be sure" : "last click: there is no recovery"}
        </button>
      </div>
    {/if}

    {#if vaultSaid}<p class="ap-said">{vaultSaid}</p>{/if}
    {#if vaultFault}<p class="ap-fault" role="alert">{vaultFault}</p>{/if}
  </section>

  <!-- ── the strip: form readings, no body needed ─────────────────────── -->
  <section class="ap-strip" aria-label="form readings">
    <div class="ap-kpi">
      <b>{count(stats.n)}</b
      ><span>{filter.kind || filter.project || filter.day ? "matching" : stretched ? "recorded" : "7 days"}</span>
    </div>
    <div class="ap-kpi"><b>{count(today)}</b><span>today</span></div>
    <div class="ap-kpi"><b>{lengthSaid(stats.median)}</b><span>median</span></div>
    <div class="ap-kpi"><b>{lengthSaid(stats.p90)}</b><span>p90</span></div>
    <div class="ap-kpi"><b>{rateSaid(stats.redirectRate)}</b><span>redirects</span></div>
    <div class="ap-kpi"><b>{rateSaid(stats.nudgeRate)}</b><span>nudges</span></div>
    <div class="ap-kpi"><b>{perPrompt(stats.redactionRate)}</b><span>redactions / prompt</span></div>
    <div class="ap-kpi"><b>{count(stats.withheld)}</b><span>withheld</span></div>
  </section>

  <!-- ── filters, by facts only ───────────────────────────────────────── -->
  <div class="ap-filters" bind:this={filters} role="group" aria-label="filter the trace">
    <label class="ap-select">
      <span>kind</span>
      <select bind:value={filter.kind} onchange={() => (pages = {})}>
        <option value="">every kind</option>
        {#each PROMPT_KINDS as k}<option value={k}>{k}</option>{/each}
      </select>
    </label>
    <label class="ap-select">
      <span>project</span>
      <select bind:value={filter.project} onchange={() => (pages = {})}>
        <option value="">every project</option>
        {#each projects as p}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    <label class="ap-select">
      <span>day</span>
      <select bind:value={filter.day} onchange={() => (pages = {})}>
        <option value="">every day</option>
        {#each dayChoices as d}<option value={d.day}>{d.label} · {d.n}</option>{/each}
      </select>
    </label>
    <span class="ap-grow"></span>
    <span class="ap-hint inline">search is by kind and project; the words are sealed, so there is no full-text index</span>
    <button type="button" class="ap-btn" onclick={() => void reload()} title="read the trace again">
      <Icon name="clock" small /> read again
    </button>
  </div>

  {#if fault}
    <div class="ap-message">
      <p class="ap-fail">could not read the prompt facts</p>
      <p class="ap-note">{fault}</p>
    </div>
  {:else if loading}
    <div class="ap-message"><p class="ap-note">reading…</p></div>
  {:else}
    {#if filtered.length === 0}
      <div class="ap-message">
        <p class="ap-empty">{rows.length === 0 ? "nothing recorded in this window" : "nothing matches that filter"}</p>
        <p class="ap-note">
          analytics records a prompt's <em>form</em>: words, lines, fences, images, questions, redactions and a
          kind. the words themselves are not recorded; a redacted copy is kept only while a vault is open, sealed
          under a passphrase only you hold.
          {#if rows.length === 0}
            prompts appear here after the collector's next pass, and a card's own prompts are already in its
            transcript.
          {/if}
        </p>
      </div>
    {:else}
      <div class="ap-trace" class:split={selected}>
        <div class="ap-list" bind:this={listHost} role="listbox" aria-label="prompts" tabindex="-1">
          {#each shown as d (d.day)}
            {@const p = d.page}
            <section class="ap-day" aria-label={d.label}>
              <header class="ap-day-head">
                <h4>{d.label}</h4>
                <span class="ap-sub">
                  {d.rows.length === 1 ? "1 prompt" : `${count(d.rows.length)} prompts`}
                  {#if p.pages > 1}· page {p.page + 1} of {p.pages}{/if}
                </span>
                {#if p.pages > 1}
                  <span class="ap-grow"></span>
                  <button
                    type="button"
                    class="ap-mini"
                    disabled={p.page === 0}
                    onclick={() => (pages = { ...pages, [d.day]: p.page - 1 })}
                    title="earlier prompts in this day ([ and ] page a selected one)"
                  >newer</button
                  >
                  <button
                    type="button"
                    class="ap-mini"
                    disabled={p.page >= p.pages - 1}
                    onclick={() => (pages = { ...pages, [d.day]: p.page + 1 })}
                    title="more prompts in this day ([ and ] page a selected one)"
                  >older</button
                  >
                {/if}
              </header>
              <div class="ap-cols" aria-hidden="true">
                <span>time</span><span>card · project</span><span>kind</span><span>length</span><span>redactions</span
                ><span>body</span>
              </div>
              {#each p.rows as row (keyOf(row))}
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedKey() === keyOf(row)}
                  class="ap-row"
                  class:on={selectedKey() === keyOf(row)}
                  data-key={keyOf(row)}
                  onclick={() => select(row)}
                >
                  <span class="c-time">{timeOf(row.at)}</span>
                  <span class="c-card">
                    <span class="c-name">{cardLabel(row)}</span>
                    <span class="c-project">{row.project}</span>
                  </span>
                  <span class="c-kind">
                    {effectiveKind(row)}
                    {#if isCorrected(row)}<em title="kind corrected by hand">*</em>{/if}
                  </span>
                  <span class="c-len">{lengthLabel(row)}</span>
                  <span class="c-red">{redactionLabel(row)}</span>
                  <span class="c-body tag-{bodyTag(row)}">{bodyTagLabel(bodyTag(row))}</span>
                </button>
              {/each}
            </section>
          {/each}
        </div>

        {#if selected}
          <aside class="ap-detail" bind:this={detailHost} tabindex="-1" aria-label="the selected prompt">
            <header class="ap-detail-head">
              <span class="ap-when">{dayLabel(dayKey(selected.at), now)} · {timeOf(selected.at)}</span>
              <span class="ap-grow"></span>
              <button type="button" class="ap-mini" onclick={closeDetail} title="close the detail (esc)">esc</button>
            </header>
            <p class="ap-where">
              {cardLabel(selected)} · {selected.project}
              {#if selected.source}· {selected.source}{/if}
            </p>
            <div class="ap-badges">
              <span class="ap-kind">{effectiveKind(selected)}</span>
              <span class="ap-badge">{lengthLabel(selected)}</span>
              {#if selected.redactions > 0}
                <span class="ap-badge">{count(selected.redactions)} redacted</span>
              {/if}
              <span class="ap-badge tag-{bodyTag(selected)}">{bodyTagLabel(bodyTag(selected))}</span>
              {#if selected.seenCount > 1}<span class="ap-badge">said {selected.seenCount}×</span>{/if}
            </div>

            <label class="ap-field tight">
              <span>kind <kbd>o</kbd></span>
              <select
                bind:this={kindField}
                value={effectiveKind(selected)}
                onchange={(e) => void correct(e.currentTarget.value)}
              >
                {#each PROMPT_KINDS as k}<option value={k}>{k}</option>{/each}
              </select>
            </label>
            {#if isCorrected(selected)}
              <p class="ap-hint">
                corrected by hand from <b>{selected.kind}</b>. the mix and the two rates follow this, and it is
                local: an override is a reading, never training data.
              </p>
            {/if}
            {#if correctFault}<p class="ap-fault" role="alert">{correctFault}</p>{/if}

            <div class="ap-body-block">
              {#if bodyFault}
                <p class="ap-fault" role="alert">{bodyFault}</p>
              {:else if bodyBusy}
                <p class="ap-note">opening…</p>
              {:else if body?.text !== null && body?.text !== undefined}
                <pre class="ap-body">{body.text}</pre>
                {#if body.truncated}
                  <p class="ap-hint">the body was capped at 8 KB when it was sealed.</p>
                {/if}
              {:else}
                <p class="ap-note">{bodyNote(noteTag(selected, body), openFor(selected))}</p>
                {#if body?.state === "locked" && openFor(selected) && selected.bodyState === "sealed"}
                  <button type="button" class="ap-btn" onclick={() => void readBody(selected)}>
                    try the body again
                  </button>
                {/if}
              {/if}
            </div>

            {#if bodyReadable(selected, openFor(selected)) && !body}
              <button type="button" class="ap-btn" onclick={() => void readBody(selected)}>
                <Icon name="eye" small /> read the redacted body
              </button>
            {/if}

            <!-- the hall's marker, drawn where the prompt is -->
            <div class="ap-keep">
              <h4>{kept ? "in the hall" : "keep this one"}</h4>
              <div class="ap-row-form">
                <label class="ap-field grow">
                  <span>title</span>
                  <input
                    bind:this={titleField}
                    bind:value={favTitle}
                    placeholder="a title you will find it by"
                    onkeydown={(e) => e.key === "Enter" && void keep()}
                  />
                </label>
                <label class="ap-field grow">
                  <span>tags</span>
                  <input
                    bind:value={favTags}
                    placeholder="nova, orchestration"
                    onkeydown={(e) => e.key === "Enter" && void keep()}
                  />
                </label>
              </div>
              <label class="ap-field">
                <span>note {#if !unlocked}<em>sealed, needs the vault open</em>{/if}</span>
                <textarea
                  bind:value={favNote}
                  rows="2"
                  disabled={!unlocked}
                  placeholder={kept?.note ? kept.note : kept?.noteLocked ? "note sealed" : "why this one mattered"}
                ></textarea>
              </label>
              <div class="ap-row-form">
                <button type="button" class="ap-btn on" onclick={() => void keep()}>
                  {kept ? "update the marker" : "keep it"} <kbd>p</kbd>
                </button>
                {#if kept?.note}
                  <button type="button" class="ap-btn" onclick={() => void clearNote()}>clear note</button>
                {/if}
                {#if kept}
                  <button type="button" class="ap-btn danger" onclick={() => void unkeep()}>take it out</button>
                {/if}
                {#if kept?.noteLocked}<span class="ap-hint inline">the note is sealed and the vault is locked</span>{/if}
              </div>
              {#if favSaid}<p class="ap-said">{favSaid}</p>{/if}
              {#if favFault}<p class="ap-fault" role="alert">{favFault}</p>{/if}
            </div>
          </aside>
        {/if}
      </div>
    {/if}

    <!-- ── the hall ──────────────────────────────────────────────────── -->
    <section class="ap-hall" aria-labelledby="ap-hall-head">
      <header class="ap-hall-head">
        <h3 id="ap-hall-head">the hall</h3>
        <span class="ap-sub">{hall.length === 0 ? "nothing kept yet" : `${count(hall.length)} kept`}</span>
        <span class="ap-grow"></span>
        <label class="ap-select">
          <span>tag</span>
          <select bind:value={hallFilter.tag}>
            <option value="">every tag</option>
            {#each tags as t}<option value={t}>{t}</option>{/each}
          </select>
        </label>
        <label class="ap-select">
          <span>project</span>
          <select bind:value={hallFilter.project}>
            <option value="">every project</option>
            {#each hallProjectChoices as p}<option value={p}>{p}</option>{/each}
          </select>
        </label>
        <label class="ap-select">
          <span>kind</span>
          <select bind:value={hallFilter.kind}>
            <option value="">every kind</option>
            {#each PROMPT_KINDS as k}<option value={k}>{k}</option>{/each}
          </select>
        </label>
        <label class="ap-select">
          <span>year</span>
          <select bind:value={hallFilter.year}>
            <option value="">every year</option>
            {#each years as y}<option value={String(y)}>{y}</option>{/each}
          </select>
        </label>
        <label class="ap-select">
          <span>sort</span>
          <select bind:value={hallSort}>
            <option value="date">by date</option>
            <option value="cost">by the card's cost</option>
          </select>
        </label>
      </header>

      {#if hall.length === 0}
        <p class="ap-note">
          nothing in the hall yet. mark a prompt from the trace and it stays here, past every prune, with the
          title, tags and sealed note you gave it.
        </p>
      {:else if gallery.length === 0}
        <p class="ap-note">nothing matches that filter. the hall is still here; narrow it less.</p>
      {:else}
        <div class="ap-gallery">
          {#each gallery as f (keyOf(f))}
            <article class="ap-card">
              <header>
                <button type="button" class="ap-title" onclick={() => openHallEntry(f)}>
                  {f.title}
                </button>
                <span class="ap-grow"></span>
                <button
                  type="button"
                  class="ap-mini"
                  title="take this out of the hall, keeping the prompt"
                  onclick={() => void unkeep(f)}
                >remove</button
                >
              </header>
              <p class="ap-where">
                {f.project} · {effectiveKind(f)} · {dayLabel(dayKey(f.at), now)} · {new Date(f.at).getFullYear()}
              </p>
              <p class="ap-tags">
                {#each f.tags as t}<span class="ap-tag">{t}</span>{/each}
              </p>
              <p class="ap-card-cost">{costLabel(f)}</p>
              {#if noteLabel(f)}
                <p class="ap-card-note" class:sealed={f.noteLocked && !f.note}>{noteLabel(f)}</p>
              {/if}
              <p class="ap-card-body">
                {lengthLabel(f)} · {bodyTagLabel(bodyTag(f))}
              </p>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if readAt}
    <p class="ap-read">read {new Date(readAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
  {/if}
</div>

<style>
  /* ── one surface, two skins ───────────────────────────────────────────── */

  .ap {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px 26px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-dim);
  }
  /* The page's skin is editorial: the book's face, a 64rem measure, the ground
     the shell already laid down, and more air. The *drawing* is the same one. */
  .ap.reading {
    padding: 24px max(18px, calc((100% - 64rem) / 2)) 40px;
    gap: 20px;
    font-family: var(--body);
    font-size: 13px;
    color: var(--cv-prose, var(--paper-dim));
  }
  .ap.reading .ap-btn,
  .ap.reading .ap-row,
  .ap.reading .ap-select,
  .ap.reading .ap-kpi span,
  .ap.reading .ap-sub,
  .ap.reading .ap-hint,
  .ap.reading .ap-where,
  .ap.reading .ap-tag,
  .ap.reading .ap-badge {
    font-family: var(--cv-ui, var(--util));
  }
  .ap.reading .ap-body {
    font-family: var(--body);
    font-size: 14px;
    line-height: 1.6;
  }

  .ap-grow {
    flex: 1;
  }
  h3,
  h4 {
    margin: 0;
    font-weight: 600;
  }
  h3 {
    font-size: 13px;
  }
  h4 {
    font-size: 11.5px;
  }

  /* ── controls ─────────────────────────────────────────────────────────── */

  .ap-btn,
  .ap-mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-dim);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 4px 9px;
    border-radius: 7px;
    cursor: pointer;
  }
  .ap-mini {
    padding: 2px 7px;
    font-size: 10.5px;
  }
  .ap-btn:hover:not(:disabled),
  .ap-mini:hover:not(:disabled) {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .ap-btn:disabled,
  .ap-mini:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ap-btn.on {
    border-color: color-mix(in oklab, var(--paper) 24%, transparent);
    color: var(--paper);
  }
  .ap-btn.danger {
    color: var(--paper-mute);
  }
  .ap-btn.armed,
  .ap-mini.armed {
    border-color: var(--st-fail);
    color: var(--st-fail);
  }
  .ap-btn kbd,
  .ap-field kbd {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0 4px;
    margin-left: 3px;
  }

  .ap-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .ap-field.grow {
    flex: 1;
    min-width: 140px;
  }
  .ap-field.tight {
    max-width: 180px;
  }
  .ap-field em {
    font-style: normal;
    color: var(--paper-faint);
    margin-left: 4px;
  }
  .ap-field input,
  .ap-field textarea,
  .ap-field select,
  .ap-select select {
    border: 1px solid var(--edge);
    background: color-mix(in oklab, var(--paper) 4%, transparent);
    color: var(--paper);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 4px 7px;
    border-radius: 6px;
    outline: none;
  }
  .ap-field input:focus-visible,
  .ap-field textarea:focus-visible,
  .ap-field select:focus-visible,
  .ap-select select:focus-visible,
  .ap-btn:focus-visible,
  .ap-mini:focus-visible,
  .ap-row:focus-visible,
  .ap-title:focus-visible,
  .ap-detail:focus-visible {
    outline: 1px solid color-mix(in oklab, var(--paper) 46%, transparent);
    outline-offset: 1px;
  }
  .ap-field input:disabled,
  .ap-field textarea:disabled {
    opacity: 0.45;
  }
  .ap-field textarea {
    resize: vertical;
    min-height: 40px;
  }
  .ap-select {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .ap-row-form {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }

  .ap-hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--paper-faint);
    max-width: 78ch;
  }
  .ap-hint.inline {
    max-width: 44ch;
  }
  .ap-note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--paper-mute);
    max-width: 78ch;
  }
  .ap.reading .ap-note {
    font-size: 13px;
    line-height: 1.6;
  }
  .ap-said {
    margin: 0;
    font-size: 11px;
    color: var(--paper-dim);
  }
  .ap-fault {
    margin: 0;
    font-size: 11.5px;
    color: var(--st-fail);
  }
  .ap-sub {
    font-size: 10.5px;
    color: var(--paper-faint);
  }

  /* ── the vault ────────────────────────────────────────────────────────── */

  .ap-vault {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid color-mix(in oklab, var(--edge) 78%, transparent);
    border-radius: var(--cv-r-m, 10px);
    background: color-mix(in oklab, var(--paper) 3%, transparent);
  }
  .ap.reading .ap-vault {
    padding: 14px 16px;
  }
  .ap-vault-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ap-vault-mark {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .ap-state {
    font-size: 10.5px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--edge);
  }
  .ap-state.on {
    border-style: solid;
    color: var(--paper);
  }
  .ap-state.off {
    border-style: dashed;
    color: var(--paper-mute);
  }
  .ap-idle {
    font-size: 10.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .ap-counts {
    font-size: 10.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── the strip ────────────────────────────────────────────────────────── */

  .ap-strip {
    flex: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: 2px;
    border-top: 1px solid var(--cv-hair, var(--edge));
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    padding: 8px 0;
  }
  .ap-kpi {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 8px;
  }
  .ap-kpi b {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .ap-kpi span {
    font-size: 10px;
    color: var(--paper-faint);
  }
  .ap.reading .ap-kpi b {
    font-size: 18px;
  }

  /* ── filters ──────────────────────────────────────────────────────────── */

  .ap-filters {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
  }

  /* ── the trace ────────────────────────────────────────────────────────── */

  .ap-trace {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .ap-list {
    flex: 1;
    min-width: 0;
    container-type: inline-size;
  }
  .ap-day {
    padding-top: 4px;
  }
  .ap-day + .ap-day {
    margin-top: 8px;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  .ap-day-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 6px 4px;
  }
  .ap-day-head h4 {
    text-transform: lowercase;
    color: var(--paper);
    font-size: 11.5px;
  }
  .ap-cols,
  .ap-row {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 62px 76px 84px 74px;
    gap: 8px;
    align-items: center;
    padding: 0 6px;
  }
  .ap-cols {
    padding-bottom: 3px;
    font-size: 9.5px;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .ap-row {
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--paper-dim);
    font: 11.5px var(--cv-ui, var(--util));
    text-align: left;
    padding: 5px 6px;
    cursor: pointer;
  }
  .ap-row:hover {
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .ap-row.on {
    background: color-mix(in oklab, var(--paper) 9%, transparent);
    color: var(--paper);
  }
  .c-time,
  .c-len,
  .c-red {
    font-variant-numeric: tabular-nums;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .c-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .c-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper);
  }
  .c-project {
    font-size: 9.5px;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-kind {
    text-transform: lowercase;
  }
  .c-kind em {
    font-style: normal;
    color: var(--paper-faint);
    margin-left: 2px;
  }
  .c-body,
  .ap-badge,
  .tag-none,
  .tag-locked {
    justify-self: start;
    font-size: 9.5px;
    line-height: 1.4;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--edge);
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .tag-sealed {
    border-style: solid;
    color: var(--paper-dim);
  }
  .tag-locked {
    border-style: dashed;
  }
  .tag-withheld {
    border-style: dotted;
  }
  .tag-deleted,
  .tag-none {
    border-color: color-mix(in oklab, var(--edge) 55%, transparent);
    color: var(--paper-faint);
  }

  @container (max-width: 540px) {
    .ap-cols,
    .ap-row {
      grid-template-columns: 42px minmax(0, 1fr) 58px 70px 70px;
    }
    .ap-cols span:nth-child(5),
    .c-red {
      display: none;
    }
  }
  @container (max-width: 400px) {
    .ap-cols,
    .ap-row {
      grid-template-columns: 42px minmax(0, 1fr) 58px 70px;
    }
    .ap-cols span:nth-child(4),
    .c-len {
      display: none;
    }
  }

  /* ── the detail ───────────────────────────────────────────────────────── */

  .ap-detail {
    flex: 0 0 38%;
    min-width: 290px;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 2px 2px 2px 14px;
    border-left: 1px solid var(--cv-hair, var(--edge));
    outline: none;
    position: sticky;
    top: 0;
    max-height: min(70cqh, 640px);
    overflow-y: auto;
  }
  .ap.reading .ap-detail {
    flex-basis: 40%;
    gap: 12px;
  }
  .ap-detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ap-when {
    font-size: 10.5px;
    color: var(--paper-faint);
    text-transform: lowercase;
  }
  .ap-where {
    margin: 0;
    font-size: 11.5px;
    color: var(--paper);
  }
  .ap-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .ap-kind {
    font-size: 10.5px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklab, var(--paper) 22%, transparent);
    color: var(--paper);
    text-transform: lowercase;
  }
  .ap-badges .ap-badge {
    color: var(--paper-mute);
  }
  .ap-body-block {
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
    padding: 9px 10px;
    background: color-mix(in oklab, var(--paper) 2.5%, transparent);
    min-height: 52px;
  }
  .ap-body {
    margin: 0;
    font: 11.5px/1.55 var(--cv-ui, var(--util));
    color: var(--paper-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ap-keep {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  .ap-keep h4 {
    color: var(--paper-mute);
    font-size: 10.5px;
    text-transform: lowercase;
    letter-spacing: 0.03em;
  }

  /* ── messages ─────────────────────────────────────────────────────────── */

  .ap-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 32px 20px;
    text-align: center;
  }
  .ap-empty {
    margin: 0;
    font-size: 14px;
    color: var(--paper-dim);
  }
  .ap-fail {
    margin: 0;
    font-size: 13px;
    color: var(--st-fail);
  }

  /* ── the hall ─────────────────────────────────────────────────────────── */

  .ap-hall {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  .ap-hall-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px 10px;
  }
  .ap-gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
    gap: 10px;
  }
  .ap-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px 12px;
    border: 1px solid color-mix(in oklab, var(--edge) 78%, transparent);
    border-radius: var(--cv-r-m, 10px);
    background: color-mix(in oklab, var(--paper) 2.5%, transparent);
    min-width: 0;
  }
  .ap-card header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .ap-title {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--paper);
    font: 600 12.5px var(--cv-ui, var(--util));
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ap-title:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .ap.reading .ap-title {
    font-size: 14px;
  }
  .ap-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
  }
  .ap-tag {
    font-size: 9.5px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid var(--edge);
    color: var(--paper-mute);
  }
  .ap-card-cost,
  .ap-card-body {
    margin: 0;
    font-size: 10.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .ap-card-note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--paper-dim);
  }
  .ap-card-note.sealed {
    font-style: italic;
    color: var(--paper-faint);
  }
  .ap.reading .ap-card-note {
    font-family: var(--body);
    font-size: 13px;
  }

  .ap-read {
    margin: 0;
    align-self: flex-end;
    font-size: 10px;
    color: var(--paper-faint);
  }
</style>
