<script lang="ts">
  /* One run of inline markdown. Recursive: emphasis nests, and a link's label
     is inline markdown of its own.

     Nodes, not html — nothing here interpolates a string into the DOM, so a
     transcript containing `<script>` renders as the words it is.

     The markup below is one unbroken line on purpose. Svelte keeps template
     whitespace, so indenting the branches of this `{#each}` would insert a
     space between every word and the emphasis next to it. */
  import Self from "./Inlines.svelte";
  import InlinePicture, { type PictureSource } from "./InlinePicture.svelte";
  import { isDataPicture, pictureMarkdown, type Inline } from "./markdown";
  import { fullPath, namedPath, pathsIn } from "./finding";
  import { paths, symbolLine, useFiles, useLinks, usePictureRoot } from "./paths.svelte";
  import { useCardLinks } from "./cardlinks.svelte";
  import { useRefLinks } from "./reflinks.svelte";
  import { candidatesIn, refText, refTip, whollyAn, type Candidate, type Ref } from "./refs";
  import { refs } from "./refs.svelte";
  import { cardName } from "./naming";
  import { whois } from "./whois.svelte";
  import { handleTip, whoIs } from "./whois";
  import type { CardHandle } from "./cards.svelte";

  let { kids }: { kids: Inline[] } = $props();

  /** Where a link goes. Off the environment rather than a prop, for the reason
   *  `files` is — see `provideLinkOpener`. There is exactly one thing a link
   *  can mean in a window with no address bar, so no surface ever had anything
   *  to say about it. */
  const onlink = useLinks();

  /** What makes a path written in a sentence something you can open.
   *
   *  Off the scope rather than off a prop, which is the whole of why three
   *  surfaces used to draw an agent's paths as dead text — see the note over
   *  `scopeFiles`. `null` here is a surface with no directory behind its prose,
   *  which is how the business is opted out of and is right for a chat card. */
  const scope = useFiles();
  const files = $derived(scope());

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

  /** A place in the prose: a path as written, the line it named, and the
   *  symbol a `queue.ts::settleHold` reference named — see `symbolRef`. */
  type At = { path: string; line: number | null; symbol?: string[] };

  /** The whole of a code span, if the disk has it. */
  const spanPath = $derived.by(() => {
    const map = new Map<number, At>();
    if (!files) return map;
    for (const [i, k] of kids.entries()) {
      if (k.t !== "code") continue;
      const found = namedPath(k.v);
      if (found) map.set(i, { path: found.path, line: found.line, symbol: found.symbol });
    }
    return map;
  });

  /** Cards named by handle in the prose (`cardlinks.svelte.ts`), or null
   *  where nothing provided them — then a handle is the text it is. */
  const links = useCardLinks();
  /** What else an id can name — a sink item, a notice, a commit — and what a
   *  press on one does (`reflinks.svelte.ts`). Null where nothing provided it:
   *  then those ids are the text they are, since a chip nothing can open is a
   *  link that goes nowhere. */
  const reflinks = useRefLinks();

  /** What an id turned out to be. At most one of `card`, `gone` and `ref`. */
  type Hit = { card: CardHandle | null; gone?: string; session?: string | null; ref: Ref | null };

  /** What one candidate is, or null for "text" — which is also what it is
   *  while the answer is still on its way, so nothing flickers into a chip and
   *  back out of one (`known.ts`'s rule). Asked in the order `RefKind` states:
   *  a card on the wall, a card the store remembers, a row the store holds, a
   *  commit in this prose's repository. Reads only reactive answers, so it is
   *  safe inside a `$derived` and re-runs when one lands. */
  function classify(c: Candidate): Hit | null {
    if (c.key.length === 8) {
      const card = links ? links.find(c.key) : null;
      if (card) return { card, ref: null };
      /* A card that has left the wall is not a link — there is nothing to open
         — but the store still knows what it was called, and its handle names
         nothing to a person (`whois.ts`). Only an id the store confirms is a
         card's: a commit hash stays a hash. */
      if (links) {
        const gone = whois.stored(c.key);
        if (gone) return { card: null, gone: whoIs(gone), session: gone.session, ref: null };
        if (gone === undefined) return null;
      }
      if (reflinks) {
        const other = refs.other(c.key);
        if (other) return { card: null, ref: other };
        if (other === undefined) return null;
      }
    }
    if (reflinks && files?.root) {
      const commit = refs.commit(files.root, c.key);
      if (commit) return { card: null, ref: commit };
    }
    return null;
  }

  /** Whether any of this is worth looking for in a text at all. */
  const looksForIds = !!(links || reflinks);

  /** The whole of a code span, when it is exactly one id this app knows. */
  const spanHit = $derived.by(() => {
    const map = new Map<number, Hit>();
    if (!looksForIds) return map;
    for (const [i, k] of kids.entries()) {
      if (k.t !== "code") continue;
      const c = whollyAn(k.v);
      const hit = c ? classify(c) : null;
      if (hit) map.set(i, hit);
    }
    return map;
  });

  type Run = { text: string; at: At | null; hit: Hit | null };
  /** A text node cut into plain runs, paths and ids. Built for every text
   *  node up front rather than per render, so the template holds no logic. An
   *  id is only looked for in what is not a path. */
  const textRuns = $derived.by(() => {
    const map = new Map<number, Run[]>();
    if (!files && !looksForIds) return map;
    for (const [i, k] of kids.entries()) {
      if (k.t !== "text") continue;
      const runs: Run[] = [];
      const plain = (text: string) => {
        let from = 0;
        for (const c of looksForIds ? candidatesIn(text) : []) {
          const hit = classify(c);
          if (!hit) continue;
          if (c.from > from) runs.push({ text: text.slice(from, c.from), at: null, hit: null });
          runs.push({ text: c.text, at: null, hit });
          from = c.to;
        }
        if (from < text.length) runs.push({ text: text.slice(from), at: null, hit: null });
      };
      let from = 0;
      for (const f of files ? pathsIn(k.v) : []) {
        if (f.from > from) plain(k.v.slice(from, f.from));
        runs.push({ text: k.v.slice(f.from, f.to), at: { path: f.path, line: f.line, symbol: f.symbol }, hit: null });
        from = f.to;
      }
      if (from < k.v.length) plain(k.v.slice(from));
      if (runs.some((r) => r.at || r.hit)) map.set(i, runs);
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
    for (const at of spanPath.values()) paths.want(root, at);
    for (const runs of textRuns.values()) {
      for (const r of runs) if (r.at) paths.want(root, r.at);
    }
  });

  /** Where a place opens and what it is, or null while the disk has not
   *  answered — which draws as plain text, so nothing flickers into a link and
   *  back out of one. A bare `queue.ts::settleHold` is the file the name
   *  resolved to, which is the path the link carries from here on. */
  function targetOf(at: At) {
    return files ? paths.target(files.root, at) : null;
  }

  /** Ctrl is "the other thing you can do with this", which here is Explorer:
   *  for a file instead of the viewer, for a folder instead of opening it.
   *  Said in the title, because a modifier nobody is told about is one nobody
   *  uses, and repeated in the right-click menu for the same reason. */
  function go(e: MouseEvent, path: string, at: At) {
    const how = e.ctrlKey || e.metaKey ? "reveal" : "open";
    const scope = files;
    if (!scope) return;
    /* The symbol is looked for now, at the press, and only for an open —
       reading the file to find a definition is a cost one click pays, never
       one a render does. Not found opens the file at the top. */
    if (at.symbol && how === "open") {
      void symbolLine(scope.root, path, at.symbol).then((line) => scope.go(path, line, how));
      return;
    }
    scope.go(path, at.line, how);
  }

  /** Where a picture written in the prose is read from, or `null` where it
   *  cannot be: a file needs a directory behind the prose to count from and a
   *  surface allowed to reach the disk at all — the file scope a path link
   *  needs, unless the surface said otherwise (`usePictureRoot`) — so a chat
   *  card's `![…](C:\…)` stays words. A `data:` picture carries its own bytes
   *  and needs neither. See `pictureSource`. */
  const pictureRoot = usePictureRoot();
  function pictureFrom(src: string): PictureSource | null {
    if (isDataPicture(src)) return { kind: "data", url: src };
    const root = pictureRoot();
    if (!root) return null;
    return { kind: "file", path: fullPath(root, src) };
  }

  function hint(path: string, dir: boolean, symbol?: string[]): string {
    if (dir) return `Open ${path} in Explorer · ctrl-click to show it in Explorer`;
    const where = symbol ? ` at ${symbol.join("::")}` : "";
    return `Look at ${path}${where} · ctrl-click to show it in Explorer`;
  }
</script>

<!-- A link is a button with no href: this window has no address bar and no way
     back, so a real navigation would take the studio somewhere it cannot return
     from. The click is a command that opens the link where links belong.

     A path is the same shape of thing one layer in — a button that reads as the
     text it replaced — and carries `data-path` *and the root it counts from*
     so the right-click can find both without the menu needing to know anything
     about markdown. The root travels on the element because that is the only
     place it is still true: the menu fires from a document-level listener, and
     reading the focused card there resolved a path in one project's question
     against another project's directory. -->
{#each kids as k, i (i)}{#if k.t === "text"}{#if textRuns.has(i)}{#each textRuns.get(i)! as run, ri (ri)}{#if run.at && targetOf(run.at)}{@const at =
          run.at}{@const to = targetOf(at)!}{@const dir = to.kind === "dir"}<button
        type="button"
        class="path"
        class:dir
        data-path={to.path}
        data-root={files?.root}
        data-dir={dir ? "1" : null}
        title={hint(to.path, dir, at.symbol)}
        onclick={(e) => go(e, to.path, at)}>{run.text}</button
      >{:else if run.hit}{@render hit(run.hit, run.text)}{:else}{run.text}{/if}{/each}{:else}{k.v}{/if}{:else if k.t === "code" && spanHit.has(i)}{@render hit(spanHit.get(i)!, "`" + k.v + "`")}{:else if k.t === "code"}{#if spanPath.has(i) && targetOf(spanPath.get(i)!)}{@const at =
        spanPath.get(i)!}{@const to = targetOf(at)!}{@const dir = to.kind === "dir"}<button
      type="button"
      class="path code"
      class:dir
      data-path={to.path}
      data-root={files?.root}
      data-dir={dir ? "1" : null}
      title={hint(to.path, dir, at.symbol)}
      onclick={(e) => go(e, to.path, at)}><code>{k.v}</code></button
    >{:else}<code>{k.v}</code>{/if}{:else if k.t === "strong"}<strong
      ><Self kids={k.kids} /></strong
    >{:else if k.t === "em"}<em><Self kids={k.kids} /></em
    >{:else if k.t === "del"}<del><Self kids={k.kids} /></del
    >{:else if k.t === "img"}{@const pic = pictureFrom(k.src)}{#if pic}<InlinePicture
        source={pic}
        alt={k.alt}
        md={pictureMarkdown(k.alt, k.src)}
      />{:else}<span class="unpictured" data-md={pictureMarkdown(k.alt, k.src)}
        >{k.alt || k.src}</span
      >{/if}{:else if k.t === "link"}<button
      type="button"
      class="link"
      title={k.href}
      onclick={() => onlink?.(k.href)}><Self kids={k.kids} /></button
    >{/if}{/each}

<!-- An id drawn as the thing it names: a card by its name and its live dot, a
     sink item, a notice or a commit by its title or subject behind a small
     shape of its own. A button reading as prose, like a path — this app noticed
     it, the author did not write a link — and `data-md` carries the id as it
     was written, so a copy gives back what the agent said and not what this
     window drew in its place (`copy.ts`).

     The shape is the kind, and it is never a colour: a card's dot is a status
     and the only coloured thing here, while a sink item is a square, a notice a
     hairline square and a commit a diamond. Colour on this wall is status. -->
{#snippet hit(h: Hit, md: string)}{#if h.card}{@const c = h.card}<button
      type="button"
      class="cardlink"
      data-card={c.id}
      data-md={md}
      onclick={() => links?.open(c)}
      ><i
        class="st"
        class:work={c.face.working}
        class:ask={!!c.ask}
        class:fail={c.face.tier === "fail"}
        aria-hidden="true"
      ></i>{cardName(c.face.title, "").text || "a conversation"}</button
    >{:else if h.gone && h.session && links?.revive}{@const session = h.session}<button
      type="button"
      class="cardlink cardgone"
      data-md={md}
      title="{handleTip(md.replaceAll('`', ''))} — no longer on the wall; bring it back"
      onclick={() => links?.revive?.(session)}>{h.gone}</button
    >{:else if h.gone}<span class="cardgone" data-md={md} title="{handleTip(md.replaceAll('`', ''))} — no longer on the wall">{h.gone}</span>{:else if h.ref}{@const r = h.ref}<button
      type="button"
      class="cardlink refchip {r.kind}"
      class:settled={r.kind === "sink" && r.settled}
      data-ref={r.kind}
      data-md={md}
      title={reflinks?.hover ? undefined : refTip(r)}
      onpointerenter={(e) => reflinks?.hover?.(r, e.currentTarget)}
      onpointerleave={() => reflinks?.unhover?.()}
      onclick={() => {
        reflinks?.unhover?.();
        reflinks?.open(r);
      }}
      ><i class="shape" aria-hidden="true"></i>{refText(r)}</button
    >{/if}{/snippet}

<style>
  /* A card that has left the wall: named, set as the prose around it, and no
     dot — a dot is a status and a closed card has none. */
  .cardgone {
    color: var(--paper-mute);
    text-decoration: underline dotted;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
  }
  .cardlink {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 2px;
  }
  .cardlink:hover,
  .cardlink:focus-visible {
    color: var(--paper);
    text-decoration-color: var(--paper);
  }
  /* A closed card's name you can bring back: dimmed and dotted like the one you
     cannot, and firming up under the pointer like any link. */
  .cardlink.cardgone {
    color: var(--paper-mute);
    text-decoration: underline dotted;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
  }
  .cardlink.cardgone:hover,
  .cardlink.cardgone:focus-visible {
    color: var(--paper);
    text-decoration-color: var(--paper-faint);
  }
  .cardlink .st {
    display: inline-block;
    width: 0.42em;
    height: 0.42em;
    margin: 0 0.3em 0.12em 0.05em;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--st-rest);
  }
  .cardlink .st.work {
    background: var(--st-work);
  }
  .cardlink .st.ask {
    background: var(--st-ask);
  }
  .cardlink .st.fail {
    background: var(--st-fail);
  }
  /* The kind of a chip is a shape drawn beside its words, in the ink the words
     are in. */
  .refchip .shape {
    display: inline-block;
    width: 0.42em;
    height: 0.42em;
    margin: 0 0.3em 0.12em 0.05em;
    vertical-align: middle;
    background: var(--paper-mute);
  }
  .refchip.notice .shape {
    background: none;
    border: 1px solid var(--paper-mute);
  }
  .refchip.commit .shape {
    transform: rotate(45deg) scale(0.9);
  }
  /* A settled sink item is dealt with: the words stay, quieter. */
  .refchip.settled {
    color: var(--paper-mute);
  }
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

  /* A picture this surface may not read — a chat card's prose names a file it
     has no directory to read from. Its words, quietly, so the sentence around
     it still says what was meant to be there. */
  .unpictured {
    font-style: italic;
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
</style>
