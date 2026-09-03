---
paths:
  - "src-tauri/src/clip.rs"
  - "src-tauri/src/sink.rs"
  - "src-tauri/src/board.rs"
  - "src-tauri/src/relay.rs"
  - "src-tauri/src/later.rs"
  - "src-tauri/src/guidance.rs"
  - "src-tauri/src/spawn.rs"
  - "tools/lift-clip.ts"
---

# Cutting text to fit, and saying so

Every tool surface on this wall has a budget somewhere. There is now exactly one thing that
enforces one — `crate::clip` — and this file is why it had to be one thing.

## The bug, which was seven copies of itself

Until 2026-09-04 each site enforced its own cap with its own `s.chars().take(max)`. What made
that expensive was not the duplication; it was that **the same lesson had been learned three
separate times and never carried across**, so which of the three you got depended entirely on
which file you happened to be in:

| site | boundary | marker for the reader | count for the writer |
|---|---|---|---|
| `sink.rs` (title, body, note) | no | no | no |
| `later.rs` (a wake note) | no | no | no |
| `guidance.rs` (standing instructions) | no | no | no |
| `store.rs` (a merged sink body) | no | no | no |
| `relay.rs` (a message, a recall) | no | *yes* — `[…truncated by skein at N]` | no |
| `board.rs` (a notice) | no | no | *yes*, in the receipt |
| `spawn.rs`'s `clip_brief` | **yes** | **yes** | **yes** |

The one that got it right was the one with **no live caller**: by the time `clip_brief` was
written, the argument for capping a brief at all had not survived (`spawn::MAX_PROMPT` is
parked at `None`). So the good implementation sat there being correct about nothing while six
worse ones ran. That is the shape to watch for — *a fix that landed as a special case instead
of as the general one* — and it is why this module exists rather than a seventh careful clip.

## Why this class of bug costs more here than in most applications

**On nearly every path through this app the reader is an agent, and an agent cannot tell a
clipped text from a complete one.** A person seeing a paragraph stop mid-word knows to go
looking for the rest. A model reads what it was handed as the whole of what there is, reasons
from it with complete confidence, and reports a conclusion drawn from half a specification.

That is not hypothetical; it is the measured history:

- **`f468f017`** — a spawn brief cut at 4,000 characters. The card only noticed because the
  cut landed mid-word, inside `ask_user`. **A tidier cut would have hidden it better**, which
  is the single most important sentence in this file: the boundary rule and the marker are not
  alternatives, and improving the cut without adding the marker makes the bug *harder* to see.
- **`7b26058e`** — sixteen open sink items measured sitting exactly on the 1,200 cap, every
  one ending mid-sentence, one cut mid-word inside the sentence explaining its own cause. The
  tails were gone from the store, not merely from the listing.
- **`33031132`** — the class, filed after the third and fourth site turned up in one afternoon.
- The `recall` cut that took the tail off a card's only report of a finished piece of work,
  with no way for the reader to ask for the rest.

## The two rules

1. **Cut at a boundary** — paragraph, then list item, then word — but never further back than
   `BOUNDARY_FLOOR` (the last quarter). A boundary rule with no floor can throw away most of a
   text to find a blank line, which is worse than the mid-word cut it was improving on.
2. **Mark it at both ends.** The text carries a marker for whoever reads it, naming the count
   *and a next move*; the receipt carries the count to whoever wrote it. Neither half is
   sufficient alone — a marker reaches a reader who often cannot fix it, and a receipt reaches
   a writer who has already moved on. `sink.rs`'s `clipped_note` is the writer's half;
   `Cut::marked` is the reader's.

The remedy sentence is **required, not optional**, and it is per-site because the next move
genuinely differs: a brief's parent still holds the whole thing, a card is still on the wall
and can be asked, a sink body's tail is simply gone and the useful advice is to file the
remainder as its own item. A marker that names a loss and no way to make it good leaves an
agent knowing it is missing something and unable to act — which is exactly the state
`relay.rs`'s original marker left every reader in.

