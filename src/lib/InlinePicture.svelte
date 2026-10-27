<script module lang="ts">
  import { PictureCache, Sizes, type Dims, type PictureSource } from "./showing";

  /** Where a picture comes from — decided by `showing.ts::proseSource` and
   *  `keptSource` off the root the surface counts from, never by the surface.
   *  This is the one component that reads one, and the one that knows a read
   *  can go to another wall. */
  export type { PictureSource };

  /* One cache and one measure for every picture in the window, since the panel
     draws one card at a time and a picture scrolled past on one card is not
     worth memory while another is being read. See `showing.ts`. */
  const cache = new PictureCache();
  const sizes = new Sizes();

  /** What the window is holding, for the control surface's snapshot — a
   *  budget nothing can see from outside is a budget nobody can check. */
  export function pictureHeld(): { chars: number; kept: number } {
    return { chars: cache.used, kept: cache.size };
  }

  /** The nearest box that scrolls, which is what "near the view" has to be
   *  measured against: the panel's column clips what it holds, so a margin on
   *  the window would only ever widen a rectangle the picture can never be
   *  seen through — no reading ahead, and a picture let go of the moment it
   *  left the column (found in review). The transcript, the dock and the file
   *  viewer each scroll in a box of their own, so it is looked up rather than
   *  named. `null` is the window. */
  export function scrollRootOf(el: Element): Element | null {
    let root: Element | null = el.parentElement;
    while (root && root !== document.body) {
      const o = getComputedStyle(root).overflowY;
      if (o === "auto" || o === "scroll") return root;
      root = root.parentElement;
    }
    return null;
  }
</script>

