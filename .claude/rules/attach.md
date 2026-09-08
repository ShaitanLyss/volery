---
paths:
  - "src/lib/attach.ts"
  - "src/lib/attach.svelte.ts"
  - "src-tauri/src/attach.rs"
  - "src/lib/drafts.ts"
  - "src/lib/field.svelte.ts"
  - "tools/probe-image.ts"
---

# Showing an agent a picture

Until now the only way was to write a path in the draft and hope the agent reached for `Read`.
That costs a tool call, a round trip and the agent's willingness — and it fails outright for
the case that comes up most, a **screen capture**, because Windows' capture tools put a bitmap
on the clipboard and write nothing to disk. There is no path to write.

The wall already knew this. `store::paste_image` exists precisely because a screenshot has no
file, and what it does with the bytes is pin the picture *beside* the card, where the agent
cannot see it.

## The image goes where you were typing

An attachment is not a tray bolted onto the end of the draft. It is a token sitting in the
sentence —

```text
look at [shot 1], I would like it to be more like [shot 2]
```

— and the whole design follows from that being **literally true on the wire**. `compose` cuts
the draft at its tokens and hands back alternating blocks, which is the shape the CLI's stdin
takes: `content` has always been an array and for the app's whole life held exactly one text
block.

## What was probed, before any of it was built

`tools/probe-image.ts`, against the shipped argv, one real turn. It generates two images —
four quadrants in four colours, three stripes in three more, in an order nothing in a training
set has seen — sends them interleaved with three text blocks, and asks for the colours back.

```text
0.00s → send: 1014 bytes, content=[text+image+text+image+text]
2.45s ← init: model=claude-opus-5[1m]
5.60s ← USER REPLAY: content=[text+image+text+image+text]
5.60s ← assistant: "green, orange, blue, white, red, yellow, purple"
5.61s ← result: subtype=success is_error=false turns=1

saw    : 7/7 colours named
order  : correct — position survived the wire
```

Three things, and only the third was in doubt:

1. the CLI parses the envelope (a rejected line is **silent** — NDJSON has no error channel, so
   a bad line is a turn that simply never starts);
2. it takes more than one image and does not collapse them;
3. **the model can tell which is which from where they sit in the sentence.** That is the whole
   of "this one, more like that one", and the schema alone did not promise it.

Re-run the probe against a new CLI before assuming any of it still holds.

## The echo is a second string, and this is the load-bearing part

The same probe answered the question that would otherwise have cost a card its
acknowledgement. `--replay-user-messages` echoes the envelope back with its blocks intact, and
`Conversation.#echoOf` matches a pending line on **text** — so what comes back to be matched is
the concatenation of the *text* blocks, with the tokens gone:

```text
drawn:    "Here is the first picture: [a] and here is the second: [b]."
replayed: "Here is the first picture:  and here is the second: ."
```

Left alone, **no image prompt would ever be claimed**: the line keeps `awaited` for the life of
the process, the card reads *sent, not picked up*, and every following `result` schedules a
nudge until the budget is gone. That is exactly the leak `/model` caused, and `turns.md` has
what it cost — 14 nudges on this machine, three cards spending a turn to answer "Nothing is
queued behind it".

So `Line.echo` sits beside `Line.text`: what the wire will say, beside what the panel draws.
The same split `state` and `awaited` already made, for the same reason — **two questions that
looked like one.**

Two things keep it honest:

- **It is derived from the blocks that go on the wire**, never re-split. `Field.turn` composes
  once and `echoOf` reads the result, so the drawn line and the matched line cannot drift. A
  second implementation of the split is a second thing to get wrong and its failure is silent.
- **`#echoOf` answers to *either* string.** The two callers arrive holding different ones: the
  replay reaches `#claimEcho` with the echo, and `echoFailed` is called by `#deliver` with the
  draft you typed. Matching on only one leaves the other finding nothing.

## Deleting the token is the detach gesture

There is no separate remove to remember. An attachment exists by being mentioned, so
backspacing over `[shot 1]` takes the picture out, and the `✕` on a chip is `dropToken` — the
same act, spelled as an edit to the sentence.

The invariant that makes it safe is that **everything asks `stillIn`**: `compose` for what to
send, `runsOf` for what to draw as a chip, `Attachments.prune` for what is still in the list.
They cannot disagree about what is attached because they ask one question.

**And typing has to prune, not only `Field.put`.** The text is two-way bound to the textarea,
so an ordinary keystroke never reaches `put` at all — the first version pruned only on the
writes that replace a whole line, which meant deleting a token left the picture in the strip
above the field and counted against the cap, while `compose` would not have sent it. The strip
and the sentence disagreeing is the one state this feature must not have; the third `$effect`
in `Dock.svelte` is what stops it.

## How it is drawn, and the one trick

The chip is drawn in the **tint layer** — the same mechanism the `!` line uses one box over: a
coloured copy of the text underneath a textarea whose own glyphs are transparent. So `runsOf`
carries `tokens`' rule, and the test is the same test: **the runs must concatenate back to
exactly what went in**, because one dropped character puts every glyph after it over the wrong
place and the caret lands mid-word.

- **A chip is the same glyphs with a background behind them.** Anything that changed the
  token's width — padding, a different face, a border — would move the text out from under the
  caret. Colour, a radius, and `box-decoration-break: clone` so a wrapped token gets a rounded
  end on each line. Achromatic, because colour on this wall means status.
- **The tint is switched on only while something is attached.** Drawing the text underneath
  costs something real — an IME's composition text would be invisible while you typed it — and
  that is worth paying only on the drafts that have a chip to show. An ordinary prompt is
  exactly the field it has always been.
