---
paths:
  - "src-tauri/src/spawn.rs"
  - "src/lib/lineage.ts"
  - "src/lib/Lineage.svelte"
---

# A card putting a card on the wall

This wall's thesis is that concurrent conversations are the unit of work, and for its whole
life only *you* could start one. An agent that had decomposed a job into four independent
pieces had two moves and neither was a card: do them one after another in its own context, or
spawn subagents that live inside its turn, report through it and vanish. A subagent cannot be
looked at, talked to, sent a message, or left running while you go and read something else.

`spawn` is the tool, and it is the most consequential one on this server. Almost all of the
file is the bounds.

### What it deliberately cannot do

A project card spawns with `--dangerously-skip-permissions`. A tool that let an agent choose
*where* a new one of those stands **by writing a path** is a tool that lets a model pick a
directory and be handed the machine in it — through whatever the agent happens to have been
reading all turn.

- **The child stands on the wall.** Where the parent stands by default, or in one of the
  wall's own territories, *named*. Never a path the caller composed: `project` is resolved by
  `standing` against `store::projects`, and a needle matching nothing is refused with the list
  of what would have matched. So the bound that cannot be argued around is no longer "the
  parent's cwd" but **the user's own declaration of where they work here** — a territory is in
  that table because they opened it and stays until they forget it (`forget_row`), so the set
  of reachable directories is one they curated rather than one a model composed. A
  subdirectory of a territory is not a territory, and a test says so.

  It was the parent's `cwd` and nothing else for the tool's first life, on the reading that
  the capability a spawned card has must be exactly the capability the spawning card already
  had. What that reading missed is that the wall is not one repository: a card in `atelier`
  that has worked out what `nova` and `caravan` each need could describe the work and then
  wait to be asked, which is the whole gesture the wall exists to remove. And the escalation
  it was guarding against is thinner than it looks — every project card on the wall already
  holds a shell with no permission prompt, so a directory the *user* put on the wall is not a
  reach the model has gained. A path it invented would be.

### Naming a territory

- **By name as `list` reports it, or by root path.** Path first, since `root_path` is unique;
  name second, folded for case, and both folded for separators — a model reading a path back
  out of `list` should not depend on which slash it chose.
- **Two territories can share a name and neither is picked.** Only the root path is unique, so
  `C:\dev\nova` and `D:\archive\nova` are both `nova`; guessing the first would open a card
  with the machine in its hands in the wrong repository, so it is `Ambiguous` and the refusal
  carries both paths.
- **Naming your own project is the default said out loud** — `Standing::Here`, which stands the
  child where the parent actually stands: its `cwd` *and* its worktree.
- **The tree is the half that was missing, and the sentence here was wrong for a while.** This
  bullet claimed `cwd` alone was what let a worktree card open one beside it. It is not: the
  row's `cwd` is the project root by design (`worktree.md` — that is what keeps a worktree card
  in its parent's territory, sharing its dev servers and its shell), so a child taking `cwd`
  alone landed in the **main tree**. Confirmed against the live database, where both cards
  reading `C:\Users\lyss.delprat\workbench\nova` carried a branch their children would not
  have had. That is the opposite of "beside": the child shares a checkout with whatever else
  is in the main tree, and cannot see one line of the work it was opened to help with.
  `Standing::Here` inherits `me.worktree` now, and only `Here` does — a card opened in another
  territory has no business carrying this one's branch name, and `worktree::ensure` would make
  a tree for it there.
- **And the receipt says they share a checkout**, because that is the one thing about a card
  opened here that the caller cannot see and has to act on. Two agents in one tree is how a
  morning's work ends up under somebody else's commit message (sink 8d3dab75, and the five
  muddled commits of 2026-08-24 that were read as one card duplicating itself). The wall has
  no other way to tell either of them.
- **Skein's own directories are not on offer.** Chat cards need an address and get a folder
  beside the database, which `#openIn` makes an ordinary `project` row of (`chat.md`) — a row
  in the table that nobody declared. `is_skeins_own` drops it, in `spawn.rs` rather than in the
  query, because what disqualifies it is where the database lives and SQL cannot see that.
- **Resolved before the id is minted**, so a misnamed project costs nothing against the hourly
  bound: an agent correcting a name is not an agent fanning out.
