---
paths:
  - "src/lib/attach.ts"
  - "src/lib/attach.svelte.ts"
  - "src-tauri/src/attach.rs"
  - "src-tauri/src/dropzone.rs"
  - "src/lib/drafts.ts"
  - "src/lib/field.svelte.ts"
  - "src/lib/PromptBox.svelte"
  - "src-tauri/src/attachments.rs"
  - "test/attaching.test.ts"
  - "tools/probe-image.ts"
  - "tools/probe-tool-image.ts"
  - "tools/probe-document.ts"
---

# Showing an agent a picture, a file, a folder

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
replayed: "Here is the first picture: \n and here is the second: ."
```

**The newline is the part that was got wrong for two months.** `textOf`, which reads the replay,
has always joined text blocks with `\n`; `echoOf` joined them with nothing, so no prompt with a
picture in it was ever claimed. The card took the turn and answered correctly, then drew the
prompt a second time and was nudged about a prompt it had already answered. Nothing
caught it until a picture was sent on a running wall on 2026-10-15, the first time this feature
was driven at all. `echoOf` is now `textOf` itself rather than a second spelling of it, which is
the bullet below made literal.

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
and the sentence disagreeing is the one state this feature must not have; the `$effect` in
`PromptBox.svelte` is what stops it, for every box at once.

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
envelope at send, and dropped. (A *file* with no path behind it is the one thing written to
disk, at the send and into its card's folder — see *Any file, into any input* below.)

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

### The one carve-out: a held message's pictures

**Lyss, 2026-10-16: a held message's pictures are written to disk until it is sent.** Everything
above stands for every other picture. The exception is a prompt held because no account will take
it (`accounts.md`, `holding.ts`): the hold is persisted so it survives the wall closing, and a
held message whose pictures did not would come back as a sentence naming pictures nobody has.
Until that day such a prompt was refused rather than held (`PICTURES_NOT_HELD`), which met the
no-disk rule by failing the one thing you had just asked for. Sink `864ccaae` is why that stopped
being acceptable: *something typed or done by the user should never be lost.*

Scoped exactly as narrowly as the reason:

- **In SQLite, not as files** — `held_picture`, beside `held_prompt` (`store::migrate_v54`). A
  file cannot go *with* its row: a crash between deleting the message and deleting the file
  would leave a screenshot in app data for ever. In the database, `write_hold` takes a message's
  pictures out in the same transaction that takes the message out of the queue, so the table
  never holds a picture whose message is not still queued.
- **Checked as if it came from another machine** — `attach::pictures_fit`, the same scrutiny
  `carried_fit` gives a picture off the wire, less the frame's ceiling. These bytes go back into
  a request hours later, and a picture the API refuses then is a held message that cannot go.
- **Gone when the message goes**: sent (after the send, so a crash mid-send restarts holding
  them — a copy is recoverable where a loss is not), handed back to the draft, cancelled, or the
  card closed (`forget_held`, since a close is soft and no cascade fires). `sweep_held` at every
  load is the backstop for anything a crash left.
- **Handed back as attachments, not tokens.** Escape on a held card, a clear, a close, or a send
  that fails outright puts the words back in the draft *and* decodes the pictures back into
  chips (`App.svelte`'s `onHandBack`, `Attachments.fromCarried`). A picture that could not be
  found again has its token taken out of the sentence (`holding.ts::withoutMissing`) and the
  transcript says it needs attaching afresh.
- **A remote prompt is held on the owning wall's disk**, by the same path: it arrives through
  `Skein.send` like any other.

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

## Any file, into any input that speaks to an agent

Lyss, 2026-10-16 and 2026-10-18 (sink `fd7ef025`): *"the attachments fixes and improvements like
supporting all files and folders, anywhere in all inputs that are to go back to agents"*. Two
things were wrong, and the second was the larger one:

- **Only pictures.** A PDF, a Word file or a folder dropped on the dock did nothing useful.
- **Only the dock.** A picture pasted into a question's answer box was pinned to the *wall*, a
  file dropped while a question was in front of the dock went into the hidden prompt field
  behind it, and a notice's reply could carry nothing. CLAUDE.md's "a capability every
  surface should have is not a prop", in its plainest form.

### Three kinds of attachment, and what each becomes

`attach.ts::Attachment` is a union:

| kind | where it comes from | a project card here | a chat card | a card on another wall |
|---|---|---|---|---|
| `picture` | a paste, a dropped image | an `image` block, as always | an `image` block | crosses with the prompt (`Pictured`) |
| `file` | a drop, an Explorer copy, a folder | **its path, as-is**, in the words | a PDF is read in as a `document` block; anything else refused | pulled by the owning wall and written there; a folder refused |
| `bytes` | a pasted blob, a browser drag | written into the card's folder, then its path | a PDF inline; anything else refused | pulled and written there |

**A path is passed as-is** (Lyss, 2026-10-16): the agent opens it with its own tools, which is
what Claude Code does with a path dragged into a terminal. Nothing is copied and nothing is
spent up front, whatever the file is. `pathText` writes it bare, quoted only when a space
would make it two words, as a terminal does.

**The token is replaced by the path in the *text* when the turn is cut** (`resolveFiles`), so
past the cut a file is words. The held queue, a combined round, the echo the replay is
claimed on and the transcript all carry a file as the sentence it now is, and none of them had
to learn that files exist. Picture tokens stay in `Turn.text`, because the hold and another
wall both re-cut at them.

`planFor(text, list, reach)` is the one place that decides what a target needs before the
cut: bytes to write, PDFs to read in, or a refusal naming the file. `Reach` is asked of the
card's handle (`CardHandle.reach`), never passed by a surface. A refusal is said beside the
box with the draft kept, before anything is cleared. A broadcast composes per card, since
each project card gets its own folder.

**A folder dropped *into* an input is attached as its path; on the wall it still opens a
card.** That is the orchestrator's decision (34b07397, 2026-10-18), and it follows from the
gesture: dropped into a sentence, a folder is a thing being talked about, not a place to
start a conversation.

### Bytes with no path are written at the send, into the card's folder

`<wall>/attachments/<card>/<send>/<name>` (`attachments.rs`). Not while the draft is being
written: drafts hold bytes in memory exactly as they hold pictures, so an unsent draft never
touches the disk, which keeps this file's older rule intact.

- **Kept until the card closes, not until the message is delivered.** Delivery is the *start*
  of the turn in which the agent reads the file, and a later turn ("now page three of that
  PDF") reads it again. The close removes the folder (`clear_for`, beside `forget_held` in
  `close_conversation_record`) and every load sweeps folders whose card is not open (`sweep`).
- **Bounded, because this disk runs near-full.** 24 MB a file (the same number as `look.rs`'s
  `FILE_MOST`, which is what will carry one across the flyway) and 512 MB for every card on
  the wall together. Past either, the write is refused in words that say where the space went
  and that it is kept until each card closes. Nothing older is deleted to make room: a file a
  card may still be reading is not ours to take away.
- **A held message survives on its own**, because the bytes were written before the hold and
  the hold carries the path in its words. A restart leaves the folder, since the card is
  still open.

### An Explorer copy is a path too

A paste event hands the webview a `File` with bytes and no path. Left there, a file copied in
Explorer and pasted would be written out a second time, where the same file dragged is passed
by its path. So `takePaste` asks Rust for the clipboard's `CF_HDROP` (`clipboard_paths`, read
through OLE because that is the `windows` feature set this crate already builds with), and
uses the paths when the clipboard still holds the same files by name. The event is read
before anything awaits, since `clipboardData` is only valid during it.

### One box, mounted by every agent-bound input

`PromptBox.svelte` is the box, and **attaching is what it does, not what a surface wires**:
paste, drop, the tokens and chips, the strip of thumbnails and file tiles, and pruning on
every keystroke. Its API is documented at its top and is deliberately small, because chat
view (`docs/chat-mode.md`) is a second presentation over the same logic. The logic is plain:
`Attachments` (`attach.svelte.ts`) and `attach.ts` underneath, with `turnFor` / `turnFrom`
turning a draft into a turn for one target.

The dock, a question's answer (`Ask.svelte`) and a notice's reply (`Notice.svelte`, also drawn
by `Vigil.svelte`) all mount it. A question's and a notice's attachments are kept beside their
words in `replies`, by the same key and outside any component (`attachmentsOf`), because the
panel comes and goes with the dock's queue and the same notice can be drawn twice at once. A
question's sheet shares one namespace across its steps, since the sheet goes back as one reply.

**`test/attaching.test.ts` holds it, and the shape is the finding.test.ts one.** Every
`<textarea>` or `<input>` in the app fails unless its file is named with the reason its words
reach no agent. So a new input fails until somebody decides which it is, and the default is the
one that cannot quietly lose pictures. It was checked to fail by putting Notice's old `<input>`
back by hand.

**The voice draft is not on the list because there is no box.** `voicing.svelte.ts` sends
spoken words straight to the card; there is nothing to paste or drop into.

### Where a drop lands: the DOM is asked for a box

The drop target is still hit-tested off the DOM, because a Tauri drag fires no DOM drag events.
What changed is what is asked: not "is this the dock or the panel" by class name, but **which
`PromptBox` is under the point** (`boxAt`). A box registers itself as it mounts
(`registerBox`), so a new input gets drops by existing. Three ways a point reaches one:

- **on a box**: the token goes in at its caret;
- **in an area that holds boxes** (`data-attach-area`, the dock): the first box in it, which is
  the one in front — a question drawn above the field comes before the field. The old hit test
  answered "dock" and attached into the prompt field behind the question;
- **on a surface that stands for a named box** (`data-attach-to="prompt"`, the panel): the token
  goes on the *end*, for the reason given below.

The outline that says a drop will land is drawn by the box under the drag (`dropping.over`),
not by the dock as a whole.

| gesture | where | what happens |
|---|---|---|
| paste, caret in any agent-bound box | that box | attaches; an Explorer copy as paths; text on the clipboard is inserted too |
| paste, anywhere else | the wall | a picture is pinned, exactly as before |
| drop on a box | that box | attaches at its caret; a folder as its path |
| drop on the dock's chrome | the box in front | a question's or a notice's, else the field |
| drop on the panel (the transcript) | the dock's field | attaches, token **appended at the end** |
| drop on the wall | the wall | a folder opens a card, a picture is pinned |

### A question's answer is a tool result, and a picture in it was probed first

An `ask_user` answer is not a prompt: it is the result of a parked `tools/call` (`ask.rs`). So
before anything was built, `tools/probe-tool-image.ts` (one Haiku turn) put
`[text, image, text, image, text]` in a stub server's result: seven colours named in order. The
CLI forwards the image blocks to the model. It also writes each to the session's
`tool-results` folder and appends `[Image: source: <path>]`, which costs nothing. An embedded
`resource` blob carrying a PDF is **not** inline: the CLI saves it there and hands the model
the path, so it reaches a project card (which reads the path) and never a chat card.

So `answer_ask` takes the blocks beside the words (`content`), kept on `Asks.attached` by ask
id until the parking thread writes the reply. Everything that reads an answer as *text* — a
deferral, a held sheet, a settle — goes on reading the same string, and only the final write
learns there was more, and only when the reply is the answer as given. A PDF for a chat card
is refused in the panel and again in Rust (`result_blocks`): send it as a message instead,
where `tools/probe-document.ts` showed a `document` block on stdin is read.

The same path takes a parked notice's reply. An unparked notice's follow-up is a prompt and
goes through `Skein.send` with its turn, as the dock does.

### What is not done yet

- **Across the flyway** a prompt's, an answer's and a notice reply's files cross and are written
  on the owning wall (`elsewhere.md`, *And so does a file*).
- **Browser drags were built blind**: the session was locked, so no real drag out of Chrome,
  Edge or Firefox could be made. See the section below for what is owed.

## The dock and the panel are one target

The dock and the panel are one target between them, not two. Both mean "give this to the card
I am talking to" — the panel *is* that card's conversation — and splitting them would be two
answers to a question with one, plus an edge down the middle of the screen you would have to
aim either side of.

They differ in one thing only: **where in the sentence the token goes.** On the dock you are
aiming at the field, so it lands at the caret. On the transcript you are aiming at no word at
all, so it goes on the end. The caret of a field you have not touched is the *start*, and a
picture dropped on the conversation arriving before what you had typed reads as the drop having
gone wrong (Lyss, 2026-10-18). The panel says so with `data-attach-to="prompt"`, and `boxAt`
answers `"end"` for it.

The payload's position is in **physical** pixels; the `/ dpr` in `App.svelte`'s drop handler is
load-bearing and is what the hit test reads.

## An unsent line outlives the window, and the pictures in it do not

`drafts.ts` opened with "an unsent line is a thought in progress, and it lives as long as the
window does" — a nice sentence about the wrong thing, and read for a while as an argument
when it was only a description of what had been built. Lyss's machine crashed while she was
typing a long feature request into a card and the words were simply gone (sink `b7a08d5e`).
A thought in progress is not worth less than a sent one; it is the same words a keystroke
earlier, and it is the one thing on this wall nobody can reconstruct, because unlike
everything else here it was never anywhere but in a person's head and that box.

So the whole keeping — every card's parked draft *and* whatever is in the field right now —
is written to `localStorage` behind a `KEEP_AFTER_MS` debounce and read back at startup.

- **`localStorage` rather than SQLite, and the second reason is the load-bearing one.** The
  first is the usual one on this wall: per-machine and disposable, like the viewport and the
  compaction calibration. The second is that it is the only store here that is durable
  **synchronously**. A draft written through an `invoke` is a draft racing the process it is
  trying to survive, which is the entire event this exists for — the thing that makes SQLite
  the better home for real data is what makes it the wrong home for this.
- **The images do not travel, and that is this file's rule rather than an omission.** An
  attachment is megabytes of pixels held for exactly as long as the draft is being written,
  and nothing of it is written to disk. Keeping them would put screenshots of whatever was on
  screen into a file on this machine, indefinitely, as a side effect of a feature about not
  losing typed words.
- **Which means their tokens come out with them.** A restored `look at [shot 1]` with nothing
  attached is a prompt referring to something the agent will never receive — the one failure
  `Attachments.prune` exists to prevent, arriving from the other direction. `withoutShots`
  runs every shot through the same `dropToken` the `✕` on a chip uses, so the restored draft
  is the sentence you wrote minus the pictures, and says nothing about pictures that are not
  there.
- **Nothing is truncated.** Past `KEEP_BUDGET` whole drafts are dropped from the end, and the
  held one is at the head of `keeping` so it is never the one dropped. A half-kept paragraph
  that reads as complete is worse than one that is plainly absent, because you would send it.
- **`restore` refuses once anything is parked**, which is what makes it safe to call from a
  place that might run twice: a restore landing over a live wall would overwrite what you are
  typing with what you were typing last week. `decodeKept` degrades rather than throwing, for
  the reason every opaque blob here does — it is read before the wall is drawn, and a parse
  that threw would be a window that did not open because of a half-written draft.
- **`prune` is why the keeping does not grow for ever.** A card closed while Volery was shut
  takes its draft the way `release` would have; without it the file grows a row per card ever
  closed, each holding text that can never be shown. It runs once `skein.convs` is non-empty,
  never against the empty list `load` has not answered yet. The wall's own bucket is never
  pruned — it belongs to no card by definition, which is the whole reason it exists.
- **The teardown writes rather than merely cancelling.** A clean close is the other way a
  window stops existing, and the debounce means the last few hundred milliseconds of typing
  are otherwise still pending.
- **The ask panel's free-text box is deliberately not covered**, and it is not a gap: the
  parked HTTP request dies with the process, so there is no question left for a restored
  answer to belong to. What protects typed text there is the countdown no longer running down
  while you type and an expired question going to the pile rather than away — both in
  `ask.md`.

## What is not done

- **A restored card shows no thumbnails.** They were never in the session file as anything a
  panel could draw, so a transcript read back off disk shows the prompt with its `[name]` tokens
  and nothing under it. That is the honest shape rather than a gap — the sentence still says
  which picture it meant — but it is a real limit and `history.ts` is where it would be fixed.
- **`deliver` is text-only**, and that is a property of its callers rather than a limitation:
  `relay.rs`, `board.rs`, `later.rs` and `spawn.rs` all compose messages out of words in Rust,
  where there is no clipboard. Only a prompt you typed can carry an image — **to a card on
  this wall or on another**: since 2026-10-15 the payload crosses the flyway with the prompt,
  and the far wall attaches it through `Attachments.fromCarried` and cuts the sentence with
  the same `turnOf` the dock does. The one limit a remote picture has that a local one does
  not is the frame's (`CARRY_MOST`). `elsewhere.md`, *A picture crosses with its prompt*.
- **None of this has been driven against a running app.** This machine has no MSVC (see
  `build.md`), so what is proved is: the pure suites, `svelte-check`, `cargo check --lib
  --profile test`, and the CLI probe. `gears.md` records what driving the real wall found that
  a green suite could not, and the same warning applies here — every branch below is new.

## A file dragged from Explorer: a drop target on every window, from the moment it joins ours

`dropzone.rs` has the whole argument. What to carry is three measured facts and the shape they
force. They were measured 2026-10-18 with real OLE drags: `DoDragDrop` of a `CF_HDROP` object
from another process, the cursor moved by `SetCursorPos`. The probes are in `tools/drop/`
(`run-ole.ps1`'s header lists them and what each found). `sniff.ps1` there is a drag that
enters, reads the effect the target answered, and **cancels**, so it is safe to aim at anything.

1. **OLE's hit test walks up to a registered ancestor only within one process**
   (`run-ole.ps1 -Mode same|cross|refuse`, a synthetic tree). An unregistered same-process child reaches its parent's
   target. A child owned by another process does not: the drag is refused. A child whose target
   refuses stops the walk.
2. **The page is drawn in another process's windows.** `Chrome_WidgetWin_1` and
   `Chrome_RenderWidgetHostHWND` belong to the msedgewebview2 *browser* process, under our
   `Chrome_WidgetWin_0`. `WindowFromPoint` over the page answers the render window. So no target
   on any window of ours can take a drop, which is how wry's walk lost: the installed 0.62 had
   its target on `Chrome_WidgetWin_0` alone, and every drop was the no-entry sign.
3. **Those windows join our tree after `build()`.** A WinEvent log of a launch shows
   `Chrome_WidgetWin_1` created top-level, the render window parked in a hidden window of the
   browser's, and both *reparented* under ours. Polling the drop-target prop from launch shows
   Chromium registering its own target on `Chrome_WidgetWin_1` and losing it ~100ms later. That
   was on an **idle** lab launch, not only under load.

**And a process can register a target on another process's window**, and OLE calls it when a
drag enters that window. That is **measured, not documented**: `run-ole.ps1 -Mode crossreg`,
and `probe-reg.ps1`, which reproduced the lost state on a lab and fixed it with one target on the
render window, registered from a third process. The whole fix rests on it. So a refused
registration is a `warn` in the app log naming the window's class (target `dropzone`), and a
WebView2 update that breaks it reads there rather than as a silent no-entry cursor.

So the registration is **driven by the events, not timed**:
- Once the window is built, `SetWinEventHook` puts `EVENT_OBJECT_CREATE` and
  `EVENT_OBJECT_PARENTCHANGE` on the browser process (its id off `CoreWebView2`).
- Then it walks once. Hook first, then walk, so there is no gap between them.
- Any event for a window whose root is ours walks again, and every window without our target
  gets one.
- **Ours replaces wry's and Chromium's**, so Windows has one target implementation. That is where
  a browser drag's formats will be taught (sink `4efa4af9`). It emits Tauri's own `tauri://drag-*`
  events, so `onDragDropEvent`, `dropTargetAt` and the control surface's `drop` op are untouched.
  `dragDropEnabled` stays on everywhere (one config), which keeps wry's synchronous
  `SetAllowExternalDrop(false)`: Chromium never offers a DOM drop of its own.