<script lang="ts">
  /* A picture in the transcript: one an agent wrote into its prose as
     `![alt](path)`, one it showed with the `show` tool, or a diagram it wrote
     as a mermaid fence.

     Drawn as an `<img>` over a `data:` URL read through Rust, never a url the
     webview fetches — the same containment the file viewer keeps
     (`.claude/rules/finding.md`), and an `<img>` is the one element that draws
     an svg with its scripts and its external references switched off.

     **Its box is the picture's before a byte of it has decoded.** The size
     comes first — off the `show` result, out of the measures this window has
     taken, or from Rust reading the file's header — and the box is drawn at it,
     so prose never moves as a figure lands. The bytes come second, and only
     near the view: a picture is always open, unlike one in a tool call's fold,
     so the fold's bound (decoding is paid for by a click) does not reach it,
     and the viewport does instead. See `.claude/rules/showing.md`. */
  import { invoke } from "@tauri-apps/api/core";
  import { untrack } from "svelte";
  import { CACHE_CHARS, frameWidth, megabytes, nameOf, sourceKey } from "./showing";
  import { useOpener } from "./paths.svelte";
  import { lightbox } from "./looking.svelte";
  import { DRAG_SLOP, copyPicture, dragOut, offerPicture, stagePicture, type PictureHandle } from "./picturecopy";

  let {
    source,
    alt = "",
    md,
    size = undefined,
    caption = "",
    paper = undefined,
  }: {
    source: PictureSource;
    alt?: string;
    /** The markdown this picture copies as — `copy.ts` writes it back in
     *  place of the drawing, so a selection across a figure is not a gap. */
    md: string;
    /** Its size when the caller already knows it — a `show` result says. */
    size?: Dims;
    /** Carried into the full-size view. */
    caption?: string;
    /** A white page behind it. Defaults to yes for an svg, which is nearly
     *  always drawn for one; a diagram drawn in this window's own palette says
     *  no. */
    paper?: boolean;
  } = $props();

  /** Opening the file it came from: the viewer, rooted at the picture's own
   *  folder, or Explorer. Null for a surface with no directory behind its
   *  prose, which is a chat card. */
  const opener = useOpener();

  /** How long a picture out of reach keeps its bytes. Long enough that
   *  scrolling past and back is not a read; short enough that a column of them
   *  scrolled through once is not held. */
  const LET_GO_MS = 20_000;

  /** What a header says — see `show::Measure`. */
  type Measure = { size: [number, number] | null; tooLarge: boolean };

  /** The head of a `data:` picture's base64, which is where every format says
   *  its size. */
  const headOf = (url: string) => {
    const comma = url.indexOf(",") + 1;
    return url.slice(comma, comma + 65_536);
  };

  type Read = {
    dataUrl: string;
    bytes: number;
    tooLarge: boolean;
    path: string;
    size: [number, number] | null;
    /** From another wall: its kept copy had gone, and this is the file. */
    stale?: boolean;
    /** From another wall: drawn from this wall's copy because that wall
     *  could not be asked, and why. */
    note?: string | null;
  };

  /** What a picture on another wall is asked by: the card, and the copy or
   *  the path as the card wrote it — or the tool call that answered with it
   *  and its place among that call's pictures. */
  const afarArgs = (s: Extract<PictureSource, { kind: "afar" }>) => ({
    host: s.host,
    card: s.card,
    kept: s.kept,
    path: s.path || null,
    call: s.call ?? null,
    n: s.n ?? null,
  });

  /** A picture that never changes once made: a `show` copy, here or on the
   *  wall a card runs on, or what a tool call answered with there. Cached, and
   *  asked for once. */
  const fixed = (s: PictureSource) => s.kind === "kept" || (s.kind === "afar" && (!!s.kept || !!s.call));

  /* A key that names the picture without hashing megabytes of base64 every
     time the streaming tail is parsed again: the parse makes a new string per
     token, and the effects below are keyed on this rather than on the object. */
  const key = $derived(sourceKey(source));
  const svg = $derived(
    source.kind === "data"
      ? source.url.startsWith("data:image/svg+xml")
      : /\.svg$/i.test(
          source.kind === "kept" ? source.id : source.kind === "afar" ? (source.kept ?? source.path) : source.path,
        ),
  );
  const backed = $derived(paper ?? svg);
  const name = $derived(
    source.kind === "data"
      ? "picture"
      : source.kind === "afar" && source.call
        ? `picture ${(source.n ?? 0) + 1}`
        : nameOf(
          source.kind === "kept"
            ? source.path || source.id
            : source.kind === "afar"
              ? source.path || source.kept || ""
              : source.path,
        ),
  );
  const label = $derived(alt || name);

  let url = $state<string | null>(null);
  let held = ""; // the key `url` belongs to
  /** Why it is not drawn, said in a sentence that names it. */
  let fault = $state<string | null>(null);
  let large = $state<number | null>(null);
  /** The kept copy had gone and this is the file it came from, as it is now. */
  let stale = $state(false);
  /** Said by a picture from another wall: drawn from this wall's copy. */
  let note = $state<string | null>(null);
  /** Where a click opens it — what was actually read. */
  let at = $state<string | null>(null);
  let near = $state(false);
  let dims = $state<Dims | undefined>(undefined);
  /** Decoded, so the fade can finish. */
  let shown = $state(false);
  let gen = 0;
  let letGo = 0;
  let hit = $state<HTMLElement | null>(null);

  /* The size, in the order the sources are sure of it: what the caller was
     told, then what this window has measured. Set before paint, so the box is
     right on the first frame. */
  $effect.pre(() => {
    const k = key;
    const known = size ?? sizes.get(k);
    if (known) {
      dims = known;
      if (size) untrack(() => sizes.set(k, size.w, size.h));
    } else dims = undefined;
  });

  /* And failing both, the header — asked at once rather than when the picture
     comes near, because it costs a few hundred bytes of a read and is the
     difference between a box that is right before you scroll to it and one
     that grows as you do. The whole picture still waits for the view. */
  $effect(() => {
    const k = key;
    if (untrack(() => dims)) return;
    const src = untrack(() => source);
    const ask =
      src.kind === "file"
        ? invoke<Measure>("measure_picture", { path: src.path })
        : src.kind === "data"
          ? invoke<Measure>("measure_picture_data", { head: headOf(src.url) })
          : src.kind === "afar" && !src.call
            ? invoke<Measure>("flyway_see_measure", afarArgs(src))
            : null; /* a call's picture is in a fold opened by a click, and
                       measuring it would read the far conversation twice */
    void ask
      ?.then((got) => {
        const s = got?.size;
        if (!s || key !== k || dims) return;
        sizes.set(k, s[0], s[1]);
        dims = { w: s[0], h: s[1] };
      })
      .catch(() => {});
  });

  $effect(() => {
    const k = key;
    if (!near) return;
    untrack(() => void load(k));
  });

  async function load(k: string) {
    if (url && held === k) return;
    const mine = ++gen;
    fault = null;
    large = null;
    stale = false;
    note = null;
    const src = untrack(() => source);
    if (src.kind === "data") {
      /* No read stands between a `data:` picture and the decode, so the pixel
         cap is asked here, before it is given its `src`: four megabytes of
         base64 can declare a picture forty thousand pixels square, and the
         decode is the one webview the wall is drawn in (found in review). A
         header that says nothing is let through — the bytes are already capped
         at `MAX_IMAGE_CHARS`. */
      let m: Measure | null = null;
      try {
        m = await invoke<Measure>("measure_picture_data", { head: headOf(src.url) });
      } catch {}
      if (mine !== gen) return;
      at = null;
      if (m?.tooLarge) {
        large = Math.floor((src.url.length - src.url.indexOf(",") - 1) * 0.75);
        url = null;
        return;
      }
      url = src.url;
      held = k;
      return;
    }
    if (fixed(src)) {
      /* The cache keeps where the copy was read from beside its bytes, so a
         figure drawn again from it can still be opened (found in review). */
      const got = cache.get(k);
      if (got) {
        const cut = got.indexOf("\n");
        at = got.slice(0, cut) || null;
        url = got.slice(cut + 1);
        held = k;
        return;
      }
    }
    try {
      let pic: Read;
      let fallback = false;
      if (src.kind === "afar") {
        /* On another wall: that wall reads it, this one checks the bytes and
           keeps a copy (`flyway/seeing.rs`, `link/seen.rs`). Nothing here is
           where it came from, so there is no file for a click to open. */
        try {
          pic = await invoke<Read>("flyway_see_picture", afarArgs(src));
        } catch (e) {
          const why = String(e).replace(/^Error:\s*/, "");
          throw new Error(
            src.kept
              ? `${name} was shown on ${src.host}, and its copy is kept there — ${why}`
              : src.call
                ? `${name} of this call is kept on ${src.host} — ${why}`
                : `${name} is on ${src.host} — ${why}`,
          );
        }
        fallback = !!pic.stale;
      } else if (src.kind === "kept") {
        try {
          pic = await invoke<Read>("read_shown", { id: src.id });
        } catch {
          /* Swept by the budget, or a card read off another machine's wall:
             the file it came from is the next best thing, and it says so,
             since it may not be the picture that was shown. */
          if (!src.path) throw new Error(`${name} is no longer kept, and there is no file to fall back on`);
          try {
            pic = await invoke<Read>("read_picture", { path: src.path });
          } catch {
            throw new Error(`${name} is no longer kept, and the file it came from is not there either`);
          }
          fallback = true;
        }
      } else {
        pic = await invoke<Read>("read_picture", { path: src.path });
      }
      if (mine !== gen) return;
      at = pic.path || null;
      stale = fallback;
      note = pic.note ?? null;
      if (pic.size && !dims) {
        sizes.set(k, pic.size[0], pic.size[1]);
        dims = { w: pic.size[0], h: pic.size[1] };
      }
      if (pic.tooLarge) {
        large = pic.bytes;
        url = null;
        return;
      }
      if (fixed(src) && !fallback && pic.dataUrl.length <= CACHE_CHARS)
        cache.put(k, `${pic.path}\n${pic.dataUrl}`);
      url = pic.dataUrl;
      held = k;
    } catch (e) {
      if (mine !== gen) return;
      fault = String(e).replace(/^Error:\s*/, "");
      url = null;
    }
  }

  function measured(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    shown = true;
    if (!img.naturalWidth || !img.naturalHeight) return;
    /* The decode is the last word on size: a header can be missing, and a
       photo's EXIF can turn it on its side. */
    sizes.set(key, img.naturalWidth, img.naturalHeight);
    if (!dims || dims.w !== img.naturalWidth || dims.h !== img.naturalHeight)
      dims = { w: img.naturalWidth, h: img.naturalHeight };
  }

  function broke() {
    fault = `${label} could not be drawn — its bytes are not a picture this window can decode`;
    url = null;
  }

  /** Bytes only while near enough to be seen. A picture that has *not yet*
   *  been near reads nothing at all, which is what makes a restored card with
   *  forty figures cost forty reads only if you scroll through all forty. */
  function watch(el: HTMLElement) {
    const root = scrollRootOf(el);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          near = e.isIntersecting;
          clearTimeout(letGo);
          if (!near && source.kind !== "data")
            letGo = window.setTimeout(() => {
              if (near) return;
              gen++;
              url = null;
              shown = false;
              held = "";
            }, LET_GO_MS);
        }
      },
      { root, rootMargin: "150% 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(letGo);
      gen++;
    };
  }

  /** The full-size view. What it opens with is what is drawn here — the same
   *  bytes, the same size — so it is never a second read. */
  function look(e: MouseEvent) {
    /* Never also the press of something it sits inside. */
    e.stopPropagation();
    if (dragged) {
      dragged = false;
      return;
    }
    if (!url) return;
    const img = hit?.querySelector("img");
    const w = dims?.w ?? img?.naturalWidth ?? 0;
    const h = dims?.h ?? img?.naturalHeight ?? 0;
    if (!w || !h) return;
    const go = opener();
    const file = at;
    lightbox.open(
      {
        url,
        w,
        h,
        svg,
        paper: backed,
        /* A picture that carries its own bytes has no file name to go by, and
           its words — a diagram's kind, an alt — are the name it has. */
        name: source.kind === "data" ? label : name,
        alt: label,
        caption,
        go: go && file ? (how: "open" | "reveal") => go(file, how) : null,
      },
      hit,
    );
  }

  /* What the window's right-click and the hover button both ask of this
     picture. Read at the moment of the gesture — the bytes come and go with the
     view — so nothing here is a copy of state. */
  let copied = $state(false);
  let copiedAt = 0;
  const handle: PictureHandle = {
    url: () => url,
    get svg() {
      return svg;
    },
    get name() {
      return source.kind === "data" ? label : name;
    },
    dims: () => dims,
    go: () => {
      const go = opener();
      const file = at;
      return go && file ? (how) => go(file, how) : null;
    },
    copied: () => {
      copied = true;
      clearTimeout(copiedAt);
      copiedAt = window.setTimeout(() => (copied = false), 1600);
    },
  };
  let copyFault = $state(false);
  async function copy(e: MouseEvent) {
    e.stopPropagation();
    copyFault = false;
    try {
      await copyPicture(handle);
    } catch {
      copyFault = true;
      clearTimeout(copiedAt);
      copiedAt = window.setTimeout(() => (copyFault = false), 2400);
    }
  }
  const offer = (el: HTMLElement) => offerPicture(el, handle);

  /* Dragging it out to another app. Plain variables, not state: a press and a
     drag change nothing that is drawn, so nothing here may re-render the column.
     The file is written when the press lands, since the drag has to begin while
     the button is still down; a click that never travels costs one write per
     picture, remembered by the bytes it was written from. */
  let downAt: { x: number; y: number } | null = null;
  let staged: { from: string; path: Promise<string> } | null = null;
  /** The drag ate the press's release, so the click after it is not a click. */
  let dragged = false;

  function press(e: PointerEvent) {
    if (e.button !== 0 || !url) return;
    dragged = false;
    downAt = { x: e.clientX, y: e.clientY };
    if (staged?.from !== url) {
      const path = stagePicture(handle);
      path.catch(() => {});
      staged = { from: url, path };
    }
  }
  function travel(e: PointerEvent) {
    if (!downAt) return;
    if (e.buttons === 0) {
      downAt = null;
      return;
    }
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < DRAG_SLOP) return;
    downAt = null;
    dragged = true;
    void staged?.path
      .then((path) => dragOut(path))
      .catch((err) => console.warn("could not drag the picture out", err));
  }

  function openFile(e: MouseEvent) {
    const go = opener();
    if (go && at) go(at, e.ctrlKey || e.metaKey ? "reveal" : "open");
  }

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const width = $derived(dims ? frameWidth(dims.w, dims.h, svg ? 1 : dpr) : null);
  const ratio = $derived(dims ? `${dims.w} / ${dims.h}` : null);
  /** Why it is too large, in the unit that is the reason: its pixels when it
   *  would decode to too many of them — a bomb can be a few kilobytes, and
   *  "0.0 MB — more than a transcript draws" would be a sentence that
   *  contradicts itself — and its bytes otherwise. */
  const tooLargeSaid = $derived(
    large === null
      ? ""
      : dims && dims.w * dims.h > 50_000_000
        ? `is ${dims.w}×${dims.h} pixels`
        : large > 3_000_000
          ? `is ${megabytes(large)}`
          : "declares more pixels",
  );
