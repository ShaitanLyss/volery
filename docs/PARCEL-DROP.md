# A dropped file or folder is a parcel

Decided with Lyss, 2026-11-13. The ask, in her words: *drag and dropping files and folders
onto a remote conversation should create a parcel instead. No special parcel mode, it should
be the same path. There's no reason an agent should be able to do more than I can as a
human.*

Today a drop on a remote card's input travels as an attachment to the prompt: the file is
pulled and written into that card's folder, a folder is refused outright, and none of the
parcel rules apply. The agent's `send_files` can do more than the person can. This is the
design that closes that.

## The rule

A file or folder dropped into a card's input on another wall becomes a parcel. The gesture
does not change: the same boxes take the drop, the same field takes the words, Enter sends.
What changes is what the drop *is*: the wall's own way of handing files to another machine,
with everything `send_files` already does.

There is no parcel control, no second composer and no switch to find. The surface states
what will happen; the person never chooses a mode. The carrier differs because the
destination differs, the way the dock already words a chat card differently. On this wall a
path is enough, so a drop stays a path in the sentence; a path on this machine means nothing
on the other one, so the bytes must travel, and a parcel is the wall's honest shape for that
— a copy, a landing folder, a list of what went and what was left out.

## Before the send

The dock's eyebrow already names the card and its wall: *to the new box · on desk*. The strip
above the field is the existing strip, with a parcel heading and a measured summary. It
carries, quietly:

- the measured total: *16 files · 43.4 KB*
- the carrier in plain words: *as a parcel — they land in its own folder*
- a tile per top-level thing, with its count and size: *memory · 14 files · 40.0 KB*,
  *CLAUDE.md · 3.1 KB*, and a named secret flagged in inverted ink: *.env · 340 B ·
  secret-shaped*
- the inverted line when a secret is in it: *1 secret-shaped file sent because it was named.
  Never printed.*
- one folded line for what is not going: *2 things left out*, opening to *memory/old/ — a
  link, never followed · memory/.cache/ — ignored by git*
- the ✕ on each tile, the same gesture that takes a file out of a prompt today.

The sentence carries a chip, as a picture does today: *move this over to the new box
[memory] — the notes are in there too.* The chip is the word the thing is referred to by; the
tile is where its facts and its removal live. Backspacing the chip detaches, exactly as it
detaches a picture, and one pruning rule serves both.

**The parcel is measured on drop.** A folder is a decision: what it holds, what is staying
behind and whether a secret is in it has to be answerable while it can still be changed.
After the send the plate tells the whole story; before it, the strip does. A cap, a link
named directly, a share, or a folder with nothing in it is refused beside the field, and
nothing has been copied.

## At the send

Enter sends the parcel and the sentence together. The line is drawn at once, pending, in the
person's register, as a prompt is: the plate in its sending state with the total and the
card's name.

The far wall pulls the files, writes them into that card's own folder, and hands its agent
the sentence and the manifest. When it lands, the plate settles: *in …/from-you-1*. If the
send fails or is refused, the plate comes back to the draft with the tiles and the sentence,
and nothing is lost. That is the promise the dock already makes for a prompt: something typed
or done by the person is never lost.

## After the send

The plate is the one that already exists, drawn under the message on this wall (dashed,
*sent with it*) and under the letter on the other (*came with it*). It lists what went, where
it landed and what was left out. A person's parcel and an agent's parcel are the same plate;
there is nothing new to learn.

## The card's face

A drop on a card's face is a hand-off to that card, and it closes the last thing an agent
could do that a person could not: reach a card without talking to it first. The face is a
parcel on either wall, because the gesture's intent is *give this card the files*, not *talk
to it about them*. The input keeps its own meanings: a path on this wall, a parcel to another,
a PDF read in on a chat card.

**A face drop stages the hand-off in that card's own draft.** The drop rings the card, its
strip takes the files, and the message is written in the one composer. Enter sends; Escape,
or taking the last tile out, puts it back. It is reversible, it gives the hand-off words, and
it is a parcel on either wall, so a local hand-off is a copy too. The cost is the context
switch: the drop brings that card forward.

