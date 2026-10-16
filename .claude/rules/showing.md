---
paths:
  - "src-tauri/src/show.rs"
  - "src/lib/showing.ts"
  - "src/lib/InlinePicture.svelte"
  - "src/lib/Figure.svelte"
  - "src/lib/Lightbox.svelte"
  - "src/lib/looking.svelte.ts"
  - "src/lib/diagram.ts"
  - "src/lib/drawing.svelte.ts"
  - "src/lib/Diagram.svelte"
  - "src/lib/sandbox.ts"
  - "test/showing.test.ts"
---

# Showing a picture in the conversation

Asked for by Lyss on 2026-10-16, in her words: *"I want my agents to be able to display images
and diagrams and files and anything directly in the transcript, claude desktop / chat gpt
desktop style, right now agents can only show me things by pinning it to the wall and
sometimes it's good, but not always, right now it's used for everything."* And, the same day,
the rule that decided what was built first: *"it should ideally match how claude desktop does
it so that it matches the training of the models instead of inventing an entirely new way,
unless it limits the design and possibilities which I don't want."*

`pin` (`pin.rs`, `layout.md`) was the only verb that put a picture in front of you, so it was
the verb for every picture — including the chart that simply *was* the answer to the question
just asked, which went up on the wall a screen away from the sentence describing it, and
stayed there as furniture long after the conversation had moved on. This is the other channel
pin had been standing in for. Pin stays, and its description now says what it is for: a
reference that should still be on the wall when the conversation is somewhere else.

## Three ways in, and the first two are the model's own

**What makes content render matches Claude Desktop; what Volery does with it on top does
not have to.** An agent writes a markdown image and a mermaid fence without being told to,
because that is what its training showed it a client draws. Inventing a way of our own for
the common case — render an svg, then call a tool — is a way nothing in its training ever
showed it, and it would not reach for it. So:

- **`![alt](path)` in an agent's prose** is drawn where it was written, mid-sentence.
  `markdown.ts::pictureSource` decides what is a picture; `Inlines.svelte` draws it through
  `InlinePicture.svelte`.
- **A closed ```` ```mermaid ```` fence** is drawn as its diagram (`Diagram.svelte`) — the way
  Claude writes a diagram, expecting the client to draw it. See *Diagrams*, below.
- **`mcp__skein__show`** (`show.rs`) is the auxiliary, explicit channel: a picture as a step
  of its own, kept as it was when shown, with an answer that tells the agent at once if the
  path is wrong — which markdown cannot. Loaded beside `pin`, and its description says the
  reply's own markdown comes first.

Volery's extras sit on top of that baseline rather than replacing it: a full-size view, the
stable copy, pin for the wall. Claude Desktop's *aesthetic* is not imported — in particular
the panel still has no syntax highlighting, on purpose (`panel.md`: colour is status).

## What is never drawn, and why each is a refusal

Every one of these is refused rather than sanitised, the bargain `classify.ts::picturesOf`
already strikes for a tool result's picture.

- **Anything on the network.** `http`, `https`, `www.`, a `file://` naming a host: falls
  through to the link it always was. A transcript that fetched on behalf of whatever an agent
  wrote would be a different app, and a fetched image is a request telling somebody's server
  you are reading.
