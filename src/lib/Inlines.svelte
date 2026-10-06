<script lang="ts">
  /* One run of inline markdown. Recursive: emphasis nests, and a link's label
     is inline markdown of its own.

     Nodes, not html — nothing here interpolates a string into the DOM, so a
     transcript containing `<script>` renders as the words it is.

     The markup below is one unbroken line on purpose. Svelte keeps template
     whitespace, so indenting the branches of this `{#each}` would insert a
     space between every word and the emphasis next to it. */
  import Self from "./Inlines.svelte";
  import type { Inline } from "./markdown";
  import { namedPath, pathsIn, type FileLinks } from "./finding";
  import { paths } from "./paths.svelte";

  let {
    kids,
    onlink,
    files,
  }: {
    kids: Inline[];
    /** Routed out rather than invoked: a link leaves the app, and `skein` is
     *  the only thing that talks to Rust. */
    onlink?: (href: string) => void;
    /** What makes a path written in a sentence something you can open. Absent
     *  where there is no project behind the prose, which is how a surface opts
     *  out of the whole business. See `finding.ts`. */
    files?: FileLinks;
  } = $props();

  /* ── paths named in the prose ──────────────────────────────────────────
     An agent writes a path far more often than it writes a markdown link, and
     until now every one of them was dead text you retyped into the finder.

     Two sources, deliberately asked different questions. A **code span** is one
     candidate whole, because an author who wrapped something in backticks has
     already said it is a thing rather than words, and because a Windows path
     has spaces in it that a tokeniser would cut. **Plain text** is tokenised on
     whitespace, since a sentence is mostly not paths.

     Neither is trusted. `finding.ts` only knows the *shape* of a path, so
     nothing is drawn as a link until `paths.svelte.ts` has heard from the disk
     that it is there — which is also what says whether clicking it opens a
     file or a folder. */

  /** The whole of a code span, if the disk has it. */
  const spanPath = $derived.by(() => {
    const map = new Map<number, { path: string; line: number | null }>();
    if (!files) return map;
    for (const [i, k] of kids.entries()) {
      if (k.t !== "code") continue;
      const found = namedPath(k.v);
      if (found) map.set(i, { path: found.path, line: found.line });
    }
    return map;
  });

  /** A text node cut into plain runs and paths. Built for every text node up
   *  front rather than per render, so the template holds no logic. */
  const textRuns = $derived.by(() => {
    const map = new Map<number, { text: string; at: { path: string; line: number | null } | null }[]>();
    if (!files) return map;
    for (const [i, k] of kids.entries()) {
      if (k.t !== "text") continue;
      const found = pathsIn(k.v);
      if (!found.length) continue;
      const runs: { text: string; at: { path: string; line: number | null } | null }[] = [];
      let from = 0;
      for (const f of found) {
        if (f.from > from) runs.push({ text: k.v.slice(from, f.from), at: null });
        runs.push({ text: k.v.slice(f.from, f.to), at: { path: f.path, line: f.line } });
        from = f.to;
      }
      if (from < k.v.length) runs.push({ text: k.v.slice(from), at: null });
      map.set(i, runs);
    }
    return map;
  });

  /* Every candidate is asked about once. In an effect rather than inside the
     deriveds above, because a `$derived` that reaches out and queues work is a
     side effect wearing a value's clothes — and this one runs again whenever a
     streaming answer rewrites the paragraph. `paths.ask` is idempotent, so the
     repeats cost a map lookup each. */
  $effect(() => {
    const root = files?.root;
    if (!root) return;
    for (const at of spanPath.values()) paths.ask(root, at.path);
    for (const runs of textRuns.values()) {
      for (const r of runs) if (r.at) paths.ask(root, r.at.path);
    }
  });

  /** What a path is, or null while the disk has not answered — which draws as
   *  plain text, so nothing flickers into a link and back out of one. */
  function kindOf(path: string) {
    return files ? (paths.kind(files.root, path) ?? null) : null;
  }

  /** Ctrl is "the other thing you can do with this", which here is Explorer:
   *  for a file instead of the viewer, for a folder instead of opening it.
   *  Said in the title, because a modifier nobody is told about is one nobody
   *  uses, and repeated in the right-click menu for the same reason. */
  function go(e: MouseEvent, path: string, line: number | null) {
    files?.go(path, line, e.ctrlKey || e.metaKey ? "reveal" : "open");
  }

  function hint(path: string, dir: boolean): string {
    return dir
      ? `Open ${path} in Explorer · ctrl-click to show it in Explorer`
      : `Look at ${path} · ctrl-click to show it in Explorer`;
  }