A chat card has no project to receive a hand-off, so a drop on its face is refused with one
line, exactly as an agent's parcel to it is.

## What the drop inherits

Every rule the agent's parcel is held to, because it is the same walk:

- a folder in a repository sends what git tracks plus untracked files git does not ignore;
  outside one, a plain walk; never `.git`
- secret-shaped files inside a folder are left out and listed; one dropped directly is sent
  and flagged, in the strip, on the plate and in the chronicle
- links and junctions are never followed; one dropped directly is named with its target and
  not added
- nothing is sent from a network share
- past 5,000 files, 200 MB, or 24 MB a file, the whole parcel is refused, never trimmed
- the files land outside every repository, in the card's own folder, under *from-you*, and
  they go when that card closes; its agent is told to move what it keeps

A parcel from a person has no card behind it, so it signs as the person: the landing folder is
*from-you-<n>*, and the secret row lands on this wall's chronicle, where the person will see
it.

## The cases

| what the person does | what happens |
|---|---|
| drop files on a remote card's dock, transcript or question box | a parcel, with the words as its message |
| drop a folder on a remote card | a parcel; the folder travels now, where before it was refused |
| drop a file on a card on this wall | a path in the sentence, as today; its agent can already reach it |
| drop a folder on the wall itself | a card opens, as today |
| drop files or a folder on a card's face | a parcel staged in that card's draft; it comes forward, Enter sends |
| paste a screenshot into a remote card's draft | a picture in the sentence, as today |
| paste a screenshot into a parcel draft | refused beside the box, with a line saying to drop it instead; one send has one carrier |
| drop a secret-shaped file directly | sent, flagged loudly before and after |
| drop a folder holding one | it is left out and listed; name it directly to send it |
| drop on a chat card's face | refused in one line; a chat card has no project to receive a hand-off |
| the far wall is on a build without parcels | the strip falls back to the attachment carrier, says so, and a folder is refused again |
| the far wall is unheard | the drop is refused beside the field, the draft and the tiles kept |
| drop a browser file or a pasted blob | bytes with no path are written to the staging folder and then treated as a dropped path, as they already are |

## Parity, stated plainly

After this, every parcel an agent can make, the person can make: files, folders, thousands of
them, up to the caps, with the same filtering and the same flag. And with the face as a
target, every card an agent can name, the person can reach too: focus it and drop, or drop on
its face.

## The keyboard path

A drop is a pointer gesture, so the change owes a key. The finder's family takes a third
member: **space then f a** opens the system's own file picker, for files or a folder, and what
comes back is the drop. It works for a path on this wall and a parcel to another, so the
attachment feature stops being pointer-only. The tiles are in the tab order, the arrows move,
Delete takes one out, and Enter in the field sends.

## Both views

The strip and the plate are the same in wall mode and chat view. The wall's dock draws the
strip above its field under its eyebrow; chat view's composer draws the same strip above its
field, one column wide. A chat card is the exception the case table names.

## Not in scope

- No second composer, parcel toggle, or "send as files" menu item.
- A local drop into an input, a pasted picture, a folder dropped on the ground, and a parcel
  received from an agent are all unchanged.
- A person cannot parcel to a chat card, for the same reason an agent cannot.
- No confirmation click. The strip is the confirmation; the flag is loud; Enter is the
  decision.

## What building it touches

The design is meant to be built as one unit, with the parcel rules and the transport reused
rather than re-spelled.

- **Rust.** `parcel.rs` already has `gather`, `landing`, `land`, `manifest`, `stage` and the
  `Carried` wire type. What is missing is a human send: a command that gathers against the
  right caps, lands a local parcel, or stages and parks for a remote one, with no calling
  card. The far wall needs one arm in `flyway/link.rs` for a person's parcel
  (`from_card: None` with `d.parcel`), which lands it and then hands the card the message the
  way a person's prompt is handed over. A measure command serves the strip: gather, and
  return the tiers, left-out lines, secrets and the total without copying anything.