- **The strip of thumbnails sits above the field**, so the pictures are between the target line
  and the sentence that refers to them, and the field itself never moves as you type. Drawn
  only when there is something in it.

## Where the bytes live, and what is never written to disk

Nothing is copied anywhere. The bytes are held in memory on the draft, base64'd into the
envelope at send, and dropped.

`store::import_image` would have been one line and is the wrong home twice over:
`sweep_references` deletes every file in `references/` that no `image` row points at, and an
attachment has no row — so the copy would be collected out from under an unsent draft at
whatever moment the next sweep ran. And a reference board is built up over months; dropping a
screenshot into a prompt is not a statement that you want it pinned up.

- **A paste already has the bytes.** That is the whole reason the feature exists.
- **A drop has only a path**, because Tauri's drag-drop hands over real filesystem paths and
  there is no `fs` plugin here — the asset protocol is scoped to `$APPDATA/references/**`
  precisely so a webview cannot read arbitrary files. `attach::read_attachment` is the one
  bridge, and it is `async` per the `off_main` rule: a 64 MB read plus a base64 encode on the
  thread that drains the event loop stops every card on the wall being painted.
- **The thumbnail is a small data URL, not an object URL over the full bytes.** An object URL
  pins the whole blob alive until something revokes it, and a `Line` lives as long as its card
  — so a wall left up for a week would hold every screenshot ever sent at full size, with the
  revoke owed by whichever of four call sites dropped the last reference. At `THUMB_SIDE` it is
  a few kilobytes, it survives being copied into a `Line`, and there is nothing to release.

## Scaling, and the two caps that are not the same cap

`MAX_SIDE` is 1568 because the API scales anything larger down before the model sees it —
sending more is paying upload and tokens for pixels discarded on arrival. A 4K capture is ~8 MB
of PNG and 2.5× that on its long edge; scaled here it is a few hundred KB.

- **Nothing under the ceiling is touched.** A re-encode that changes nothing is still a
  generation of quality spent, and for a GIF it is the animation.
- **A scaled image is re-encoded as itself**, except a GIF, which cannot survive a canvas.
  A PNG screen capture re-encoded as JPEG picks up ringing on exactly what it was captured to
  show: text and thin UI lines.
- **`MAX_READ` (Rust, 64 MB) and `MAX_BYTES` (webview, 5 MB) are different questions.** The
  second is what the API takes, checked *after* scaling, which is the only measurement that
  describes what will be sent. The first is about not turning a video somebody dropped by
  accident into a string a third larger than itself across an IPC boundary — and a cap that
  only bites after the read has happened is not a cap.
- **The sendable types are narrower than the pinnable ones**, deliberately. `classify_drop`
  admits `bmp` and `avif` because the *webview* renders those; `attach::media_type_of` does not
  because the *API* decides. Two questions, two lists — a single shared one would have to be
  the narrower, which would stop you pinning up a bmp for no reason anybody could see.

## A draft is one value now

`Drafts` parks `{ text, shots }` rather than a string. Parking the two apart would be two maps
that can disagree, and the way they would disagree is a picture arriving at whichever card you
clicked next — the carry-over `Drafts` exists to prevent, made worse by being silent, since the
token would still be in the other card's text.

`Field.take` and `Field.hold` are the two doors, and the difference matters: `take` is `reset`'s
(a card switch, where the dismissals belong to the draft being replaced) and `hold` is `put`'s
(a card being *closed*, where the line is handed to the wall and goes on being shown, so an
Escape you pressed over it a second ago still applies).

## Which gesture lands where

| gesture | where | what happens |
|---|---|---|
| paste, caret in the dock | the field | attaches, token at the caret; text on the clipboard is inserted too |
| paste, anywhere else | the wall | pins, exactly as before |
| drop on the dock or the panel | the field | attaches |
| drop on the wall | the wall | pins, exactly as before |
| drop of a folder | anywhere | opens a conversation, wherever it landed |

**The drop target is hit-tested off the DOM, because a Tauri drag is not a DOM drag**: an OS
file drag fires no `dragenter` on any element — the webview swallows them so the payload can
carry real paths — so nothing under the cursor is ever told it is hovered.
`document.elementFromPoint` is the only way to ask, and the highlight on the dock is the only
feedback a drag gets. The payload's position is in **physical** pixels; the existing `/ dpr`
was already load-bearing and is now read by the hit test too.

The dock and the panel are one target between them, not two. Both mean "give this to the card
I am talking to" — the panel *is* that card's conversation — and splitting them would be two
answers to a question with one, plus an edge down the middle of the screen you would have to
aim either side of.

## What is not done

- **A restored card shows no thumbnails.** They were never in the session file as anything a
  panel could draw, so a transcript read back off disk shows the prompt with its `[name]` tokens
  and nothing under it. That is the honest shape rather than a gap — the sentence still says
  which picture it meant — but it is a real limit and `history.ts` is where it would be fixed.
- **`deliver` is text-only**, and that is a property of its callers rather than a limitation:
  `relay.rs`, `board.rs`, `later.rs` and `spawn.rs` all compose messages out of words in Rust,
  where there is no clipboard. Only a prompt you typed can carry an image.
- **None of this has been driven against a running app.** This machine has no MSVC (see
  `build.md`), so what is proved is: the pure suites, `svelte-check`, `cargo check --lib
  --profile test`, and the CLI probe. `gears.md` records what driving the real wall found that
  a green suite could not, and the same warning applies here — every branch below is new.
