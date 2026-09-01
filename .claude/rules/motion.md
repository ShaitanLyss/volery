---
paths:
  - "src/lib/motion.ts"
  - "src/lib/motion.svelte.ts"
  - "src/lib/Card.svelte"
---

# How much the wall moves, and what that costs

### The bug, and why it took three goes

`Card.svelte`'s status glow animated **`box-shadow`**. Chromium cannot composite
that property, so every frame re-rastered the card's layer and re-uploaded its
texture — per working card, forever, on a wall nobody was touching. Two cards
filed it independently (sink `5516fc48`, `79bce319`) as "36–47% of the GPU 3D
engine, idle, nothing animating", and neither found it, because the glow is
*designed* to be too subtle to notice.

Measured on the live wall, regressing GPU 3D against the number of cards drawn
`work`:

    slope     +7.98% of the 3D engine per working card
    intercept  5.7%
    r         +0.677        (131 samples over 13 minutes)

    1 card 13.3%   2 cards 22.4%   3 cards 28.3%

That is the reading that names it. It also mattered off this wall: this machine
is where Nova's walk-mode and Pixi numbers are taken, and
`nova/docs/design/store-viewer-perf-audit.md` recorded it as unable to produce a
trustworthy frame rate, blaming compositor state and EDR — never the studio.

### The second half, which is the surprising one

Taking the re-raster away is worth about a third and **is not the main term**. On
this GPU the cost is driven by the **present rate**, not the painted area: any
continuously animating element makes the whole window present at display rate,
and presenting this window is itself 5–7%. An 8px animated dot cost 7.4% against
a still wall's 0.6%.

So there is no clever fix that keeps smooth motion cheaply, and the two levers
that remain are the two settings. Twenty cards, isolated, same compositor:

| | GPU 3D | CPU |
|---|---|---|
| `box-shadow`, smooth — what shipped | 18.9% | 100% |
| `full` — opacity on a pseudo, smooth | 10.8% | 39% |
| `spare` — the same, `steps(8, end)` | 2.0% | 21% |
| `still` — nothing moves | 0.0% | 11% |

`full` is the default: a preference about *this machine's* GPU is not one to
assume on someone's behalf, and the request that prompted the setting
(sink `acd6e5bf`) asked for a state you *enter* when the machine is needed for
something else. It lives in localStorage for the reason `theme.md` gives — this
is per-machine and disposable, and carrying it to another machine in the database
would be carrying the wrong answer.

`still` stops the wall's other never-ending motion too — the seat bubbles, the
tool-call pip, the caret, the transcript pip. Each of those already knew which of
its animations were decorative, because each already turns exactly that set off
under `prefers-reduced-motion`; the `[data-motion="still"]` arm is written beside
the block that names it, so the two cannot drift apart.

### If you ever measure this again, four traps

Reasoning about this failed twice before it was measured. All four of these
produced a confidently wrong number first.

- **An occluded window has its animations suspended**, so a mode measured behind
  another window reads as *free*. A whole first batch inverted the result this
  way. `--disable-features=CalculateNativeWinOcclusion` and have the page report
  its own frame count, so a stopped window is visible as stopped.
- **A card measuring the idle wall is itself mid-turn**, streaming tokens into an
  open transcript. Both sink reports assert the wall was idle; neither could have
  been. Log from a process outside your own job object — `Win32_Process.Create`
  gives one parented to `WmiPrvSE` — and then say nothing while it runs. A
  `Start-Process` from a tool call is torn down with the turn.
- **Agent CPU is not "cards breathing".** A card mid-turn waiting on the API
  burns no CPU while still drawn `work`, so GPU correlates −0.16 with agent CPU
  and +0.68 with the thing that actually matters. The honest proxy is the
  persisted mid-turn flag — `store.rs`'s `set_mid_turn`, which writes the column
  confusingly named `interrupted`.
- **`prefers-reduced-motion` is not a lever you can pull from outside.** Toggling
  `SPI_SETCLIENTAREAANIMATION` never flipped the media query here; an A/B built on
  it produced 26.9 → 23.3 → 22.8 and the restore never recovered, which is what a
  lever that does nothing looks like. Validate it by putting
  `matchMedia(…).matches` in the page title before believing a single number.

### What the before/after is, exactly

The table above is the **real shipped CSS**, measured in Edge against the same
compositor (152 against WebView2 151), twenty cards, three modes plus the
original. It is not a rebuilt Volery.

That is a limit of the evidence and not of the machine — `build.md` is right
there and `tools/build-gnu.ps1` builds the whole tree without MSVC. The reason
is duller: a card only glows while it is mid-turn, so a second instance opened
against the store shows twenty *dormant* cards and no glow at all, and the buggy
build measures the same 0% as the fixed one. Proving it in a running Volery means
real agents taking real turns, which costs money and disturbs the wall. The
regression against the live wall (+7.98%/card) is what ties the mechanism to this
app; the table is what ties the fix to the mechanism. Anyone wanting the last
link should install a gnu build and watch whether GPU still scales with the
number of working cards.