</script>

<!-- A link is a button with no href: this window has no address bar and no way
     back, so a real navigation would take the studio somewhere it cannot return
     from. The click is a command that opens the link where links belong.

     A path is the same shape of thing one layer in — a button that reads as the
     text it replaced — and carries `data-path` so the right-click can find it
     without the menu needing to know anything about markdown. -->
{#each kids as k, i (i)}{#if k.t === "text"}{#if textRuns.has(i)}{#each textRuns.get(i)! as run, ri (ri)}{#if run.at && kindOf(run.at.path)}{@const at =
          run.at}{@const dir = kindOf(at.path) === "dir"}<button
        type="button"
        class="path"
        class:dir
        data-path={at.path}
        data-dir={dir ? "1" : null}
        title={hint(at.path, dir)}
        onclick={(e) => go(e, at.path, at.line)}>{run.text}</button
      >{:else}{run.text}{/if}{/each}{:else}{k.v}{/if}{:else if k.t === "code"}{#if spanPath.has(i) && kindOf(spanPath.get(i)!.path)}{@const at =
        spanPath.get(i)!}{@const dir = kindOf(at.path) === "dir"}<button
      type="button"
      class="path code"
      class:dir
      data-path={at.path}
      data-dir={dir ? "1" : null}
      title={hint(at.path, dir)}
      onclick={(e) => go(e, at.path, at.line)}><code>{k.v}</code></button
    >{:else}<code>{k.v}</code>{/if}{:else if k.t === "strong"}<strong
      ><Self kids={k.kids} {onlink} {files} /></strong
    >{:else if k.t === "em"}<em><Self kids={k.kids} {onlink} {files} /></em
    >{:else if k.t === "del"}<del><Self kids={k.kids} {onlink} {files} /></del
    >{:else if k.t === "link"}<button
      type="button"
      class="link"
      title={k.href}
      onclick={() => onlink?.(k.href)}><Self kids={k.kids} {onlink} {files} /></button
    >{/if}{/each}

<style>
  code {
    font-family: var(--mono);
    font-size: 0.86em;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.05em 0.3em;
    /* A path or an identifier may be longer than the column; break it rather
       than widen the panel. */
    overflow-wrap: anywhere;
  }

  strong {
    color: var(--paper);
    font-weight: 600;
  }

  em {
    font-style: italic;
  }

  del {
    text-decoration: line-through;
    color: var(--paper-mute);
  }

  /* A button that reads as prose. Underlined rather than coloured — colour on
     this wall means status, and a link is not a status. */
  .link {
    font: inherit;
    color: var(--paper);
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .link:hover {
    text-decoration-color: var(--paper);
  }

  /* A path reads as the text it replaced and says so only under the cursor.
     Quieter than a link on purpose: a link is something the author *wrote* as
     a link, and a path is something this app noticed — so it should not change
     how a paragraph looks until you go near it. Dotted rather than solid for
     the same reason, and `overflow-wrap` because a path is the one run of text
     in a transcript routinely longer than the column. */
  .path {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    overflow-wrap: anywhere;
    text-decoration: underline dotted;
    text-decoration-color: transparent;
    text-underline-offset: 2px;
    cursor: pointer;
    transition: text-decoration-color 0.1s ease;
  }
  .path:hover,
  .path:focus-visible {
    color: var(--paper);
    text-decoration-color: var(--paper-faint);
  }
  /* A folder opens somewhere else entirely, so it gets the cursor that says a
     press leaves the app. */
  .path.dir {
    cursor: alias;
  }
  /* Wrapping a code span rather than replacing it: the box, the mono and the
     line-breaking are the span's own and must not move because it turned out
     to be a path. */
  .path.code {
    display: inline;
  }
  :global(html[data-motion="still"]) .path {
    transition: none;
  }
</style>
