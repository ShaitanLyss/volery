---
paths:
  - "src/lib/solo.ts"
  - "src/lib/Solo.svelte"
  - "src-tauri/src/flyway/solo.rs"
  - "src-tauri/flyway-core/src/fleet.rs"
---

# Flying solo: the flyway's books without its traffic

**Design, unbuilt** (2026-11-13). Decided with Lyss: the word is *flying solo*; the empty
left strip holds a small panel with the switch; one switch closes the whole flyway.

### The failure this exists for

A weekend, the personal laptop. The work laptop's cards, prompts, questions, notices and
screens should not be here. Leaving the flyway works and is the wrong door: it drops the key,
and with it the account settings, the allowance readings, the usage rollups and the
live spend. Away works and is wrong in the other direction: it is a claim about *the
person*, and the fleet goes on drawing this wall's cards, sending it questions,
carrying its notices and its billboard. Flipping away on the personal laptop only makes
the work wall file questions sooner, and the filed pile then travels to the personal
laptop — the pile is hers, not a machine's (`away.md`).

The ask in her words: *"it should be nearly the same as being off the flyway except for
things like analytics and usage and synchronising thresholds … it should be like I'm
away for the flyway despite being present on my personal laptop."*

### Two fabrics

The flyway carries two kinds of thing, and the whole rule is the line between them:

- **the books** — the roster and who is heard; the accounts and their settings (on/off,
  caps, priority, rank); the allowance readings and their resets; the hourly analytics
  rollups; the live spend beat; the burn rate; each wall's build. Numbers and
  membership.
- **the traffic** — cards; prompts and everything that rides them (pictures, files,
  answers, recalls, closes, acts, moves, an open-a-card-there); questions; notices;
  confirmations; the filed pile; the billboard; the sink; transcripts; files; pictures;
  and screens — the monitors a wall advertises and every frame behind them.

**Flying solo keeps the books and stops the traffic, in both directions.** A surface
added tomorrow is placed by asking which fabric it belongs to, not by appending to a
list — the failure `elsewhere.md` records biting twice in one day, and the reason
`ask::Settle` makes travelling part of writing a confirmation.

The line is a gate in the link, not a filter in the drawing. A drawing filter would hide
the cards while still receiving questions into the dock, ringing the attention ladder,
waking cards with prompts and writing rows. Each of those is the weekend failing where
it cannot be seen.

### The three states

| | the person | the link | conversations | the books |
|---|---|---|---|---|
| **off the flyway** | anywhere | no key, or left | none | none |
| **away** | not at this wall | up and fully social | this wall files rather than parks; the pile travels to where she is | cross |
| **flying solo** | at this wall, working | up | **none either way** | **cross** |

Solo is not away: away still publishes and receives the social fabric, where solo is the
one state that says *this machine is not taking part in the conversations*. It is not
leaving: the key, the roster, the accounts and the numbers stay. And it is not per-peer:
one switch closes the whole flyway's traffic, because the weekend case hides work and
has no second wall it wants kept, and per-peer would multiply the state, the wire and
the panel for a case nobody has asked for. If that case ever appears, it is a standing
per host layered under this one, not a replacement.

### What crosses, and what does not

**Crosses:** the roster and liveness; the accounts (settings and readings); the allowance
and every window; analytics rollups and the day pull; live spend; the burn rate and
`wants_rate`; build and dev; the directory, the goodbye and the leave machinery.

**Stops, both directions:**

- **Cards** — no snapshot published, none adopted. No shadows, sections in the left
  strip, roots or remote glass spots drawn. Stored spots are kept, not pruned, and
  return with the sections.
- **Prompts** and everything on that wire — pictured, recall, close, act, move,
  open-a-card-there. Refused at once, never queued; a peer that asks is told the wall is
  solo. A prompt delivered when the shutter lifts would be a turn on a card running with
  the machine in its hands, which is why nothing waits.