- **The receipt for a card in another territory is worded differently**, and not for
  decoration. "It has the brief and nothing else of yours" costs something real there — the
  child cannot read the file the parent was looking at, so whatever it needed from here was in
  the brief or is gone. And it is outside the caller's project, so the default `list` scope
  will not show it; being told that saves a round of looking for a card standing exactly where
  it was asked to.
- **A chat card may not spawn.** It reaches nothing on this machine on purpose (`chat.md`),
  and a chat card opening a project card would be a line from the open web to a shell — the
  hole `relay.rs` refuses `send` and `list` to close, one layer further up. Decided by asking
  the store what kind of card the caller is, never by trusting the caller, which is
  `spawn_conversation`'s own rule.
**One generation was here too**, and it is the third bound to come off — a card an agent
opened may now open cards of its own, and so may those. Its argument is kept whole over
`ONE_GENERATION` rather than paraphrased, because it is the argument that would justify
bringing something back: *the branching is the problem rather than the depth*, so a handful of
cards each opening a handful is dozens of agents on one prompt and then hundreds, and a depth
limit set at six would let all of it through because every spawn is a first. That arithmetic
has not changed. What changed is who is watching it — see the note under the bounds below, and
note what the argument actually recommends if it is ever wanted back: `MAX_LIVE` at every
generation, not a depth counter.

### And what it cannot help doing

It costs money and attention without asking. So does `send`, so does a broadcast, and the
answer is the same: bound it, make it visible, and say what it cost.

- **Neither number is switched on.** There were two: four children on the wall at once, and
  six spawns an hour. They answered different failures — how much is *running* and how fast it
  *arrives* — and both were guesses. The live cap mostly caught a parent blocked from opening a
  fifth card while its finished children stood on the wall waiting for somebody to close them,
  which `close` answers from the right end. The rate was the better-shaped of the two and the
  only one that could see a card asking for cards in a loop, including one whose spawns
  silently never drew (which is why it counted *asks*) — but it could not tell that loop from a
  genuine decomposition into seven pieces, and it answered both with the same refusal.
  - **Parked, not deleted.** `Option` each, `None` each, one word to restore either, and the
    guards are written as bounds that may not exist rather than as comparisons a sentinel
    slips through — a `0` in either would refuse every spawn on the wall, which is the failure
    a sentinel invites and an `Option` cannot express. `record_spawn` still writes every spawn
    down and `spawns_since` is kept with no caller, so a cap restored tomorrow is correct
    about today. The counting queries sit behind the `if`, so a wall with no caps does none.
  - **What bounds a fan-out now is the wall.** A fan-out you can see is a fan-out you can stop
    — the argument the bullet below makes about subagents, now doing the whole job rather than
    the half of it. If this backfires it will backfire as a wall you cannot read, which is a
    thing you *look* at rather than a thing a limit tells you about afterwards.
  - **What still refuses is the pair that are about what a card *is***, rather than about how
    much of it there is: where it may stand (a territory on the wall, never a path a model
    wrote) and no chat card. Neither is a guess and neither has a number in it, which is
    exactly why they are the two that survived. Every refusal still carries its reasoning, per
    `MAX_HOPS` — an agent told only "no" tries a different phrasing.
  - **And the tool says so.** With nothing left to refuse a spawn on grounds of quantity, the
    description carries the *absence* of the bound as plainly as it used to carry the bound —
    an agent that believes a limit is there treats the wall as something that will stop it, and
    this is the one tool on the server where that belief spends the user's money. A test holds
    it to saying so, and to naming what replaced it: the agent's own judgement, and `close`.
- **Every spawned card is a card.** On the wall, with a title, in `list`, named by the perf
  meter, closed by the same gesture as any other. Nothing about it is hidden, and that is the
  whole difference between this and a subagent — a fan-out you can see is one you can stop.
- **The description tells the agent to say so.** `Tell them you are opening a card, and why`,
  and a test asserts that sentence is there. This is the one tool on the server that spends
  the user's money on a turn the user did not ask for, and a quiet one would be the wall
  growing cards nobody accounted for.