- **A Windows share, in any spelling.** *Opening* a path on a share is an SMB handshake
  carrying this user's credentials to whatever host the text named — and the text is an
  agent's, which may be words it read off a web page. **It is an allow-list of what a path may
  begin with, and the first cut was a list of shares**, which `\\.\C:\..\UNC\host\x` walked
  straight past (found in review): Windows normalises `..` in a device path, the root it climbs
  to is the device namespace rather than the drive, and the redirector is one segment from
  there. So a path is local only if it begins with a drive letter, a verbatim drive with no
  `..` (a verbatim path is not normalised), or no prefix at all; everything else is refused —
  `show::is_remote` in Rust, `localPicture` in the parse. A second review found one more
  spelling: `\??\UNC\host\x`, the NT object namespace, which Rust's parser reads as a rooted
  path with no prefix and `std::fs` hands to Windows unchanged. Nothing a person writes begins
  with `\??\`, so it is refused whole. **The same hole was open one feature
  over** and is closed by the same guard: `find::classify_paths` stat'ed every path an agent
  wrote in prose to decide whether to draw it as a link, shares included, on render. Measured
  with `pathsIn("see \\evil.example\share\x.txt")`, which handed the share straight to the stat.
- **A `data:` URI that is not plainly an image** — held to `classify.ts::pictureOf`, which is
  `picturesOf`'s own rules lifted out so the sources cannot drift: a short `image/<subtype>`,
  the base64 alphabet exactly, `MAX_IMAGE_CHARS`.
- **A local file on a chat card.** A file is read only for a surface whose prose has a
  directory behind it, so a chat card's `![…](C:\…)` stays its words, in italics. A chat card
  can make no file; the only paths it could name are ones it did not write. `show` refuses a
  chat card outright for the reason a question's attachment does (`ask.rs::attach_files`).
- **Bytes that are not what the name says.** `show::sniff_picture` types a file by its bytes:
  a `.jpg` holding a png is drawn as the png it is, a `.png` holding a page is not drawn.
- **A decompression bomb.** Three megabytes of one colour can say it is forty thousand pixels
  square, and decoding that is gigabytes in the one webview the wall is drawn in — on render,
  now, rather than behind a fold's click. `MAX_PIXELS` (50 MP) refuses it by its header, the
  way `MAX_PICTURE` (3 MB) refuses one by its bytes. Reads are bounded by `read_most` too, so a
  file that grows between the size check and the read is still bounded. **The cap is asked of
  the header's own numbers** (`too_many_pixels_in` over `header_size`), and that was the second
  review's main find: it was first asked of the *box* size, which clamps any side past 65,535
  to no size at all — and no size passed, so a 65,536-pixel strip went straight through. A
  `data:` picture is the other half of the same hole: no read stands between it and the
  decode, so `InlinePicture` asks `measure_picture_data` before it gives one its `src`. An svg
  declaring a hundred thousand pixels a side is the same bomb, and its declared size is capped
  the same way.

**An svg is drawn, which the file viewer deliberately does not do** (`finding.md`), and the
two decisions agree: the viewer shows a file you are reading as the source it is, and the
transcript draws a picture through an `<img>` — the one element that renders an svg with its
scripts and its external references switched off. **Never as inline `<svg>` markup**, which
is a script-injection surface; that line is the difference between this and a hack. A
foreign svg gets a white backing, because it is nearly always drawn for a white page.

## Zero shift: the box is the picture's before a byte of it has decoded

A figure that lands and grows moves every line under it, and the reading with them. So the
size comes first and the bytes second:

- **`show` puts the size in its result** — `kept as \`<id>\` (640×360)` — read off the file's
  header (`show::picture_size`: a fixed offset for png, gif and bmp, a marker walk for jpeg, a
  chunk for webp, the `ispe` box for avif, the root element for an svg). The result is in the
  session file, so the box is exact from the first frame live *and* after a restart.
- **A prose picture's header is asked for at once** (`measure_picture`, a few hundred bytes),
  not when the picture comes near — the full read waits for the view, the measure does not.
- **A measure is remembered** (`Sizes`), so a picture drawn again — after letting go of its
  bytes, or after the column is rebuilt — has its box before anything is asked.
- **The decode has the last word**, since a header can be missing and a photo's EXIF can turn
  it on its side. The only case left that moves anything is a picture whose header said
  nothing.

The skeleton *is* the final box: `aspect-ratio` from the size and `frameWidth` for the width.

## Sharp on a dense screen

`frameWidth` draws a raster at most **one of its pixels per screen pixel** — `w / dpr` CSS
pixels — and only ever smaller to fit the column or to keep it under `TALLEST_EM` of the
reading. On a 150% display a 640-pixel chart stands 427 CSS pixels wide and every pixel lands
on one of the screen's; the browser's default (one picture pixel per CSS pixel) would have
blown it up by half and smeared it. An svg is exempt — its size *is* CSS pixels, and it is
sharp at any scale. `decoding="async"` throughout. Looking closer is the full-size view's job.

## The full-size view

Enter or a click on any picture opens it over everything (`Lightbox.svelte`), at fit, with
`zoom.ts` doing the looking-closer arithmetic the gallery's magnifier already stands on. One
thing differs and it is passed rather than forked: **`native` caps the floor**, so a picture
smaller than the window opens at the size it is rather than blown up to fill it — `1` is
"every pixel this picture has, and no more", and past twice that a raster is drawn
`pixelated`, which is what looking at pixels should look like.

