<script lang="ts">
  /* The saved-view library (§11.6): save the surface's question under a name,
   * open one, rename one, delete one.
   *
   * A view is a spec, not a screenshot: opening one re-runs it against current
   * data, which is why opening is `surface ← the spec` and nothing else. It is
   * also why **a delete leaves the drawing on screen exactly as it was** — what
   * is drawn is the surface's own copy, and the menu says so rather than
   * pretending the page emptied. A widget that pointed at the id is phase six's
   * problem, and it keeps its snapshot for the same reason.
   *
   * Every control has a key: `s` and `l` open it in its two modes, arrows or
   * `j`/`k` walk the rows, Enter opens, `r` renames, Delete arms a delete, and
   * Escape closes the menu before the surface.
   */
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { deleteSavedView, loadSavedViews, renameSavedView, saveSavedView } from "./analyticslibrary.svelte";
  import { orderViews, surfaceOfView, viewOfSurface, type SavedView, type SurfaceInput } from "./analyticpage";
  import { ROOM_MEASURES, ROOM_SPLITS, SPANS } from "./analyticsroom";
  import { MAX_NAME } from "./analytics";
  import { tipOf } from "./tipped.svelte";

  let {
    mode,
    surface,
    onclose,
    onopen,
    onhang,
  }: {
    mode: "save" | "list";
    surface: SurfaceInput;
    onclose: () => void;
    onopen: (view: SavedView["view"], id: string) => void;
    /** Hang this saved view on the wall as a widget that reads it. Absent in
     *  the browser preview, which has no wall. */
    onhang?: (view: SavedView) => void;
  } = $props();

  let list = $state<SavedView[]>([]);
  let loading = $state(true);
  let fault = $state<string | null>(null);
  let note = $state<string | null>(null);
  /** What the surface's question is called before anybody types: a name that
   *  says what the view answers, so saving without typing is still a name. */
  const suggested = $derived.by(() => {
    const when = SPANS.find((s) => s.span === surface.span)?.said ?? surface.span;
    const what = ROOM_MEASURES.find((m) => m.key === surface.measure)?.label ?? surface.measure;
    const by = surface.split ? ` by ${surface.split}` : "";
    return `${when} · ${what}${by}`;
  });
  let name = $state("");

  let field = $state<HTMLInputElement>();
  let panel = $state<HTMLElement>();
  let renaming = $state<string | null>(null);
  let renameText = $state("");
  let armed = $state<string | null>(null);

  onMount(() => {
    void load();
    /* The name starts as what the surface is asking, so saving without typing
       is still a name — and it is filled here rather than at declaration
       because the suggestion is derived from the surface, and reading a
       reactive value in an initialiser captures it once. */
    if (mode === "save") name = suggested;
    void tick().then(() => {
      if (mode === "save") {
        field?.focus();
        field?.select();
      } else {
        /* The panel itself until the rows are here: focus already inside it
           means the menu's own keys work the moment they are reachable, and
           `load` moves it onto the first row when they arrive. */
        panel?.focus();
      }
    });
  });

  async function load() {
    loading = true;
    try {
      list = await loadSavedViews();
      fault = null;
    } catch (e) {
      fault = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      /* The list arrives after the mount, so the first row is focused here
         rather than in `onMount`, where there was nothing to focus yet. */
      if (mode === "list") {
        void tick().then(() => {
          if (!panel?.contains(document.activeElement) || document.activeElement === panel) {
            panel?.querySelector<HTMLElement>("[data-row]")?.focus();
          }
        });
      }
    }
  }

  async function save() {
    const clean = name.trim() || suggested;
    try {
      const made = await saveSavedView(clean, viewOfSurface(surface, clean));
      list = [made, ...list];
      name = clean;
      note = `saved “${made.name}”`;
      fault = null;
      void tick().then(() => panel?.querySelector<HTMLElement>("[data-row]")?.focus());
    } catch (e) {
      fault = e instanceof Error ? e.message : String(e);
    }
  }

  async function commitRename(id: string) {
    const clean = renameText.trim();
    renaming = null;
    if (!clean) return refocusRow();
    try {
      const changed = await renameSavedView(id, clean);
      if (!changed) {
        note = "that view is no longer in the library";
        await load();
        return;
      }
      /* The store bumps `updated_at`, so the row's date and its place in the
         order move with the name — otherwise the menu shows an order the
         library will disagree with the next time it is read. */
      list = orderViews(
        list.map((v) =>
          v.id === id ? { ...v, name: clean, view: { ...v.view, name: clean }, updatedAt: Date.now() } : v,
        ),
      );
      note = null;
      refocusRow();
    } catch (e) {
      fault = e instanceof Error ? e.message : String(e);
      refocusRow();
    }
  }

  /** A focused row, after the thing that had the focus is gone. Removing a
   *  focused element hands focus to `body` with no event of its own. */
  function refocusRow() {
    void tick().then(() => panel?.querySelector<HTMLElement>("[data-row]")?.focus());
  }

  async function remove(v: SavedView) {
    if (armed !== v.id) {
      armed = v.id;
      note = null;
      return;
    }
    armed = null;
    try {
      const gone = await deleteSavedView(v.id);
      if (!gone) {
        note = "that view was already gone";
        await load();
        return;
      }
      list = list.filter((x) => x.id !== v.id);
      /* The view on screen is the surface's own copy: deleting the spec it came
         from changes nothing that is being drawn. Saying so is the whole
         difference between a delete and a mystery. */
      note = `deleted “${v.name}”. the view on screen stays as it is.`;
      void tick().then(() => panel?.querySelector<HTMLElement>("[data-row]")?.focus());
    } catch (e) {
      fault = e instanceof Error ? e.message : String(e);
    }
  }

  function summary(v: SavedView): string {
    const s = surfaceOfView(v.view);
    const when = SPANS.find((x) => x.span === s.span)?.label ?? s.span;
    const what = ROOM_MEASURES.find((m) => m.key === s.measure)?.label ?? s.measure;
    const by = ROOM_SPLITS.find((x) => x.key === s.split)?.label;
    return `${when} · ${what}${by && by !== "none" ? ` · ${by}` : ""}`;
  }

  function when(at: number): string {
    if (!at) return "";
    return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  /* Arrow keys and `j`/`k` walk the rows, so the list reads like every other
     list on this wall. */
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    if ((e.target as HTMLElement)?.closest("input")) return;
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...(panel?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[Math.min(all.length - 1, Math.max(0, (at === -1 ? 0 : at) + step))]?.focus();
  }
</script>

<div class="av-wrap">
  <button type="button" class="av-out" aria-label="close the saved views" tabindex="-1" onclick={onclose}></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="av-panel" role="dialog" aria-label="saved views" tabindex="-1" bind:this={panel} onkeydown={key}>
    <header class="av-head">
      <h3>saved views</h3>
      <span class="av-grow"></span>
      <button type="button" class="av-x" {@attach tipOf("close (esc)")} aria-label="close" onclick={onclose}><Icon name="x" small /></button>
    </header>

    <div class="av-save">
      <input
        bind:this={field}
        bind:value={name}
        type="text"
        maxlength={MAX_NAME}
        aria-label="the view's name"
        placeholder={suggested}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void save();
          }
        }}
      />
      <button type="button" class="av-btn" {@attach tipOf("save what is on screen under this name")} onclick={() => void save()}>
        <Icon name="pin" small />save
      </button>
    </div>

    {#if fault}
      <p class="av-fault">{fault}</p>
    {/if}
    {#if note}
      <p class="av-note">{note}</p>
    {/if}

    <div class="av-list" role="list" aria-label="the library">
      {#if loading}
        <p class="av-note">reading the library…</p>
      {:else if list.length === 0}
        <p class="av-note">nothing saved yet. a saved view is what you are looking at, under a name.</p>
      {:else}
        {#each list as v (v.id)}
          <div class="av-row" role="listitem">
            {#if renaming === v.id}
              <input
                class="av-rename"
                bind:value={renameText}
                type="text"
                maxlength={MAX_NAME}
                aria-label="the new name"
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    void commitRename(v.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    renaming = null;
                    refocusRow();
                  }
                }}
              />
            {:else}
              <button
                type="button"
                class="av-open"
                data-row
                {@attach tipOf(() => (`open “${v.name}” · ${summary(v)}`))}
                onkeydown={(e) => {
                  if (e.key === "r") {
                    e.preventDefault();
                    e.stopPropagation();
                    renaming = v.id;
                    renameText = v.name;
                    void tick().then(() => panel?.querySelector<HTMLInputElement>(".av-rename")?.focus());
                  } else if (e.key === "p" && onhang) {
                    e.preventDefault();
                    e.stopPropagation();
                    onhang(v);
                  } else if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    e.stopPropagation();
                    void remove(v);
                  }
                }}
                onclick={() => onopen(v.view, v.id)}
              >
                <span class="av-name">{v.name}</span>
                <span class="av-what">{summary(v)}</span>
              </button>
            {/if}
            <button
              type="button"
              class="av-btn av-mini"
              {@attach tipOf("rename it (r)")}
              aria-label={`rename ${v.name}`}
              onclick={() => {
                renaming = v.id;
                renameText = v.name;
                armed = null;
                void tick().then(() => panel?.querySelector<HTMLInputElement>(".av-rename")?.focus());
              }}>rename</button
            >
            {#if onhang}
              <button
                type="button"
                class="av-btn av-mini"
                {@attach tipOf("hang it on the wall (p) — every edit to this view moves the widget")}
                aria-label={`hang ${v.name} on the wall`}
                onclick={() => onhang?.(v)}
                >on the wall</button
              >
            {/if}
            <button
              type="button"
              class="av-btn av-mini"
              class:on={armed === v.id}
              {@attach tipOf("delete it (delete, twice)")}
              aria-label={`delete ${v.name}`}
              onclick={() => void remove(v)}
              >{armed === v.id ? "sure?" : "delete"}</button
            >
            <span class="av-when">{when(v.updatedAt)}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .av-wrap {
    position: absolute;
    inset: 0;
    z-index: 6;
  }
  .av-out {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  .av-panel {
    position: absolute;
    top: 54px;
    right: 16px;
    width: min(420px, calc(100% - 32px));
    max-height: min(560px, calc(100% - 80px));
    display: flex;
    flex-direction: column;
    padding: 12px;
    border: 1px solid var(--edge);
    border-radius: 10px;
    background: var(--raised);
    box-shadow: 0 26px 60px -28px var(--shade);
    outline: none;
  }
  .av-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 2px 8px;
  }
  .av-head h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-mute);
  }
  .av-grow {
    flex: 1;
  }
  .av-x {
    border: 0;
    background: transparent;
    color: var(--paper-mute);
    cursor: pointer;
    padding: 2px;
  }
  .av-save {
    display: flex;
    gap: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .av-save input,
  .av-rename {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--edge);
    border-radius: 7px;
    background: color-mix(in oklab, var(--paper) 4%, transparent);
    color: var(--paper);
    font: 12px var(--cv-ui, var(--util));
    padding: 5px 8px;
  }
  .av-save input:focus,
  .av-rename:focus {
    outline: 1px solid var(--paper-mute);
    outline-offset: -1px;
  }
  .av-btn {
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
  .av-btn:hover,
  .av-btn.on {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .av-mini {
    font-size: 10.5px;
    padding: 2px 7px;
  }
  .av-list {
    min-height: 0;
    overflow: auto;
    padding-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .av-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px;
    border-radius: 7px;
  }
  .av-row:hover {
    background: color-mix(in oklab, var(--paper) 4%, transparent);
  }
  .av-open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .av-open:focus-visible {
    outline: 1px solid var(--paper-mute);
    outline-offset: -1px;
  }
  .av-name {
    font-size: 12.5px;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .av-what {
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .av-when {
    flex: none;
    width: 46px;
    text-align: right;
    font-size: 10px;
    color: var(--paper-faint);
  }
  .av-note {
    margin: 6px 2px 0;
    font-size: 11.5px;
    color: var(--paper-mute);
    line-height: 1.45;
  }
  .av-fault {
    margin: 6px 2px 0;
    font-size: 11.5px;
    color: var(--st-fail);
  }
</style>