- **The brief is the whole of what the child gets** — not the parent's context, not what the
  user said, not what has already been ruled out. The `prompt` field says so in those words,
  because a one-line prompt spends an entire card rediscovering what the parent already knew.

### Rust decides; the wall opens

`Skein.#openIn` is the one correct way a card comes into being: ensure the project, write the
row *before* the spawn so `spawn_conversation` can ask the store what kind of card it is,
resolve the account off the waterfall, mint the `Conversation`, load its history. Reproducing
any of that in Rust would be a second birth path, and the one that drifts is the one nobody
is looking at.

So `spawn.rs` checks the guards, mints the id, records the parentage and emits; `#openIn`
gained one optional argument and `Skein.openSpawned` is the door.

**And that is why a card in another project cost the front end nothing.** `spawn:asked`
already carries a `cwd` and `#openIn` already calls `ensure_project` on it — which finds the
existing territory rather than making a second one, since `root_path` is what a project is
identified by. A card opened in `nova` from a card in `atelier` therefore travels the same
line as `new conversation here` does in `nova`. Deciding *where* in Rust and opening it on the
wall is what makes that true; had the wall been the thing choosing, this would have been a
second door.

- **Minting the id in Rust is what makes the receipt useful.** The agent is handed the child's
  handle in the same tool call, so it can `send` to it or `recall` it without a round of
  `list` and a guess about which card is new. That is the only reason `#openIn` takes an id at
  all, and the comment there says so.
- **The brief goes in through `send`**, so it is echoed into the child's transcript exactly as
  a typed prompt is. What the parent asked for should be *readable* there rather than inferred
  from what the card does next.
- **A given title is not `named_by_hand`.** It is a label to tell cards apart until the card
  names itself from its first turn, and `read_ai_title` must be free to replace it — see
  `naming.md`.

### `spawned` is a table, not a column

`conversation.spawned_by` would have been the obvious shape and could not work. The row for a
card is written by the *front end*, and `spawn.rs` has to know the answer **before** the card
is opened, since that is when the guards are checked — so there is no row to stamp. Recording
the intent instead makes the question answerable at the only moment it is asked, and leaves
nothing to race. `store::migrate_v20` has the rest of it, including why nothing sweeps the
table: the value of a lineage is answering "was this opened by an agent" months later, and one
that evaporated when the parent closed would answer that wrongly and confidently.

## The root a spawned card stands on

For its whole first life the table had no reader: `spawned_by` was a command nothing called,
and a card an agent had opened looked exactly like one you opened yourself. `lineage.ts` and
`Lineage.svelte` draw it, and the reason it is drawn as a *root* is an argument with
`relay.md` that this feature wins.

**A standing line is honest here and nowhere else.** `flow.ts` refuses to draw a message as a
wire, because "a line between two cards says they are connected, which is a claim about the
wall that is not true — nothing connects two cards, and a message is an event rather than a
relationship". Parentage is the exception that argument implies: it *is* a relationship, it is
a row written before the child exists and kept after both cards are closed, so a mark that
stays says something true. Nothing about `flow.md`'s rule is weakened — it is the reason this
one is allowed.

**So the two are deliberately not the same drawing, and the difference is the layer.** A relay
strand is light in the air: braided, celadon, transient, above the cards. A root is in the
ground: opaque, achromatic, permanent, below them — the canvas is a sibling of `Backdrop`
inside `.surface` and *before* `.pan`, so it draws over the weather and under the territories,
the images and the cards. **Above a card is traffic; below it is structure.** That reading cost
no prose in the UI and no legend: it is the document order. It also means a root reaching a
card passes under it rather than across its title, with no rim arithmetic to get right.

- **Colour is status, so the root has none** — `--edge`, the tone the wall's own furniture is
  in, read off the document so a derived theme moves it. Parentage is as true of a card that
  finished yesterday as of one streaming now, so it cannot be a status colour, and
  `tokens.css` forbids a decorative one. The moving light everybody reaches for first — an
  arc, a spark, electricity — is available only by making it *mean* something, and there is
  exactly one thing it can honestly mean: a charge runs a root only while that child is
  working, in `--st-work`. `Canvas` derives that set from the same `tier` the card's own colour
  comes from, so the two can never disagree about what working means.