- **The keyboard reaches all of it**: `+` `-` `0` `1`, the arrows pan, Tab walks the bar and
  stays in the dialog, Escape closes — captured on the window, so it never stops the card's
  turn — and focus goes back to the picture you came from. Double-click toggles fit and 100%.
- **It mounts itself** into the studio root on first use (`looking.svelte.ts`), because a
  picture is drawn in three places that are not the root — the transcript, a question in the
  dock, a card's last message kept on the wall — and the last is inside the wall's zoomed,
  translated layer, where `position: fixed` measures against the layer. The studio root is the
  box every centred dialog is placed against, which also keeps it on the home screen when the
  window is spread across several. Nothing that draws a picture is handed a prop to reach it.
- **"Open" and "explorer" open the file it came from**, rooted at the picture's own folder
  (`paths.svelte.ts::useOpener`) — the arrangement a question's attachment uses, so a picture
  in `%TEMP%` or the studio's `shown/` opens too. Gated on the same scope as a path link, so a
  chat card offers neither. The first version routed the click itself to the file viewer,
  which draws an svg as its source and a kept copy under a uuid name — not a way to look at a
  picture.

## `show` keeps a copy, so a figure stays what was shown

An agent iterating on a render writes `chart.png` three times and shows it three times. Drawn
from the path, all three figures would be the third render — the transcript quietly rewriting
what it had said. So `show` copies the bytes into the studio's `shown/` as `<uuid>.<ext>` and
the figure is the copy.

- **No schema.** The result is in the session file; a restart folds the same call and the
  same result into the same figure.
- **Bounded by a budget, not a claim rule.** `SHOWN_BUDGET` (256 MB), oldest first, swept on
  every write and never the one just written. A swept copy falls back to the agent's own path
  and says *the file as it is now*; past that it says the picture is gone.
- **The copy's name is believed only in one place and one shape**: on its own line at the very
  end of a success, a v4 uuid and a picture's extension (`shownOf`, `isKeptName`,
  `show::is_kept_name`). A file's name is in the sentence above, and a name can be written to
  look like a mark, so a mark found anywhere else is not believed (found in review); a name
  with a separator in it would walk `read_shown` out of its directory.
- **The result is text, never an image block.** An MCP result can carry one and the CLI would
  hand it to the model: every `show` would cost the picture's tokens on that turn and ride in
  the cached context of every turn after, for an act whose point is the *user* seeing
  something.
- **A file that is not a picture is a plate**, not copied: its name and folder, opening it in
  the viewer with a click.
- **Its marks are read out of `show.rs` by the test**, and `show.rs` is in
  `supervisor::SPEAKING_SOURCES`, so what its results say is checked like every other tool's.

## A figure is never folded

`transcript.ts` gives a `show` call a block of its own (`shown`) and lets it break a run of
tool calls the way speech does: only machinery folds, and a call whose whole effect is a thing
for you to look at is the turn saying something. Keyed by absolute position, like an ordinary
line, so the node and the picture decoded in it survive the live column sliding. A find
(`hunt.ts`) looks in what a figure draws — its file's name and caption — not the line's words.

## Diagrams

