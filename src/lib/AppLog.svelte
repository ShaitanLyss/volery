<script lang="ts">
  /* What Volery itself is saying, on the wall.
   *
   * The fourth log over `logface`'s substrate and the plainest of them: the
   * other three pick a subject — a server group, a project's last run, a
   * running editor — and this one cannot, because there is exactly one process
   * and it says one stream of things. So no chooser, no absence to explain, no
   * button. A narrowing, a gutter, and the lines.
   *
   * ### Why it exists
   *
   * Until 2026-08-28 this app installed no `log` sink at all, so every `info!`,
   * `warn!` and `error!` in every dependency was formatted and thrown away.
   * That cost a day: librespot spent four minutes explaining, on a
   * twenty-one-second cadence, precisely why Spotify would not connect —
   * "Connecting to AP", "Tried too many access points", "will be ignored while
   * Not Active", "Input volume 32767 mapped to: 3.16%" — and every one of those
   * lines was a whole bug's diagnosis going nowhere. Recovering them took a
   * throwaway cargo crate and four browser sign-ins from the user.
   *
   * `applog.rs` holds the ring and the level filter and the argument for both;
   * `applog.ts` is pure and holds every judgement about what a line *means*.
   * What is here is the drawing.
   *
   * Two things about it are deliberate:
   *
   * - **The dot reads the whole log, not the last line.** One error four
   *   hundred lines back is still the most important thing this widget knows,
   *   and a dot that went green again because the next line was routine would
   *   be hiding it. `pulseOf` in `applog.ts`.
   * - **`tint` is off.** The tone reaches the gutter mark and not the text, the
   *   same choice the server and build logs make: these are somebody else's
   *   words, and colouring a whole line rust because a crate chose `warn!` for
   *   something perfectly routine would be Volery overruling it. The level is
   *   already in the gutter.
   */

  import { onDestroy } from "svelte";
  import {
    absence,
    normalizeConfig,
    pulseOf,
    rowsOf,
    standing,
    keeping,
  } from "./applog";
  import { journal } from "./journal.svelte";
  import { linesFor, tail } from "./logface";
  import LogFace from "./LogFace.svelte";
  import LogTail from "./LogTail.svelte";
  import type { Widget } from "./widgets";

  let { widget }: { widget: Widget } = $props();

  const cfg = $derived(normalizeConfig(widget.config));
  const rows = $derived(linesFor(widget.h));
  const cut = $derived(tail(journal.lines, keeping(cfg.showing), rows));

  /* Derived rather than captured once, for the reason `Spotify.svelte` gives:
     `widget` is a prop, and reading `.id` at setup would pin this face to
     whichever widget it happened to draw first. */
  const id = $derived(`applog-${widget.id}`);
  $effect(() => {
    const mine = id;
    journal.attach(mine);
    return () => journal.detach(mine);
  });
  onDestroy(() => journal.detach(id));

  /* Counted over everything kept rather than over the drawn tail, which is what
     makes it worth reading: "3 errors" on a pane showing none of them is the
     number that tells you to make the widget bigger or narrow it. */
  const stand = $derived(standing(journal.lines));
  const note = $derived(
    cut.lines.length > 0
      ? null
      : (absence(cut.hidden, cfg.showing) ?? "nothing said yet"),
  );

  const drawn = $derived(
    cfg.marks ? rowsOf(cut.lines) : rowsOf(cut.lines).map((r) => ({ ...r, mark: null })),
  );
</script>

<LogFace
  pulse={pulseOf(journal.lines)}
  name="volery"
  sub="its own log"
  title="what this app and its dependencies are saying — SKEIN_LOG raises the level"
  {note}
>
  {#snippet chips()}
    <span class="stat">{stand}</span>
  {/snippet}

  <LogTail rows={drawn} />
</LogFace>