- **One trunk, forking, and the fork is emergent.** Four children in four territories is four
  strands across the wall, which is spaghetti; so children are clustered by bearing
  (`clusters`), one cluster is one trunk, and every limb of a cluster shares its first control
  point. They therefore leave along one tangent and separate smoothly, and *no trunk geometry
  is computed anywhere*. Every limb goes into one `Path2D` filled once, so the coincident part
  unions instead of stacking alpha into a seam — which is the only reason that trick works,
  and why the base widens with the number of children: a fat trunk splitting into thin
  branches is the whole reading.
- **Two territories, two trunks.** A mean direction over a child east and a child west is
  meaningless and a limb drawn along it doubles back through the card it came from. The wrap
  join in `clusters` is the other half: the sort's seam falls at due west, so a fan sitting
  across it arrives as two groups at opposite ends of the list.
- **Direction needs no arrowhead** — the taper is monotonic, thick where the work came from and
  a hair where it arrived. A relay strand answers the same question with the sign of its bow;
  neither wall ever draws an arrow.
- **Widths follow the zoom, where a strand's do not.** The one place this and `flow.ts`
  disagree, and each is right about its own thing: a strand keeps its width at every zoom
  because it is light crossing a room, and a root is a thing lying on the ground beside the
  cards — at `field` density a fixed 6px trunk against a 60px card reads as a cable somebody
  left out. Clamped at both ends, because at no zoom may the structure thin to nothing.
- **A new root grows out; a restored one is simply there.** `born` is stamped by `Skein` when
  `spawn:asked` arrives — the moment it happened — and is absent for every pair read back at
  launch, or the wall would sprout twenty roots as though each card had just been opened. The
  width profile is read against the grown length, so a half-grown root is a complete short
  root: a thing extending rather than a thing being revealed.
- **One clock, and it is `Date.now()`.** `born` mirrors a unix timestamp Rust wrote, so
  measuring growth against `performance.now()` is an epoch the root never started from —
  `reachOf` clamps to zero and nothing is drawn at all.
- **An idle wall runs no frames**, per `Backdrop` and `Flow`. A root that is neither growing
  nor charged nor leaving is a static shape, repainted from a reactive read when the wall moves
  and not from a clock. `stirring` answers the first two off the *rows* rather than the limbs on
  purpose: limbs are computed from the card boxes, so a check that read them would run on every
  frame of a pan. What that costs is one idle loop for a working child whose parent has been
  closed, which is the better side of the trade.
- **But the loop is owned by the component rather than by an effect**, which is where this and
  `Flow` part company, and the retreat is why. A departure is invisible in every input: `kin` is
  only appended to, and a card closing takes its box out of `boxes` — which is the same shape a
  pan has. So the only place it can be noticed is the paint, and a clock held by an effect keyed
  on the inputs would have nothing to re-run it: the departure would be detected and then sit
  there, one frame in, until the wall happened to move again. `ensureLoop` is idempotent and
  every paint calls it, so the churn `flow.md` warns about is avoided by the loop not being
  reactive at all rather than by choosing dependencies carefully.
- **A pair with an end off the wall is not half a root.** `familiesOf` drops it, and
  `store::lineage` asks the narrower question one layer earlier so the wall is never handed
  rows it will only throw away. The rows themselves stay, per the table's own note.
- **Read once, then only appended to.** A spawn *emits*, so the wall learns a new root from
  `spawn:asked` rather than by asking again; `Lineage.svelte` has no poll in it and
  `spawn::lineage` is called exactly once per launch.

## Closing one again

`close` had one rule for its whole first life, out of the `spawned` table: **a card may close
what it opened and nothing else.** Not the card that opened it, not a sibling, not one of the
user's, and not itself. One condition, read out of the same table the one-generation guard
reads — which is what let the tool exist with no rate limit and no confirmation of its own,
since every card it could reach was one it had asked for. The worst it could do was undo its
own work.