- `ProcessFailed` re-reads the browser id and re-hooks if it changed. Closing the window
  unhooks. `Ledger` is that bookkeeping, with the OS left out so `cargo test` asserts it.
- macOS and Linux need none of it. wry's drop there is a WKWebView subclass's own methods and
  GTK signals on the webview widget, there from birth.

**What the e2e showed**, real OLE drags on a lab wall:
- A folder opened a card, an image pinned, an image on the dock attached, and an image on the
  transcript appended.
- Six fresh launches each accepted the drop, one of them at 100% CPU (24 busy loops).
- A renderer killed and reloaded got a **new** render window, and its target arrived from that
  window's own creation event (`drop target on Chrome_RenderWidgetHostHWND`, alone in the log).
- After a GPU-process kill, the new `Intermediate D3D Window` waits bare until the next walk. It
  is layered and transparent, so the hit test passes through it, and a drag still landed.

**Two traps in driving this by hand:**
- **The display is at 150%.** A PowerShell harness that is not DPI-aware has its
  `SetWindowPos` and `SetCursorPos` virtualised while `CopyFromScreen` is not. Call
  `SetProcessDPIAware()` first.
- **Windows Terminal raises an invisible `CASCADIA_HOSTING_WINDOW_CLASS` window during any
  drag**, and it accepts file drops: the drop pastes the path at the terminal's prompt. Put the
  lab topmost, aim off-centre, and use a drag that cancels itself rather than one that releases
  the button wherever it happens to be.