- **The draft.** `attach.ts` and `attach.svelte.ts` gain a parcel kind beside picture and
  file: a path with the target's wall, the gathered summary, a chip in the sentence and a
  tile in the strip. `drafts.ts` keeps the paths as it keeps a file's path today.
  `PromptBox.svelte` draws the parcel heading, the secret line, the measured tiles and the
  left-out fold.
- **The send.** `App.svelte`'s drop handler and `composer.svelte.ts` send a draft with parcel
  items through the new command instead of the prompt path; the line is pending until the
  landing, and comes back with its tiles on a refusal. `relay.ts` and `Parcel.svelte` already
  read the plate.
- **The face.** The drop hit test in `attach.svelte.ts` gains the card's face; `cards.svelte.ts`
  rings the targeted card; the rest is the draft path above.
- **The key.** `leader.ts` gains `fa`; the picker is a small native command returning paths,
  fed through the same drop plan.
- **Tests.** The pure attachment and parcel logic in Bun; `parcel.rs`'s own tests extended for
  the person's send and the far-wall arm; `test/relay.test.ts` for the mark; `attaching.test.ts`
  for a new input surface if one appears. Then two frozen labs, both walls on this build.

## How to see it work

Two frozen labs, one card each, a folder with a tracked file, an ignored folder and a
secret-shaped file:

1. A file dropped on B's card in A's dock measures on drop, shows its count and any left-out
   line, and sends as a parcel with the chip in the sentence.
2. A folder dropped on B is a parcel, not a refusal, and its ignored and secret-shaped members
   are listed as left out.
3. A secret-shaped file dropped directly is flagged before the send and in the chronicle after.
4. A drop on B's card face rings B, stages the parcel in its draft, and Enter sends it; Escape
   puts it back.
5. A drop on a card on this wall stays a path in the sentence; a paste stays a picture; a
   folder on the ground still opens a card.
6. A parcel that lands puts its plate under the message on both walls, with the landing path
   on the receiving side.

## What the two labs found

Driven on two frozen labs, both walls on this build, 2026-11-13. The six beats passed. One
real bug was found and fixed (`900cdcc`, `flyway/link.rs`): a person's parcel attached to an
`ask_user` answer, a notice reply or a deferred answer matched the plain answer arm first, so
the words were delivered and the files were silently dropped while the sender was told
`taken`. The answer arms now step aside when `d.parcel` is set, the parcel arm lands the
files and routes the answer, and its chat-card refusal is reached. Verified live: an answer
with `answer.txt` landed at `from-you-1/answer.txt`, the ask closed, and the far agent read
the answer with its manifest and landing path.

Four findings, not fixed, for a decision:

1. **The sender's plate never settles.** `send_person` is fire-and-forget and the `taken`
   answer carries no landing path, so the sender stays *sent with it / to host* while the
   receiver shows the folder. The answer must carry the landing directory.
2. **A late far-wall refusal loses the draft and the tiles.** `send_person` returns `Ok`
   once pushed; an `accepting` refusal arrives later as `refused`, after the composer has
   cleared. The design's "a refusal comes back to the draft" holds only for synchronous
   refusals (solo, quiet, no flyway). The send has to park on acceptance the way the agent's
   `send_files` does, or the refusal has to find the draft.
3. **A received person's parcel, restored from history, reads *sent with it* on the
   receiver.** Direction lives in the flyway event, not in the words, so the history fold
   cannot tell a relayed person's prompt from one typed there. This is the mark hazard
   `relay.md` records; a mark in the words would let the history fold draw the direction.
4. **Escape does not revert a face drop.** The tile's ✕ does. The handler records nothing to
   revert to; it should hold the draft before the drop and put it back on Escape.

And one gap: the front end still offers a parcel strip for a remote chat card, because the
carrier never sees the card kind. The honest fix is a carrier that can say "refuse", so the
strip does not appear and the drop is refused in one line.

Two paths were not separately driven: a parcel in a notice reply (it shares the guarded path
and the fix above), and the far wall's refusal through `land_parcel` (reachable, not driven
end to end). The lab screenshots are in `.scratch-c76b1368/`.