**That rule was right about the danger and wrong about the wall**, and the way it was wrong is
worth keeping because it is a shape that recurs. It was written while `MAX_LIVE` still bit,
when the case in front of it was a parent holding a slot it could not use — so the authority
was drawn around exactly that case and no wider. With both caps off, the failure the tool runs
into *first* is the opposite one: nothing clears a finished card except the user doing it by
hand, and on a wall of twenty cards the ones plainly worth tidying are mostly **not** the
caller's. An agent looking at a card that has obviously stopped meaning anything had one move
— say so in prose, and hope somebody acted on it. Tidying that has to be asked for in prose is
tidying that does not happen, which is the wall filling up with dead cards while every card on
it is behaving correctly.

So the authority moved rather than came off. **A card may name any card, and parentage decides
who says yes rather than whether anyone can.**

- **A card it opened** closes at once, exactly as before. Nothing about that path changed.
- **Any other card** parks the `tools/call` and puts the question to the user. Approved, it
  closes; declined, the caller is told it was asked and the answer was no.

Nothing closes on an agent's word alone that did not close on it before. What changed is that
a refusal became a question with a default of no — the difference between a tool that cannot
help and one that can offer. The general shape, since it is not really about `close`: **when a
guard exists to stop an agent acting unilaterally, the alternative to refusing is asking, and
refusing is only right where there is nobody who could usefully answer.** Which is the test the
three remaining refusals are chosen by.

- **`may_close` is pure, three-valued, and the order in it changed with the authority.**
  `Reach::Mine`, `Reach::Theirs`, `Reach::No(_)`. Parentage used to be asked *first*, so a card
  naming somebody else's card was told only that it was not theirs — answering "it is mid-turn"
  first would have been the tool reporting on a card the caller had no standing to ask about.
  That argument was about standing and **it dissolves the moment a card may name any card**: a
  caller entitled to name it is entitled to know why it cannot go, and "wait for it to finish"
  is what makes an agent wait where "not yours" makes it rephrase. So the three refusals are
  asked first now, and for a second reason that is the stronger one — none of them is a
  question worth putting to a person.
- **Itself is refused outright, and is stated rather than left to fall out.** A card tidying
  itself away would take its own transcript off the wall at the moment the user might be
  reading it, and it is the user's wall. `mid_turn` would catch it today, since a caller is
  inside a turn by definition while making this call — which is exactly why it is written down
  separately. An *emergent* guard is one that disappears the day something unrelated changes
  about turn marking, and nothing would fail loudly when it did.
- **Set aside is refused, and deliberately not asked about.** It is the one flag on a card that
  is an explicit human intention rather than a fact about the work (`restore.md`). Asking the
  user to approve overriding a decision they have already made is not a question, it is
  nagging — so the refusal says the user has *already answered it*, or an agent reads the
  refusal as the ask having gone against it and reports a decline that never happened.
- **Mid-turn is refused rather than warned about or asked about.** An agent part-way through
  does not stop cleanly — a file half written, a command that may or may not have run — and the
  wall would come back tomorrow asking that card to pick up a turn that was killed for a slot.
  The caller cannot judge from outside whether the turn matters, and **neither can the user from
  a one-line question**, which is what rules it out as something to ask: putting it to them
  would be handing over a decision with the evidence left out. Asked of the supervisor rather
  than of the row, because only the process map knows what is running.
- **The wall is re-read when the answer comes back, and that is not tidiness.** Ten minutes may
  pass between the question going up and the click. A card that was idle when the user was asked
  can be mid-turn by the time they answer, so `facts` runs again inside the settle and
  `may_close` is asked again — an approval is approval to close *that card*, not a licence over
  whatever is running under its id now. It re-resolves **by id**, not by the address the caller
  originally wrote, so a second card that has since arrived answering to the same title cannot
  inherit the approval. A card that has gone in the meantime answers that there is nothing to do.
- **Only the button is a yes.** The panel has a free-text field beside the options
  (`Ask.svelte`), so what comes back is arbitrary prose, and `approved` matches the exact label
  and nothing else. Reading a yes out of prose works until "yes, but let it finish the commit"
  or "no, close the other one" — and the failure is a card taken off the wall on a sentence that
  said not to. Every other answer is carried back to the agent **verbatim** rather than
  flattened into a no: the user has said something, and the agent is the thing standing there
  able to act on it. A deliberate "leave it open" is told apart from typed prose, because an
  agent that cannot tell a decision from a refusal goes and asks in prose for the thing it has
  just been told.