A closed ```` ```mermaid ```` fence is drawn as the diagram it describes. That is a real
dependency — `mermaid@12.2.0`, pinned — and it earns its place on Lyss's rule above: it is the
one way Claude shows a diagram without being asked.

- **Mermaid never runs in this document.** It parses untrusted text and builds DOM in whatever
  document runs it, so `drawing.svelte.ts` keeps one hidden frame behind `sandbox.ts`'s wall —
  `allow-scripts` without `allow-same-origin`, an opaque origin with no parent DOM, no storage
  and no reach to the IPC, under a policy that lets nothing in from the network or anywhere
  else. A bug in mermaid or in the sanitiser it carries lands in a frame with nothing to touch,
  rather than in the origin holding the invoke bridge. Inside it, mermaid's own half:
  `securityLevel: "strict"` and no html labels.
- **And the frame's own policy is a nonce, not `'unsafe-inline'`.** A renderer of untrusted
  text most often goes wrong by leaving an event-handler attribute in the DOM it builds, and
  `'unsafe-inline'` allows exactly that — so against that class the policy added nothing beyond
  the sandbox (second review). With a fresh nonce per frame, the two script tags this window
  wrote are the only script that runs. A design preview keeps `'unsafe-inline'`, because its
  script *is* the author's markup; `sandboxPolicy` takes the nonce as an option.
- **A frame that navigates itself is thrown away.** A sandbox allows a frame to navigate
  itself and no policy can stop it, and the page it lands on has none of this one's policy
  while answering to the same `contentWindow`. So the frame loads exactly once, and a second
  `load` closes it; the next fence gets a fresh one. "Nothing from the network" holds for the
  frame this window wrote, and a frame that is no longer that one is no longer trusted.
- **One wall, stated once.** `sandbox.ts` is the policy and the attribute that the gallery's
  design previews had written inline; both now stand on it, so there is one place the
  containment posture lives and one place to fix it. A test holds the gallery to it.
- **What comes back is only believed as a picture.** `diagram.ts::readDrawn` takes a string
  that opens as an svg and fits the cap, and passes it through `pictureOf` into a `data:` URL
  for an `<img>` — the same path every other picture in the panel takes. Nothing the frame says
  is ever markup here. The frame answers only its parent, and is believed only by identity
  (`e.source`), since an opaque origin reads as `"null"`, which every sandboxed frame shares.
- **Only a closed fence is drawn.** `StreamedMarkdown` already hands back an unclosed fence as
  `{ t: "code", open: true }`, and `Markdown.svelte` sends that down the code block path it
  always took — so a diagram mid-stream is a dashed code block growing a line at a time, and
  never a half-drawn diagram flickering. `markdown.ts` and the every-prefix contract are
  untouched; the decision lives in the component.
- **A failure that says nothing about the fence is not kept** — the renderer slow to start on
  a loaded machine, or wedged — so the fence is tried again the next time it comes near; only
  mermaid's own refusal of the text is remembered. The cache is bounded by the characters it
  holds rather than by count.
- **Cached on the ink and the text.** A closed fence's text never changes, so the fence moving
  from the streaming tail into the settled column, a card read back, a panel drawn again — all
  find the drawing made. The ink is in the key because a diagram is drawn in the page's own
  tones; a theme or brightness change paints the root's style, one `MutationObserver` hears it,
  and the diagram is drawn again while the old drawing stays on screen until the new one lands.
- **The ink is read as pixels.** A token may be written in any colour syntax, and its
  computed value is `oklch(…)` or `color(srgb …)` for one written that way, which neither the
  ramp nor mermaid's colour library can read — every diagram failed under such a theme (second
  review). So each token is painted onto a one-pixel canvas and read back as the colour it is.
- **Achromatic, from the live tokens.** Mermaid's `base` theme derives its palette by rotating
  the hue of `primaryColor`, which from a grey stays grey; what it does not derive (pie slices,
  git branches, a timeline's sections) gets a ramp between the page's surface and its dim ink.
  Nothing on a diagram is a colour the wall did not choose — colour is status.
- **The font is a system face**, because the frame loads none and an `<img>` of an svg loads
  none either — so mermaid measures with the face it is drawn in, and a label never overruns
  its box.
- **Lazy twice.** The renderer — 5.5 MB of script, its own chunk, never in the main bundle —
  loads when the first closed fence comes near the view; a window with no diagram never loads
  it. And each fence is drawn only near the view. **Measured: 5,520 KB raw, 1,586 KB gzipped**
  (`vite build`, 2026-10-16); the main bundle is unchanged apart from the panel's own code.
  **And the wait it costs, measured in a lab wall the same day:** the first diagram in a
  window appears about **one second** after its fence closes — the chunk read, the frame
  made, 5.5 MB of script parsed, then the layout — and every one after it in under a tenth of
  a second, which is below what the harness could resolve. The estimate before measuring was
  a third of that, which is why it is written down. A fence mid-stream is a code block
  throughout, so the second is spent once, at the moment the first diagram completes.
- **A fence that cannot be drawn stays a fence**, with a quiet line under it — *not drawn —
  mermaid could not read it:* and the first line of mermaid's error. A drawn one has a
  `source` toggle (keyboard-reachable) that shows the fence it came from; a selection across
  the drawing copies the fence.

**The honest limit**, and it is the gallery's: a sandboxed frame may share its renderer
process with this window, so a layout that takes a long time holds the window for that long.
It is bounded rather than prevented — mermaid's own `maxEdges` (500) and `maxTextSize`
(50,000), one render at a time, and a frame that has not answered in `WEDGED_MS` is thrown away
and made again for the next fence — which is the same partial defence `Gallery.svelte`
documents for a design's script.

## Holding pictures

A picture in a tool call's fold is in the DOM only while the fold is open, so decoding is paid
for by a click (`panel.md`). A picture in the answer is always open, so the bound comes from
the view instead.

- **Bytes only near the view** — within a screen and a half of what is visible, measured
  against the nearest box that scrolls (`scrollRootOf`). Measured against the window it did
  nothing: the column clips what it holds, so a margin on the window widened a rectangle no
  picture can be seen through (found in review).
- **Let go `LET_GO_MS` after leaving that range**, keeping its box.
- **Only kept copies are cached** (`PictureCache`, least recently used, by characters held),
  each with the place it was read from so a figure drawn from the cache can still be opened.
  A picture read from a *path* is not cached, and that is a correctness rule rather than a
  saving: an agent writes `chart.png` again and draws it in its next message, and a cache keyed
  on the path would draw the old render there. So a picture in prose is the file **as it is
  now** — a reference, like a path link — and the tool is the way to say *this picture, as it
  was*.
- **The parse makes a new string per token**, and the effects that load a picture are keyed on
  a short string naming it, so a streaming answer re-parsing its tail reads nothing again.
- **`snapshot.pictures`** reports the cache's characters and count, since a budget nothing can
  see from outside is a budget nobody can check.

## Following the tail as a picture loads

A picture is appended at no height and grows by its whole picture when its bytes decode — no
node added, no text changed, and the scroller's own box unmoved — so neither of `hearGrowth`'s
observers heard it, and a picture at the foot of a live turn pushed the newest line off the
bottom with `following` still true: the signature `panel.md` names as the tell of a follow that
enumerates its causes. `load` does not bubble but runs through the capture phase of every
ancestor, so `hearGrowth` listens there (`decodedGrowth`). One listener on the scroller hears
every picture under it, whoever drew it — **which also fixes a picture opened in a tool call's
fold**, which had always done this. Measured in the lab: a picture as the last thing in a turn,
loading after its text, left the panel at 814 of 815.

## Copying across one

`copy.ts` writes back what an element says it is (`data-md`) instead of descending into it: a
picture carries the `![alt](path)` it was drawn from, a figure its caption as the alt and the
agent's own path as the source (a kept copy's name means nothing off this machine), a diagram
its fence, and a picture that was not drawn — or a `show` that was refused — its words. A
`data:` picture is elided to its media type (`pictureMarkdown`), never pasted as megabytes of
base64. Nothing is a gap.

## Where each one comes from, which a card on another wall will need

Not built — the transport is `elsewhere.md`'s business — but the representation is left ready
for it rather than special-cased as local:

- **A shown picture** is identified by its kept copy's name, `<uuid>.<ext>`, which is in the
  tool result and therefore in the session file and in whatever a far wall's tail carries. It
  resolves on the owning machine through `read_shown`, which is the read a pull (the way
  `look.rs` pulls a question's files) would make.
- **A prose picture** is identified by its path as written plus the card's directory — both
  already in the transcript.
- **A diagram** is identified by its fence text, and needs nothing from the owning machine at
  all: any wall can draw it.

Until a carrier exists, a card on another wall reads no local picture (`scopePictures` is
`null` there), and its figure says it was shown on the wall the card runs on — rather than
drawing a file of the same name from this machine, which would be a different picture.

## Not built

- **Inline previews of documents.** A PDF, a spreadsheet or a `.docx` shown with the tool is a
  plate that opens it in the viewer, which reads all of them. Drawing one inline is
  `Leaf.svelte`'s `peek` reading put in the column, and a PDF frame per figure is a viewer
  process per figure — a decision about cost, not a small step.
- **Video.** A plate, for now.
- **Other diagram languages** (graphviz, plantuml). Mermaid is the one Claude reaches for.