- **Questions, notices, confirmations and the filed pile** — no remote rows in the dock
  or on the attention ladder, no sheets, no ring. The asking wall files into its own
  pile; Monday is where it is answered.
- **The billboard and the sink** — neither said nor read. They are the two places where
  one wall's work narrative reaches another.
- **Transcripts, files and pictures** — no tail, no look, no see.
- **Screens** — no monitor list published, and no frame received. Every remote screen
  surface comes down: the wall widget, chat view's screens group and sheet, the all-screens
  grid, vignettes and immersive. The cast hub drops its remote subscriptions, and a frame
  already in flight is abandoned. This wall's own monitors are untouched; the grid and the
  sheet offer only them while solo. A remote tile's position on the wall or the glass is
  kept, and the tile returns on flying again.
- **Remote spawn** — the wall withholds the workplace facts (cards, territories,
  credentials, screens) and announces no capability, so every remote verb is refused
  before it is attempted.

**Local work is untouched.** This wall's cards, questions, pile, billboard, sink, timers
and widgets carry on exactly as they would with no flyway at all. The shutter is a
boundary around the machine, not a mode on the wall.

### Presence: behave as away, say solo

Other walls must file rather than park when they want her, or a work card stands parked
all weekend and then asks her on Monday with its premise gone.

So a solo wall announces **not here** — the word every peer already understands — and,
to a peer on this build, **solo** as a fact of its own. The first makes an older peer do
the right thing without an update; the second lets a new peer draw the honest roster row
(*solo — flying alone; its accounts and spend still report*) instead of pretending she
is absent. `present_elsewhere` ignores a solo wall: a quiet wall already counts as away,
and a solo wall is the same answer with a reason.

The wall's own `away` switch stays independent. Solo is about the flyway; away is about
the keyboard. A solo wall whose own cards ask still asks her here.

### The plate in the empty strip

The left strip where the other walls' sections normally stand holds a small panel,
rather than an empty gap that reads as a failure. `Solo.svelte`, at the head of the
strip, one column wide, dotted border like another wall's region and no drop shadow: it
is a note about the flyway's absence, not a card.

It carries: the heading `flying solo`; `solo since friday 18:04` in mono; one plain
sentence — *Your accounts, allowance and usage still sync. No cards, questions, notices
or screens cross.*; the button `fly with the others`; and the chord. When cards here
were opened by another wall it adds one line: *2 cards here were opened from another
wall and keep running.*

It is not a card: no focus, no pick, no carry, no menu, no glass, no Tab. The button and
the chord are its gestures. It scales with the wall; at a zoom where it cannot be read,
the chrome mark still is.

### The chrome mark

The existing flyway button wears the state: while solo its label is `solo`, and it is
kept in the bar on `boost`'s argument — a state that changes what the machine is doing
is not given up for the zoom. Its title says the rest. No new bar entry, so
`chrome.test.ts`'s three lists stay as they are. Clicking it opens the flyway panel,
which carries the switch; the plate carries the direct way out.

Chat view has no left strip. The state is the same one: the chrome mark, the flyway
panel, and the absence of the remote rows from the sidebar. The plate is wall furniture,
so it lives only where the furniture does.

### The flyway panel

A section above *work from other walls*, because it is the larger boundary: the heading
`flying solo`; the state and its start; the plain sentence about what stays on — *accounts,
allowance, usage and analytics stay; cards, questions, notices, screens, boards and sinks
do not cross*; `fly solo` / `fly with the others`; `space then i s`. While solo, *work from other walls*
says it is closed anyway, whatever that switch is set to.

The chord is in the *I'm …* family beside `ia`, because solo is a claim about where you
are on the flyway, and `is` is free there. The leader's no-prefix rule is the only
constraint.

### Entering, and what happens to what is already on the screen

- **The remote queue comes down.** Remote questions and notices leave the dock, their
  sheets close, their attention rows go, the strip empties.