## A budget is not a preview, and conflating them writes a lie

`clip::keep` is for a **budget**: text is lost, the reader cannot get it back unaided, and so
it is owed a count and a remedy. `clip::preview` is for a **preview**: a strand label in the
flow, a log line, a question's first sentence — where the whole of it is on the wall a glance
away and *nothing failed to arrive*.

Putting `keep`'s marker on a preview would be false twice over — no loss occurred, and there
is nobody to ask. So a preview ends in an ellipsis, which is what every reader already
understands, and it fits *within* its cap counting the ellipsis, because the number is a
width and a label one character over its box is the bug the cap existed to prevent.

**The test to apply at a new call site: who reads this, and can they get the rest?** An agent
who cannot is `keep`. Anyone who can is `preview`. `servers.rs`'s `clip_line` and `smith.rs`'s
question-shortener were both previews and both already right; they are left alone.

## Where the caps actually live

- **A sink body has one cap and it is `store::MAX_SINK_BODY` (4,000).** It used to have two —
  `sink.rs` clipped to 1,200 before the store, which had its own 4,000 for the same field, so
  the tighter one silently won and was 3.3× off. The tool-layer cap is gone. The argument that
  killed it is `spawn::MAX_PROMPT`'s: the body arrives as MCP `tools/call` arguments, so it was
  written inside the calling agent's own output budget and is **already paid for** by the time
  `do_drop` sees it. Clipping saved nothing and discarded only the half the author believed
  they had filed — and a sink item is the *archive*, the thing meant to outlive the card that
  wrote it, which makes it the worst place on the wall to lose a tail.
- **And it is enforced on both write paths now.** `put_sink_item` capped merges only, so a
  fresh drop of fifty thousand characters was stored whole and only a *second voice* on it was
  guillotined — which is the newest words, the only part nobody had read yet.
- **A title is still capped (120) and is now announced.** A title is the item's name: `resolve`
  matches it, `store::put_sink_item` merges on it. Shortening one silently alters an identity
  key behind the caller's back, so the receipt says how far over it was and asks them to check
  it still reads as they meant.
- **`sink.ts`'s `MAX_BODY` mirrors the store's number** so the field in the Basin stops where
  the write does. It read 1,200 until the second cap went; a mirror of a cap that no longer
  exists stops the user a third of the way into what the write would accept.
- **`guidance::LIMIT` (4,000) is the one where silence cost most.** These are the user's
  standing instructions, they go into a system prompt, and a model handed three quarters of
  them follows three quarters with total confidence — while the person who wrote them is not
  in the conversation to notice. The marker is addressed to the model, because it is the only
  party present who can do anything, and what it should do is *say so* rather than infer.

## Verifying it, on a machine that cannot run `cargo test`

`bun tools/lift-clip.ts` — 13 assertions, and it is the cheapest lift in the repository
because it does **no brace scanning at all**.

It can avoid it because `clip.rs` has no `crate::` reference in it: nothing but `std`. So
`rustc --test` compiles the file whole and what runs is the real code with its real
assertions, rather than a transcription of them. That is worth protecting — the script checks
for `crate::` first and fails with a clear message if someone reaches into the crate later,
because the cheap verification is worth more than the convenience that would break it.

This deliberately does not join the seven older lifts in sink `4b20ad50`, each of which
carries its own copy of a brace counter that counts braces inside string literals and
comments. A module with no upward dependencies needs none of that machinery, and adding an
eighth copy of a known bug to test a fix for a known bug would have been its own joke.

What the lift does **not** cover: the caller-side assertions in `board.rs`, `guidance.rs` and
`relay.rs`, which depend on the crate. Those are held by `cargo check --profile test --lib`,
which type-checks test bodies without linking them — so on this machine they are proved to
compile and not to pass. Run them on a machine with MSVC.