</script>

<!-- A span all the way down, not a div or a figure: a picture written in prose
     sits inside a paragraph, and a block element there is invalid markup the
     parser would close the paragraph around. `display: block` gives it the box.

     `data-md` is what `copy.ts` writes in its place — a selection across a
     picture copies as the markdown that drew it, never as a gap and never as
     megabytes of base64.

     A picture that is not drawn keeps the box it would have had when its size
     is known, and says which and why inside it — never a blank gap, and never
     the browser's broken-image glyph. -->
<span
  class="pic"
  class:missing={!!fault || large !== null}
  class:paper={backed && !!url && !fault}
  class:sized={!!dims}
  class:held={!!url}
  data-md={md}
  data-picture
  {@attach offer}
  style:aspect-ratio={ratio}
  style:width
  role={fault || large !== null ? "note" : null}
  {@attach watch}
  >{#if fault}<span class="why">{fault}</span>{:else if large !== null}<span class="why"
      ><span class="what">{name}</span> {tooLargeSaid} — more than a transcript draws{#if at && opener()}{" · "}<button
          type="button"
          class="open"
          onclick={openFile}>open it</button
        >{/if}</span
    >{:else if url}<button
      type="button"
      class="hit"
      bind:this={hit}
      title={`${label}${stale ? " — the kept copy has gone; this is the file as it is now" : ""}${note ? ` — ${note}` : ""} · enter or click to look at it full size`}
      aria-label={`${label} — look at it full size`}
      onclick={look}
      onpointerdown={press}
      onpointermove={travel}
      onpointerup={() => (downAt = null)}
      onpointercancel={() => (downAt = null)}
      ondragstart={(e) => e.preventDefault()}
      ><img
        draggable="false"
        src={url}
        alt={label}
        class:in={shown}
        decoding="async"
        onload={measured}
        onerror={broke}
      /></button
    ><button
      type="button"
      class="copy"
      class:said={copied || copyFault}
      title="copy the picture as an image — to paste into a message"
      aria-label="copy the picture as an image"
      onclick={copy}
      >{copyFault ? "could not copy" : copied ? "copied" : "copy"}</button
    >{:else}<span class="wait" aria-hidden="true">{label}</span>{/if}{#if stale && !fault}<span
      class="stale">the file as it is now — the copy that was shown has gone</span
    >{/if}</span
>

<style>
  /* The box a picture stands in, sized from its own dimensions before its
     bytes arrive — the skeleton is exactly the final box. Achromatic and
     quiet: a frame is not a status. */
  .pic {
    position: relative;
    display: block;
    max-width: 100%;
    margin: 0.5em 0;
    border-radius: 3px;
    overflow: hidden;
    background: var(--surface);
    /* Never the panel's width decided by a picture — nothing in the panel may
       decide the panel's width (panel.md, "How wide the panel is"). */
    min-width: 0;
  }
  /* Unmeasured and empty: a short box saying what is coming, rather than a
     zero-height line the picture then shoves everything down from. The only
     case left that can move what is under it, and it is the rare one — a
     header that said nothing. */
  .pic:not(.sized):not(.held) {
    min-height: 3.2em;
  }
  /* A diagram is nearly always drawn for a white page — mermaid's lines, a
     graphviz render — and on this ground its ink would vanish. Achromatic, so
     no colour is spent on it. */
  .pic.paper {
    background: #fff;
  }
  .pic img {
    display: block;
    max-width: 100%;
    opacity: 0;
    transition: opacity 140ms ease-out;
  }
  .pic img.in {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .pic img {
      transition: none;
    }
  }
  /* Measured, the box already has the picture's shape and the picture fills
     it; unmeasured, it is drawn at its own size under the same ceiling
     `frameWidth` applies, until its first load measures it. */
  .pic.sized img {
    width: 100%;
    height: auto;
  }
  .pic:not(.sized) img {
    width: auto;
    height: auto;
    max-height: 28em;
  }
  .hit {
    display: block;
    width: 100%;
    padding: 0;
    margin: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  .hit:focus-visible {
    outline: 1px solid var(--paper-faint);
    outline-offset: 2px;
  }
  /* On the picture's corner, drawn on hover or focus and never held in state,
     so the pointer crossing a figure repaints nothing but this. A chip over
     the picture's own pixels, so it carries its own ground. */
  .copy {
    position: absolute;
    top: 0.4em;
    right: 0.4em;
    padding: 0.2em 0.6em;
    font-family: var(--util);
    font-size: 0.72em;
    color: var(--paper-dim);
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .pic:hover .copy,
  .copy:focus-visible,
  .copy.said {
    opacity: 1;
  }
  .copy:hover,
  .copy:focus-visible {
    color: var(--paper);
  }
  @media (prefers-reduced-motion: reduce) {
    .copy {
      transition: none;
    }
  }
  .wait {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.6em;
    font-family: var(--util);
    font-size: 0.78em;
    color: var(--paper-faint);
    user-select: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .stale {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0.15em 0.5em;
    font-family: var(--util);
    font-size: 0.72em;
    color: var(--paper-dim);
    background: var(--ink);
    user-select: none;
  }
  /* What stands in for a picture that is not drawn: the panel's own note
     register, inside the box the picture would have had, saying which and
     why. A dashed edge — the panel's one spelling of "not as it should be"
     that is not a colour. */
  .pic.missing {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2.6em;
    padding: 0.5em 0.8em;
    box-sizing: border-box;
    background: var(--ink);
    border: 1px dashed var(--edge);
  }
  .why {
    font-family: var(--util);
    font-size: 0.8em;
    line-height: 1.45;
    color: var(--paper-mute);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .what {
    font-family: var(--mono);
    color: var(--paper-dim);
  }
  .open {
    font: inherit;
    color: var(--paper-dim);
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .open:hover,
  .open:focus-visible {
    color: var(--paper);
  }
</style>