- **A remote screen comes down rather than freezing.** A tile onto another machine has
  nothing behind it once the traffic is closed, so it is not left showing a dead last
  frame: the widget, a vignette, an immersive session, a cell in the all-screens grid and
  a row in chat view's screens group all go. A drive in progress is released first, as
  leaving a tile always does, so no key is held down on a machine nobody is watching.
  This wall's own monitors keep drawing, and positions are kept for the return.
- **A half-typed reply is never taken.** If the dock holds words typed into a far card's
  answer, the switch refuses in words, naming the card and its wall; no dialog. Losing
  what you were typing is the failure the hold rule exists to prevent.
- **An answer already sent is the far wall's.** Solo stops what has not left.
- **A held answer to a filed question stays held** and goes when the wall flies again.
  It is an answer she gave; the card was told it would arrive as a message, and the
  fleet's quiet-wall rule already keeps it. Nothing is dropped.
- **A draft aimed at a far card is kept** and returns with its card. Nothing is sent.
- **A card opened here by another wall keeps running.** Solo stops traffic, not work; a
  card is a conversation somebody may still want, and leaving the flyway has always left
  those alone. The plate says how many there are, so the choice is visible.
- **No confirmation plate.** The gesture is reversible in one press and its state is
  always on screen; a dialog would make a quiet weekend feel like a destructive act.

### Flying again

Called *flying again*, not *coming back*, because coming back is away's word.

- Peer snapshots are read from scratch. The wall gets the fleet as it is now, not as it
  was on Friday: cards closed over the weekend are gone, cards opened are here.
- Filed rows ride the snapshots again, so a peer's pile appears as it would have before
  the shutter. The pile is hers, and flying again means the fleet is back, backlog
  included.
- The stored glass spots for shadows are kept through the solo and return with the
  sections; a remote screen's tile returns to its place too.
- **No schedule.** A time-based auto-lift would be Volery deciding where she is, the one
  thing `away.md` refuses to let a card do. Solo is a claim the person makes and
  unmakes. *Until Monday* is what she means, not what the wall should infer.

### What it is not, and what still leaks

- **Not a privacy guarantee.** The other walls still see this wall on the roster, its
  build, its allowance and spend, its rate, and whatever names the analytics sidecars
  carry (a session, a project, an agent). If the numbers must not cross either, the door
  is *leave the flyway*, and the panel says so rather than implying the shutter is
  stronger than it is.
- **Not a block, and not a forget.** Nothing is removed, and flying again returns
  everything.
- **Not a card tool.** A person's switch only, as *take work from other walls* is. A card
  may say *I'm away*; no card may close the machine's conversations.
- **Leaving ends solo.** There is no flyway to be solo from, and a rejoin must not
  silently start closed.

### Compatibility

Both walls need this build for the full reading. An older peer still files instead of
parking, because it reads the *not here* word it already knows; it draws this wall as
not taking work rather than as solo, and its snapshots and prompts are dropped at this
wall's door. Nothing it sends reaches a card here, and nothing here is published for it
to draw. The panel says which walls are too old to show the honest row.

### What the demo would have to show

Two frozen labs (`lab a`, `lab b --peer a`), one card each:

1. A flies solo. A's strip empties and the plate stands; B's roster says A is solo; both
   shadows go before anything else is pressed.
2. With A solo, a card on B calls `ask_user`. B files it (A is not reachable, and B is
   away or idle), the question never draws on A, and B's own pile holds it. A's dock and
   peek are unchanged.
3. While A is solo, both usage widgets show the same account totals, the same caps and
   the same burn rate; a cap raised on B arrives on A. This is the half that proves it is
   not leaving.
4. A card on B tries `send` to A's card by its old handle: refused at the door with the
   solo named.
5. Before A flies solo, a remote screen of B is up on A's wall and one of A's own monitors
   is up beside it. On solo the remote tile comes down and stops its session; the local
   monitor keeps drawing; the all-screens grid on A offers only A's monitors. Flying again
   returns the remote tile to its place.
6. A flies again: the sections return, the stored glass spot is where it was, and B's
   still-waiting filed question appears in A's pile.