## A browser's drag: a picture as bytes, a link as its text

A drag out of a browser carries no `CF_HDROP` and did nothing (sink `4efa4af9`). `dropzone.rs`'s
own target, the one IDropTarget on every window under the webview, now reads what a browser
offers, through `Offer` so the whole reading is a test over a fake data object:

- **`CF_HDROP` first and alone.** A drag with real paths is read exactly as it shipped,
  whatever else it carries (`real_paths_are_read_alone_and_unchanged`), and the branch for it
  in `DragEnter` and `Drop` is untouched code.
- **A virtual file** — `FileGroupDescriptorW` names it, `FileContents` at each index is its
  bytes, as an `IStream` or an `HGLOBAL` — is read *during* the drop, since the data object is
  the source's and valid only until `Drop` returns, then written off the main thread into
  `attachments/_dropped/` under the same budget as everything written for a card. The drop
  then names those paths like any other. Such a file is `staged`: a send to a project card
  claims it into that card's folder (`claim_dropped`), and one never sent is swept at the next
  load. A picture among them is a picture chip, read inline as a dropped image always was.
- **A link** (`UniformResourceLocatorW`, Firefox's `text/x-moz-url`) **lands as its text and is
  never fetched**, decided with 34b07397: a fetch would be a network request with none of the
  browser's sign-ins — an intranet PDF behind single sign-on comes back as the login page — of
  a size nobody knows, and the agent can fetch a URL itself. Chromium's `.url` shortcut,
  offered beside every link it drags, is recognised as that link and not attached.

It still emits Tauri's own `tauri://drag-drop`, with two fields added — `links` and
`refused` — so there is no second front-end path. `listenDrops` hears the four events itself
because `onDragDropEvent` rebuilds the payload with `paths` and `position` only. **macOS and
Linux are a seam, not a build**: wry reads only `NSFilenamesPboardType` there and only
`text/uri-list` on GTK, so a browser drag arrives with no paths. Teaching them means an `Offer`
over `NSPasteboard` (`public.file-url`, file promises, `public.url`) and over GTK's
`drag-data-received`, feeding the same `read` — and nothing of either can be built or tried on
this machine.

**Owed, because the session was locked when this was built:** `tools/drop/browsers.ps1` (with
`browsink.cs`, a sink that logs every format and reads `FileContents` at index 0) drags a
picture, a PDF link and a picture link out of Chrome, Edge and Firefox with real input. Run it
unlocked and check the formats against the bullets above, then drag a browser picture onto a
lab wall's dock and a link onto its question box.
