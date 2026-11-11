# The tour: what Volery is, shown in Volery

`<space>h`, the title bar's **tour** button, an offer on an empty wall and on the first
launch's wall-or-chat question. A full-window overlay with nine chapters, one idea each, and
one thing to touch in each.

It exists for two audiences that are the same audience: a room being introduced to the app,
and a colleague who wants to look again next week without asking. That is why it is in the
app rather than a deck. A deck goes stale, and a deck someone has to find.

## It spends no allowance, and that is a design constraint

Every conversation, question, tool call and card in the tour is a constant in
`src/lib/showcase.ts`. Nothing spawns, nothing invokes, nothing reads the store. Opening it on
a plane works; clicking through it in front of a room costs nothing; and no demo can fail
because a process did not come up.

`test/showcase.test.ts` asserts the module does not import `@tauri-apps` or call `invoke`, so
the constraint cannot be lost by a later convenience.

## It is an overlay, not a page and not the wall

The wall has nowhere to put a document, and the thing being demonstrated is the wall itself.
An overlay also lets the tour use a larger type and a quieter ground than the work surface
without pretending the work surface changed.

It closes on Escape and on its own buttons. It does not close on a click outside, because a
presentation is one long sequence of clicks and a scrim that dismisses on any of them is a
tour somebody loses halfway through.

## Reuse the components that are safe to reuse

`CtxRing`, `Markdown` and `Icon` are the real ones. `ShowTranscript` renders real markdown
through `parseMarkdown` and `Markdown.svelte`, so the prose is not a picture of a transcript.

`Ask.svelte` is deliberately **not** reused. It is wired to a parked HTTP request, four
stores and a live `PendingAsk`; mounting it in a demo would need a real card behind it.
`ShowAsk.svelte` borrows the vocabulary (amber, the spine, the numbered keys, a detail line
under every option) so the real panel feels familiar when it first appears.

The rule for a new chapter: reuse a component when it takes data, and draw a faithful
likeness when it takes a live card.

## Chapter order is the argument

`CHAPTERS` in `showcase.ts` is one array, and the order is the argument: why, the wall, a
card, a question, cards together, the desk, the comparison, security, what comes next. The
rail, the keyboard numbers, the progress line and the next/previous labels all read from it,
so a chapter added tomorrow costs one entry and one branch in `Showcase.svelte`.

A chapter carries a `title` (the rail's word), a `head` (a sentence), a `lede` and an optional
`do` line. The head is not the title repeated: `test/showcase.test.ts` asserts they differ.

## The copy rules

The house voice, plus the ones this surface kept getting wrong:

- No em dashes and no en dashes. The test reads the module's own text and fails on either.
- No antithesis as the default shape ("x, not y"). One is allowed where it earns its place;
  a chapter of them reads as generated.
- No paragraph whose only job is to be quotable.
- Say the specific thing: a file, a number, a real workflow.
- The humanizer checklist in `tx-toolkit`'s presentation skill is the reference.

The comparison table has to keep saying **no** and **partly** about Volery. A matrix that
only says yes is an advertisement, and the note under it names what the other tools are
better at.

## Security has two drafts, and the constant picks one

`SECURITY_STAGE` in `showcase.ts` is `"current"` or `"hardened"`. Both drafts of the facts,
the headline and the four planned items live in the file. When the second factor and the
machine-bound credentials ship, flip the constant; the chapter changes, and the copy that is
no longer true does not have to be rewritten from memory.

The chapter names every gap it is honest about, and marks each planned item as `planned` or
`shipped`. The stolen-key demo is the load-bearing part: a switch that takes the key, and a
second switch that adds the factor, so the same attack can be watched succeeding and then
failing. `theftStory` is pure and tested for all four combinations.

Do not soften the line at the foot: a project card still holds the repository with both
hands, and no part of this chapter changes that.

## Where it is mounted, and the lists that have to agree

- `leader.ts` has the `h` chord and the `showcase` member of the `open` verb. The action
  palette gets it for free, because it lists every chord.
- `App.svelte` has `showTour`, the `tour` entry in `barButtons`, and `tour` in **both**
  `BAR_ORDER` and `FOLD_ORDER`. A key in one list and not the other is a button that exists
  only in the array, which is the failure `chrome.test.ts` exists for.
- Chat view has no room for a labelled button, so `barExtras` draws an icon-only one when
  `chat` is true. The wall draws the word.
- An empty wall offers it under the two lines that say how to start.
- `Welcome.svelte` takes an optional `ontour`. The tour opens over the question and leaves it
  standing, so taking the tour does not answer the question for you.

Keyboard: arrows or j/k move, 1 to 9 jump, Home and End, Escape closes. The root stops every
key from reaching the wall while it is up, and the app's overlay guards include `showTour` so
a key that somehow escapes still does nothing.

## Looking at it without MSVC

This machine has no MSVC, so `tauri dev` and the lab cannot start. `showcase.html` and
`src/showcase-preview.ts` serve the tour alone in a browser:

```
bun run dev
# http://localhost:1420/showcase.html?at=security
```

`vite build` takes `index.html` only, so neither file reaches an installer. Each chapter can
be opened directly with `?at=`, which is how it is checked one at a time.