- **The refusal text could not be reused for the decline.** "It is not yours to close, so say so
  and let the user do it" is the same *outcome* and a false *statement* once the user has been
  asked — and an agent told to go and ask them is an agent that asks twice about one card. The
  decline says it was put to them, what they said, and to stop.
- **`why` earns its place where `note` did not.** There is still no `note` argument — a line on
  why it was closed, stamped on the row, would be a column nothing on this wall renders, and the
  sentence belongs in the reply the description asks for. `why` is the opposite case: it is read
  by a *person*, in the question, at the moment they decide, about a card they may not have
  looked at in hours. Optional, because a card closing one of its own never needs it, and named
  as an absence in the question when it is missing — a question that simply carries no reason
  reads as a card that needed none.
- **Only its own children, which now means only its own generation** — for the *immediate* path.
  With `ONE_GENERATION` off a card can have grandchildren, and `spawner_of` names the middle
  card rather than it, so closing one is an ask like any other card's. That is the right answer
  rather than a gap. What it can still do unilaterally is close the middle card, and the wall
  does the rest: the grandchildren stay standing on their own and their roots retract, because a
  root whose parent has left is a pair `familiesOf` drops.
- **The address is `relay::resolve`**, the same function `send` uses — including its refusal of
  an ambiguous title, which here is the difference between closing the right card and closing
  one that shares its name. `resolve` became `pub(crate)` for this: what a written address
  means is one question and must have one answer.
- **Closing is not deleting**, and now three things say so in those words: the description, the
  module note, and — the one that matters most — **the question itself**. An agent that believes
  the tool destroys work will avoid one it should use; a *user* who thinks "close" means destroy
  says no to every one of them, and they are the one who cannot go and check.
- **`close` is routed by `ask.rs` and not by `spawn::handle`.** It is the second tool on that
  server whose answer may not be ready yet, so the decision has to be taken before the transport
  commits to answering on the spot. `handle` deliberately does not know `CLOSE_TOOL` any more —
  two routes to one decision is one route that drifts, and the one nobody is looking at is the
  one that does.
- **What bounds the asking is the caller's own turn.** A close that asks parks the calling
  card's `tools/call`, so a card can have at most one outstanding question and pays for it with
  the turn it is in. That is the same bound `ask_user` has and it is a real one — a loop of
  close-asks is a card that never gets to make a second call. It is not a bound on *nuisance*,
  which is why the description spends a paragraph on when to offer rather than relying on it.
- **The wall does the closing**, for the reason it does the opening and more so: `Skein.close`
  takes the card off the wall *before* its three bookkeeping calls, which is a bug that shipped
  once already (`restore.md`), and a second path in Rust would have to keep remembering it. The
  listener's own guard is only that the card is still on the wall — two calls in quick
  succession would otherwise run the bookkeeping twice against a row already closed.
- **A card can be both ends now.** With generations unbounded a card may have a root coming
  in and roots going out, and nothing needed changing for it: `familiesOf` groups by parent, so
  such a card simply appears once as somebody's kid and once as somebody's parent. What the
  wall draws is a chain, which is what the lineage now is.
- **A root is reeled back in when its card goes.** `familiesOf` drops the pair the moment
  either end leaves `cardBoxes` and the card itself vanishes without waiting for anything — so
  the retreat cannot be drawn *from* the wall, and `Lineage.svelte` keeps the last geometry each
  limb had (`seen`) precisely so there is something to withdraw. Four things about it:
  - **It is anchored to the parent, not to the glass.** The frozen spine is kept beside the
    parent's centre at the moment it left and shifted each frame by however far that card has
    moved since, so a pan or a drag during the retreat carries it. Without that, half a second
    of a root pointing at nothing. A zoom mid-retreat is not corrected for, and says so.
  - **It stays a whole root while it shrinks**, because the width profile is read against what
    is left — the same property growth relies on, in reverse. What withdraws is a shorter
    complete root rather than a long one being clipped.
  - **The fade is held and dropped late.** An even fade spends half the animation on a root too
    faint to see moving, which is the only thing there is to watch.
  - **A family closed together retreats as one shape.** The union fill is grouped by weight and
    a shared departure time is a shared alpha, so the trunk they still have on the way home
    does not darken where it overlaps.
