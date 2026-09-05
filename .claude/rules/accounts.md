---
paths:
  - "src/lib/accounts.ts"
  - "src/lib/waterfall.svelte.ts"
  - "src/lib/Accounts.svelte"
  - "src-tauri/src/accounts.rs"
  - "src-tauri/src/claude.rs"
  - "src-tauri/src/signin.rs"
  - "src/lib/signin.ts"
---

# More than one subscription, in priority order

One account runs out at four in the afternoon and twenty cards stop. That is the
whole problem. Skein already knows what is left of an allowance
(`.claude/rules/usage.md`) and already spawns every card itself
(`supervisor.rs`), so it is the only thing on this machine positioned to spend a
second subscription without anybody noticing the first one ended.

This is the subsystem that does it: a registry of accounts in tiers, a ceiling
you set per account, a swap that costs a card nothing it had already read, and a
wall that stops rather than fails when there is genuinely nothing left. A tier
is spent before the next is touched; accounts sharing a tier are declared
equivalent and share the work between them.

### The credential is not ours to hold, and an account is a store rather than a token

**An account is its own Claude Code credential store.**

```text
~/.claude/accounts/<label>/.credentials.json
```

A card is put on one by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, set on the child at
spawn. Probed 2026-08-20 against claude 2.1.235 — the variable selects the
credential store and *only* the store:

```js
function Qee(){                              // the dir .credentials.json lives in
  let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (e !== undefined) return (e || path.join(os.homedir(), ".claude")).normalize("NFC");
  return kn();                               // otherwise the normal config dir
}
```

Four things about it, and the design rests on all four:

- **A swap is per-process**, so two cards can be on two accounts at the same
  moment. Skein writes nothing in any store; the CLI owns them, which is the
  race `limits.rs` refuses to enter said from the other side — nobody loses a
  credential race nobody is in.
- **The config directory stays shared**, which is the whole reason this variable
  and not `CLAUDE_CONFIG_DIR`. That one isolates the accounts properly and is
  the wrong tool: it splits the session transcripts three ways, and a session
  started on one account could then never be resumed on another. **That resume
  is the entire swap mechanism.** Verified: a real `--print` turn under a
  per-account store wrote its transcript to the ordinary
  `~/.claude/projects/...`.
- **There is no quiet fall-through.** An empty store dir answers `loggedIn:
  false, authMethod: "none"` rather than reaching for the global sign-in — so a
  card on an account that is not signed in fails loudly instead of spending the
  wrong subscription. `supervisor.rs` checks first and says so.
- **The credential refreshes itself**, because it is an ordinary store and the
  child is an ordinary Claude Code. This is the half a token in the environment
  could not do: `CLAUDE_CODE_OAUTH_TOKEN` carries no refresh token, and the CLI
  says as much when one expires — *"which has no refresh token — it cannot
  self-heal"*.

And an account now announces whose it is: `authMethod: "claude.ai"` with
`email`, `orgName` and `subscriptionType`. So `limits.rs` can name the plan a
percentage is a percentage *of*, per account, which under token auth it could
not.

#### Why it was tokens, and what that cost

This was `~/.claude/tokens/<label>.tok`: a long-lived token from `claude
setup-token`, DPAPI-wrapped, put on the child as `CLAUDE_CODE_OAUTH_TOKEN`. It
spawned cards perfectly well and did nothing else, because **a `setup-token`
token is scoped `user:inference` alone.** Probed 2026-08-19: the same
`GET /api/oauth/usage` request answers `403` for it and `200` for the CLI's own
credential, whose scopes are `user:profile user:inference
user:sessions:claude_code user:mcp_servers user:file_upload`. It is deliberate,
it is not a flag we missed — the authorize URL the CLI builds for `setup-token`
carries `inferenceOnly: true`, `scope=user:inference`, and its own diagnostics
say long-lived tokens *"are limited to inference-only for security reasons"*.

The failure that produced was much larger than a missing percentage, and the
shape of it is the lesson: `accounts.ts::standingOf` read "the allowance could
not be read" as `unusable`, in the same bucket as "no token" and "switched
off". So every account was permanently unusable, `choose` returned `none`, and
**every send met "no account available"** — for an account that would have run
the turn. One missing scope, four hops, whole feature down. *A capability that
fails over a network must not be allowed to decide whether a thing exists.*

`standingOf` was fixed as well as the credential, and deliberately both: an
unreadable allowance now yields `ready` carrying why it is unmeasured. The
reasoning survives the fix, because an account **held in reserve** is the case
that bites — nothing runs on it, so nothing refreshes its credential, so its
reading can be stale exactly when the waterfall wants to move work there.
Refusing it then would make the reserve unreachable, which is the one job a
reserve has. What is genuinely lost is small and is said on the face: with no
reading **your caps cannot be applied**, so the first turn on an unmeasured
account may cross a ceiling you set. That turn refreshes the store and every
reading after it is real. The server's own ceiling is never crossed this way —
a refusal is what `markSpent` and the reactive swap are for.

#### What the store costs

It is a plain JSON file on Windows, exactly like the global
`~/.claude/.credentials.json` beside it, so this **loses the DPAPI wrapping**
the `.tok` design had. Said plainly because it is a real regression in one
respect — and an improvement in another that matters more: **on every path a
card takes, Skein handles no credential at all.** It writes none, holds none in
memory, puts none in a child's environment, and names a directory instead. The
one place one is read is `limits.rs`, asking the allowance endpoint the same
question about the same file the CLI reads. The database still holds only the
label, the rank and the caps, so deleting it still costs no credentials.

That was once true without the qualifier, and the qualifier is load-bearing now:
carrying the sign-ins to a second machine writes and reads them deliberately.
See *Carrying a waterfall, and then carrying the sign-ins* at the end of this
file for what bounds it — the short version being that the front end still
never sees a token.

The one thing this arrangement rests on that could move under us is an
undocumented environment variable. If it ever stops being read, the failure is
loud rather than silent — an empty store means `authMethod: "none"`, which is a
card that will not spawn rather than a card quietly spending the wrong account.

### The order is an order across tiers, and a preference inside one

Accounts have a **priority** and, within it, a **rank**. Work falls to the
lowest priority that has an account allowed to take it, and the next priority is
not touched until every account in that one is blocked.

**Across tiers this is strictly waterfall, and the argument for that has not
changed.** Not the account with the most headroom. Those two policies differ in
exactly the way that matters — spreading by headroom keeps three accounts at 40%
and leaves you with three part-exhausted subscriptions and no clean one, where a
waterfall keeps the second and third untouched until the first is genuinely
spent. A reserve is only a reserve if something guards it. That is why a tier is
a hard boundary rather than a weighting, and why nothing in `choose` looks below
the lowest ready tier for any reason at all.

**Inside a tier the same guard is deliberately given up, and the user gave it
up on purpose.** Asked for on 2026-09-05, in these words: *"All the accounts on
a given priority are to be fully used before moving on to the next priority, and
when on a priority level, spawn/clear picks the account with the less usage of
the current available priority… I want to assign priority 1 to both my company
accounts, then priority 2 for my personal one."* Putting two accounts on one
priority is a statement that they are the same pocket — there is no reserve
being guarded between two company subscriptions, and running one flat before
touching the other buys nothing while costing every swap in between. So within a
tier the least-spent account takes the next turn, and the tier runs down
together.

Both halves are in one sentence: **the reserve is guarded by the tier boundary,
and given up inside it, because that is what putting two accounts on one number
means.** A wall that wants the old behaviour exactly has one account per tier,
which is what `migrate_v30` leaves and therefore what every wall upgrading into
this feature is running until somebody changes a number.

**"Least spent" is `spentOf`, and it is not the raw percentage.** For each
window, `used / capFor(account, kind, bypass)`; the max across windows. What has
to be equalised, if a tier is to run out together, is *how close each account is
to being refused* — and a cap is part of that distance. An account capped at 50%
sitting at 40% has spent 0.8 of what it is allowed; an uncapped one at 60% has
spent 0.6. The capped one is nearer the door and should take less work, which
the raw percentages get exactly backwards. It reads `capFor` and the same window
set `blockersFor` walks rather than a second copy of either, for the reason
`speaksWith` gives below: two definitions of "full" in one module drift, and
here the drift would be a tier that keeps choosing the account nearest its
ceiling and then blocking it.

Two edges are worth knowing. A cap of zero has no headroom to be a fraction of,
so it reports fully spent rather than `NaN` or `Infinity` — such an account is
already `blocked` and never reaches the balancer, but a comparison against
either of those picks the wrong account silently instead of failing. And an
**unmeasured account counts as empty**, so it is preferred inside its tier: that
is `standingOf`'s existing bargain, and it degrades correctly on a wall with no
readings at all, where every account ties at 0 and rank decides — which is the
strict waterfall, again.

`rank` keeps two jobs: the order inside a tier, and the tie-break when two
accounts in one are equally spent. It is also the panel's order within a band.
`ordered` is priority, then rank, then label, and `list_accounts` sorts the same
way so nothing re-sorts what Rust sent.

**A card swaps when it must, not when it could.** The tiers pick the account for
a card that is *starting* something — a new card, a dormant one waking, a held
one released. A card already mid-conversation on account two stays there while
account two is still allowed, even once account one has come back. This is not a
softening of the ordering: new work still always falls to the lowest available
tier, so the consumption order is unchanged. It exists because a swap has a
cost, below, and paying it to move a conversation back to an account it will
only have to leave again is paying it twice for nothing.

The consequence with tiers is worth naming rather than leaving to be discovered:
a card sitting on a priority-2 account **stays there while priority 1 has
room**. That is the existing rule rather than a new exception, and it is
bounded — the card is there because priority 1 was spent when it started, and
every new card meanwhile is going to priority 1. The alternative is paying the
full uncached re-read of a fifty-turn conversation to move it somewhere it is
not needed.

#### The migration is where this feature could have cost money

`migrate_v30` gives every existing account `priority = rank + 1`, so each lands
in a tier of its own and an upgraded wall spends exactly what it spent the day
before. **This is the one thing in the feature that cannot be got wrong.** An
`INTEGER NOT NULL DEFAULT 0` and nothing else would have put every account in
one shared tier — turning a reserve somebody was guarding into a pool and
spending it on the next turn, with nothing on screen having changed and nobody
having been asked. A schema change may not move money.

`rank + 1` rather than `rank` because the column is 1-based. It is the one
number in this subsystem a person says out loud and types into a field, and a
band headed "priority 0" is a band nobody asked for; `add_account` starts a
fresh registry at 1 for the same reason, so a migrated wall and a new one agree
what the first tier is called. The ordering is identical either way — `+ 1` is
monotone and injective.

The backfill is tied to **creating the column**, not to the column's value.
`add_column` is already a no-op the second time, but the `UPDATE` after it is
not, and a `WHERE priority = 1` guard only appears to help: it matches exactly
the rows somebody has since moved *into* the first tier, so re-running would
scatter the arrangement it was meant to protect. Asking whether the column was
there a moment ago answers the question actually being asked.

`test/accounts.test.ts` asserts a migrated three-account registry still chooses
in rank order, and asserts beside it what the pooled arrangement would have done
instead — so the reason the migration is written this way stays visible to
whoever reads it next.

#### And the panel had to be able to show a tier

A flat list with an ordinal down the left is the right drawing of a total order
and says nothing at all about a tier, so the panel is bands: one quiet header
per priority, the accounts under it. The header carries the two facts the rows
cannot show on their own — whether this tier shares its work, and what has to be
spent before it is touched at all. That sentence is `sayTier` and the grouping
is `tiers`, both in the pure module, so what a band *is* has one definition and
it is the one `choose` partitions by.

Drawn as furniture and nothing else, because colour is reserved for status: a
hairline in `--edge` out from the header to the right margin, and one rule down
the left of the rows to carry the band's extent. No fill and no border round the
group — the accounts already have boxes, and a box inside a box reads as two
things rather than as a heading over a list. **The cue doing most of the work is
proximity**: rows inside a band sit closer to each other than bands do to each
other. It costs no ink, which matters here because every other way of saying
"these belong together" is colour or weight and neither is available to
structure on this wall.

**The tier control is the number itself, typed.** A pair of move-me-a-band-over
arrows was the obvious alternative and is ambiguous exactly where it matters:
pressed on a band of two it means either "join the band below" or "make a new
band just under this one", and nothing about the gesture says which. The number
is what the user said out loud, reaches any arrangement in one press, and cannot
be misread. Blank leaves the account where it is — unlike a cap, where blank is
the real and different instruction "no ceiling", every account is in exactly one
tier and there is no such thing as none.

Up and down move an account *inside* its band and are disabled at its edges.
Across a boundary they would write two ranks and change nothing visible, since
the priorities still decide the order; a button that demonstrably does nothing
is worse than one not offered, so `waterfall.move` refuses it as well. The
ordinal down the left went with the flat list: in a shared band "1, 2" would
imply a sequence that is precisely what a tier does not have.

### What a swap costs

A swap is `close_conversation`, then `open_conversation` on the same session id
with a different credential store in the environment — which comes back up
`--resume`, because the transcript is on disk in a config directory both
accounts share. The card keeps its context, its scrollback and everything it had
read.

What it does not keep is the **prompt cache, which is per-account**. The first
turn after a swap re-reads the whole conversation uncached at full price. On a
card fifty turns deep that is the expensive kind of invisible, and it is why
the stickiness rule above exists, why the swap happens at a turn boundary
wherever possible, and why the transcript says so out loud when it happens. It
is also an argument, when the wall is busy, for letting a shallow card take the
swap and a deep one take the wait — which this does not currently automate, and
should not until somebody has watched it happen for a week.

### Two ceilings, and only one of them is yours

Every window the account is measured against (`limits.ts::Window` — `session`,
`weekly_all`, the scoped ones) can carry a **cap**: a percentage past which
Skein will not start new work on that account. Caps are per account and per
window kind, so "account one, never past 80% of the five-hour" and "account two,
never past 50% of the week" are both sayable, which is what they are for.

That is *your* ceiling, and it is the only one that is negotiable. The other is
the server's: a window at 100%, or wearing a `severity` of `rejected` or
`exceeded`, is an account that will refuse work whatever anybody here thinks.
The two are kept apart all the way to the face, because they mean opposite
things to the person reading it — one is a decision you made and can unmake, the
other is a fact you can only wait out. `blockedBy` returns which.

Caps clamp to 100 and default to none. A cap *above* 100 is not a cap, and is
read as none rather than honoured, so a slider dragged to the end cannot
accidentally mean "and past the real limit too".

**A cap is read by the usage widget too, and not only by the chooser.** The wide
allowance face draws one line per account and each line speaks with one window —
its five hours, unless the week has run out, which is `speaksWith`. What "run
out" means there is `blockersFor` and deliberately not a second copy of it: the
one thing that must never happen is a face reading a calm 60% on an account the
wall is refusing to send work to, and a cap of 60 makes that number calm by every
threshold either side of this knows. So the blocker travels to the face, the row
goes rust, and `sayCeiling` puts three words in the tooltip saying whose ceiling
it was. The bypass is *not* a parameter there — it belongs to a card, and a widget
reading an account is not one. `.claude/rules/usage.md` has the face's half.

### The bypass is per card, and it only moves your own ceiling

A card can be told to ignore the caps. It then measures every account against
the server's ceiling alone, through the same tiers in the same order — and a
bypass moves `spentOf`'s denominator too, so inside a tier a bypassed card
balances on the accounts' own percentages rather than on how much of *your*
ceiling each has used. That is the same substitution `capFor` makes everywhere
else, and it falls out of reading one function rather than two. This is the escape
hatch for the afternoon when the thing you are doing matters more than the
reserve you were keeping, and it is per conversation rather than global because
that is the granularity the decision actually has.

**A bypass cannot cross the server's ceiling**, because nothing can. A bypassed
card with every account genuinely spent is held exactly like an unbypassed one.
Anything else would be a promise this app is in no position to keep.

A card that is bypassing says so on its face for as long as it is. The rule is
`healNote`'s: Skein spawns with `--dangerously-skip-permissions`, and the one
thing an app like that owes you is that nothing it does on its own is invisible
afterwards. A card quietly spending a reserve you set aside is precisely that.

### Being held, and coming back

When no account is allowed to work, a send is **held** rather than failed. The
prompt is kept, the card says what it is waiting for and until when, and the
moment an account frees up it goes. Nothing is lost and nothing is silently
dropped.

`heldUntil` is the *earliest* moment any account comes back — the first door to
open, not the last — and it comes from the `resetsAt` of whichever windows are
doing the blocking. A window blocking with no named reset (a scoped window
nobody has touched genuinely reports none) makes the answer unknown rather than
infinite: the hold stands and the next allowance poll is what releases it. So a
hold has two ways out, a timer and a poll, and needs neither to be reliable.

**And a third, which is the wall opening again — because for a long time the hold
did not survive that at all.** `conv.held` was `$state` with no column behind it,
so closing Volery while cards were holding lost the prompt outright. They came
back **idle** rather than held; the 60s sweep is guarded by
`convs.some(c => c.held)`, so nothing ever retried them; the per-card timer had
died with the process. No fault, no note, no rust — the only trace was a
`pending` echo line from hours before, and the card looked entirely ordinary. Six
of them on the user's wall on 2026-08-27, reported as *"they were on a different
account, and they didn't automatically swap when an account freed up"*, which is
what it looks like from the outside and named the wrong mechanism: the swap works,
and there was nothing left to swap. Sink 10a2d3c5 diagnosed it as the wall never
acting on `availableAt`, which had not been true since v0.10.0; fad16c9c is the
real one.

`held_text`, `held_why` and `held_until` are `migrate_v27`. Three columns rather
than a JSON blob, deliberately against the `widget.config_json` bargain: that one
is right where the front end owns a shape that may change and a normalizer can
degrade it to something drawable, and here degrading means "no prompt held",
which is exactly the loss. **Written at `#hold`, not at shutdown** — the lesson
`store::set_mid_turn` paid for one file over: bookkeeping that records how far
something got must not be deferred to after the getting there, because code that
runs at exit is the code a crash skips. `#writeHold` is one function for both
edges so there is no way to write half of it, and it reads `conv.held` rather
than taking arguments, which makes "cleared it and then wrote the old text"
unsayable.

On load, `Skein` re-arms the precise timer from `held_until` and releases anything
already past *at once* rather than letting it wait out a sweep for a door that
opened while the app was shut. `#rearmHold` is shared with `#hold` for that
reason — the inline version was why a restored hold would have had no timer.

Escape on a held card drops the hold and the prompt with it, which is the same
gesture and the same meaning it already has on a card waiting to heal
(`skein.svelte.ts::stop`). A card waiting on your account's clock is a card
about to act on its own, and Escape aimed at one means don't.

**A held card is not a working one**, and for most of this feature's life the
wall said it was. `Conversation.echo` opens a turn from the *gesture* — a prompt
you sent is a turn beginning, which is the whole of why the transcript no longer
swallows what you typed while a card wakes (see `turns.md`). A prompt that never
left is not a turn beginning, and nothing on the hold path was giving it back:

- The card read celadon, `working`, for as long as the hold lasted — which
  against a five-hour window is five hours of the wall claiming a card was
  burning tokens while it sat doing nothing. `live`, the count of cards
  "actually burning tokens right now", counted it.
- Worse, `working` is the guard both `#heal` and `#nudge` check before they fire.
  So the two mechanisms that exist to get a stuck card moving were locked out by
  exactly the state that stuck it.

`echoHeld` gives the turn back. What it deliberately does **not** touch is the
line: it stays `pending`, because it is, and it stays `awaited`, because
`releaseHeld` sends this very text later and `--replay-user-messages` needs a
line to claim — clearing it would have Skein's own re-send draw your words a
second time, on the one path where Skein rather than you decides to send them.
`#forgetEchoes` learns the same exception: a stream closing says nothing about a
prompt that was never written to it. `echoResumed` takes the turn back at the
moment the hold releases, which is when the sending actually happens.

That `awaited` line is also why `unacknowledged` (`turns.md`) has to exclude a
held card. The two states look identical from the flag and mean opposite things:
one is a prompt lost in the CLI's queue and asking for a gesture, the other is a
prompt Skein is holding on purpose and will send itself.

In the tier a held card is **`rest`** — explicitly, rather than by falling
through to `urgencyFor`. It is not neglect, it is a card nothing you do will
move, and amber that persists for the four hours until a window turns over is
amber you learn to ignore. What it is doing, and the countdown to when it stops,
is on its face.

And the arm below the hold — every account switched off, or none signed in — is
a **failure**, which it was worded as and did not behave as. It set the face and
nothing else: the prompt was abandoned with no hold to release it and no timer
to try again, while the turn stayed open, so the card sat celadon and working
over a prompt that existed nowhere but in a line drawn as though it had been
sent. `echoFailed` is what says a send never left, and it is what that arm always
meant.

### The reactive half, and what is not probed about it

The proactive path above reads the allowance and decides before it sends. It
cannot be sufficient on its own: the poll is at best a minute old (`FLOOR_MS`),
a five-hour window can cross a cap inside that minute, and other machines may be
spending the same account. So a turn that comes back rate-limited swaps and
re-sends, through the existing heal machinery, as `HealKind: "limited"`.

Unlike the other two heal kinds this one does **not** wait — waiting is what the
other accounts are for. It marks the account spent on the server's word (which
outranks our last poll, being newer and being the actual refusal), picks the
next in the waterfall, and re-sends there. Where no account is left it becomes a
hold, which is the honest end of the ladder: the heal budget is not what bounds
this, the accounts are.

**A refusal outranks the reading, and without that the reactive half does not
work at all.** The turn fails, `choose` is asked what to do, and it hands back
the very account that just refused — because the reading it is looking at is up
to a minute old and still says 82%. So `waterfall.markSpent` records the
refusal and `next` overlays it: a distrusted account is presented as a window at
100% with `severity: rejected` and **no named reset**, which is the honest shape
of what a 429 tells us — it is full, and it did not say for how long. The hold
that follows therefore waits on the next poll rather than on a countdown
invented here.

The mark **expires** rather than being cleared by a poll, after five minutes.
Rust's floor means the next real reading is at most a minute out and will show
the account full on its own, so this only has to bridge that gap; if the account
genuinely is out for hours the poll keeps it blocked long after the mark has
lapsed, and if the 429 was a fluke the account quietly comes back. Nothing has
to remember to undo it, which is the property being bought.

**The account is settled before the card is woken**, and the order is
load-bearing: `#moveTo` ends the process to change the account, so settling
first means the wake spawns once, already on the right subscription. Settled
after, it would spawn on the old account and immediately kill what it had just
started.

**A hold has two ways out and needs neither to be reliable** — a timer aimed at
the first door to open, and a sweep every minute over any card that is holding.
The sweep is what covers a blocker that named no reset, where there is no
instant to aim a timer at. Escape drops a hold and the prompt with it, the same
gesture and meaning it already has on a card waiting to heal: a hold you
cancelled that fired anyway two hours later would be the worst of both.

#### And an agent went through it, and could not tell

Recorded because it is first-hand and there is not much of that here. On
2026-09-05 the card writing this feature hit its own session limit mid-task.
The wall marked the account spent, chose the next one and carried the
conversation on; the card found out because another card told it, and had
noticed nothing whatever from the inside — no gap it could see, no lost work, no
turn it had to repeat.

That is the design working, and it is also the argument for `swapNote` being
written into the transcript rather than only flashed on the face. **The thing
being swapped cannot observe the swap.** Nothing in an agent's own view
distinguishes "answered by the account you expected" from "answered by the
reserve you were keeping", so the only place that difference can live is a line
somebody can read afterwards. An app spawning with
`--dangerously-skip-permissions` owes that; this is the case where the party
with the most at stake is provably not in a position to check.

#### And then it was probed, and it had never once fired

**`wasRateLimited` was written from the API's documented shape, and the shape was
wrong.** The paragraph here used to say so and ask for the wording when somebody
hit a real limit. Somebody hit one — 38 refusals across eight sessions on this
machine between 2026-08-11 and 2026-08-21 — and the predicate matched none of
them, so everything in the section above had never run. What that looks like from
the wall is the sink item it was reported as: a card that stops mid-work, says
nothing about an account, and then refuses every prompt after it in under a
second until somebody moves it by hand.

The lesson is worth more than the fix. *A predicate written from a documented
shape rather than an observed one is a feature that has never been run, and it
will read as working right up until the day it is needed.* The two-signal care
in that predicate was real and well argued; it was guarding a door in the wrong
wall.

What actually arrives is not the API's `rate_limit_error`. The CLI catches the
429 and **composes its own sentence**, and that sentence is the whole of
`result.result`:

```text
You've hit your session limit · resets 9:10pm (Australia/Sydney)
You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)
```

From claude 2.1.235's own bundle, which builds it and names every window it can
name:

```js
function DYe(e, t, r, n) {              // e is the window, t the reset clause
  let o = n?.progressSavedSuffix ? " · progress saved" : "";
  return `You've hit your ${e}${t}${o}`
}
APt = { five_hour: "session limit", seven_day: "weekly limit",
        seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet limit",
        seven_day_overage_included: "Fable 5 limit",
        overage: "usage credit limit" }
```

So the match is on `hit your`, ahead of the window name, and that choice is the
whole of what stops this recurring: the *name* is a list that grows with every
plan tier — three more sit beside that table — and a predicate enumerating them
would go quiet again the next time one is added, in exactly the silent way this
one did. The CLI's own detector is the same shape, a `You've hit your` prefix
with no window names in it.

Two signals still, and the status gate is now known to be sound rather than
assumed: `api_error_status` is set from the message's own `apiErrorStatus` on
both of the bundle's `result` builders, and was `429` on all 38. So the observed
refusal passes it, and a sentence an agent merely quoted — an agent reading this
very file, say — cannot pass it without a 429 of its own. What is deliberately
*not* matched is `You've used` and `You're close to`, the same bundle's warning
strings for an allowance running low: a card that changed subscription on a
warning would leave the reserve for nothing.

The same probe settled the result event's shape, which is worth having written
down because it is counter-intuitive: a rate-limited turn arrives as
`subtype: "success"`, with `is_error: true` and `api_error_status: 429` beside
it. `endingFor` reads it correctly by testing all three, and a reader that
trusted `subtype` alone would call a refusal a clean turn.

#### The refusal was drawn twice, and so was the prompt

Two transcript bugs travelled with the one above, and both were reported as
"lines are sent multiple times". Neither is about accounts as such; both are
about a *swap* being the one moment when Skein ends a process it is in the middle
of sending through.

**The refusal itself, twice.** The CLI wraps an API error as an ordinary
`assistant` message — `model: "<synthetic>"`, one text block — so
`You've hit your weekly limit …` was pushed as agent speech, and then the
`result` behind it, whose `result` field is that same sentence copied out of that
same message, pushed it again as the turn's error line. The error line owns it
now and the assistant arm draws nothing: `ev.is_api_error_message` is a
wrapper-level sibling of `message` (the bundle's stream schema says so, and
spreads it onto the event beside `error` and `request_id`), and the result's
`is_error` is built straight from that flag — so a message carrying it is a turn
*certain* to end in `error` with this text as its detail, and dropping the speech
loses nothing. It is `localAnswer`'s rule from the other side.

**Your prompt, twice.** A swap is `close_conversation` then a resume, and
`#settleAccount` runs *ahead* of `send_prompt` — so the sequence is: your line is
echoed, the child is killed underneath it, the new child comes back, and
`--replay-user-messages` echoes your prompt to a card with nothing left awaited
to claim it. Second copy, drawn right under the swap note. `#forgetEchoes` grew
the `keepUnsent` arm for it, which is the *held* prompt's exception generalised
to what it always meant: **a prompt that was never written to this stream is not
a prompt this stream closing says anything about.** The test is `pending` rather
than `awaited`, and the two are not interchangeable — a line awaited but no
longer pending went down the wire and is owed only an echo that will never come,
where a line still pending when *we* pulled the process is one nothing carried.
Every retirement gets it, since `#recycle`'s repair-restart is the same situation
one subsystem over.

### Finding Claude Code before installing it

Every card is a `claude` child, so "claude is not on PATH" stops the whole wall
— and it is the failure most likely to be a lie. A per-user install that never
got a PATH entry, a GUI app launched from Explorer with a different environment
than the shell that installed it, a package manager's own bin directory: all
three look identical to `Command::new("claude")`, and none of them means the CLI
is absent. So `claude.rs` looks in every known home before it will admit to
missing, and `supervisor.rs` spawns the **path it found** rather than the bare
name — which is the fix for the off-PATH case on its own.

**`%LOCALAPPDATA%\AnthropicClaude\claude.exe` is the desktop app and is not the
CLI.** Probed 2026-08-19 on this machine: it answers `--version` with
`1.21459.3` where the CLI answers `2.1.235 (Claude Code)`. A discovery routine
trusting the filename would have spawned it for every card on the wall. So a
candidate is Claude Code only when it *says* it is — `verify` requires the words
`Claude Code` in the version string, and a bare version number is never enough,
because the wrong binary has one of those too. That directory is deliberately
absent from the search list as well, so a not-found message cannot send somebody
to reinstall the wrong product.

Installing is `https://claude.ai/install.ps1` (the Windows sibling of the
`install.sh` the CLI carries a reference to; both strings are in the binary).
**Nothing calls it automatically.** `find` coming up empty is a question to put
to somebody, not a licence to execute a script off the network — an app that
downloads and runs one because a lookup failed is an app that does it on a
typo'd PATH.

### Signing in, with no terminal

Signing an account in is `claude auth login --claudeai` with
`CLAUDE_SECURESTORAGE_CONFIG_DIR` set to that account's store, spawned by
`signin.rs` on **pipes** with no console at all. The CLI writes the credential
into the store itself, so no credential passes through Skein at any point and
there is nothing to paste in the ordinary case.

**This had a terminal, and the reason it had one was inherited rather than
measured.** `claude setup-token` — the command the previous design ran — is an
ink TUI: probed 2026-08-19, given pipes it emits nothing at all and never exits.
The obvious answer of a PTY is closed on this machine, ConPTY killing every
`openpty` child at `0xC0000142` (`servers.md` and `shell.md` both at length), so
a real console was the only way to run it. When the command changed to `auth
login`, the window came along with it unexamined.

`auth login` is not that command. Probed 2026-08-20 with pipes on all three
streams and no console:

```text
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
Paste code here if prompted >
```

— and it sits there alive, waiting on stdin. `process.stdout.write` and a
readline over stdin, not a rendered interface. There was nothing the terminal was
providing. *A constraint carried over from a sibling command is worth re-probing
when the command changes.*

The remaining obvious answer — Skein speaking the OAuth flow itself — stays
closed, and this is the one to keep closed. It means pinning a `client_id` that
is not ours against undocumented endpoints, and it breaks silently whenever any
of that moves. A sign-in is the last thing that should be reverse-engineered.

#### Two ways it finishes, and both are drawn

The flow opens the browser to a `http://localhost:<port>/callback` redirect and
runs a one-shot server for it, so the ordinary path completes with **no input at
all**: the browser comes back, the CLI writes the store, the process exits, and
`signin:done` is what the panel is waiting for.

The URL it *prints* is a different one — the manual redirect at
`platform.claude.com/oauth/code/callback` — and it is the fallback for a browser
that cannot reach localhost. That path ends in a `code#state` pasted back, which
the panel's field writes to the child's stdin. Both are handled because **the
printed URL is the visible one**: somebody following what is on screen ends up on
the manual path whether or not the automatic one would have worked on its own.

`codeFrom` in `signin.ts` accepts either the `code#state` the CLI asks for or the
whole callback URL out of the address bar, because the URL is the thing actually
to hand and the CLI answers it with a bare "Invalid code" and no hint as to why.
`looksLikeCode` is a hint beside the field and **never a block** — it is a guess
about a format somebody else defines, and a wrong guess must not be able to stop
a sign-in finishing.

#### The prompt is the one line with no newline on it

`Paste code here if prompted > ` is unterminated, and it is the piece of output
the whole fallback depends on. `servers::pump_lines` emits an unterminated
remainder only at EOF — which here is *after* the sign-in is over — so it would
hold that prompt back until it no longer mattered. `signin.rs` reads chunks
instead and accumulates the text; `signin.ts` matches against the whole of it.
Which is also what makes the matching robust: every pattern there is against
wording in somebody else's CLI, matched on the durable half of each sentence
(`oauth/authorize`, `paste`), and **the flow still works when all of it stops
matching** — the browser is opened by the CLI and the callback completes on
localhost without a word of it being read. What breaks is the fallback, not the
sign-in.

#### What must not be logged

That printed URL carries a live PKCE `code_challenge` and `state`. It goes to the
webview, because showing it is the entire point of the fallback, and it goes
nowhere else — no log, no snapshot, no database. The same rule `limits.rs`
follows for a credential, one step further out: **what is on screen for you to
act on is not the same as what is written down.**

**That the *writer* honours the variable was the one step that needed a browser
to check**, and it does: verified 2026-08-20 by signing in with the variable set,
after which the store held a credential and the global
`~/.claude/.credentials.json` was byte-identical. `tools/probe-store.ps1` is that
probe, kept because it is the check to re-run if a CLI update ever moves this.

### One account is not a choice

Everything this feature draws **on the wall** is gated on there being more than
one account that could actually take work — `several` in `accounts.ts`, counted
over `usable` (signed in, and switched on) rather than over the registry. That
covers the account beside a card's project name and the account knob on the
usage widget. With one account each of them is a word that never varies, and a
word that never varies is one nobody reads after the first day, taking room on a
line whose other facts do change. It is the same argument `menu.ts` makes about
offering nothing being a real answer.

Counted over `usable` and not the registry, so registering a second account you
have not signed into yet does not switch the whole wall into a mode it cannot
use.

Three things are deliberately **not** gated on it. The **accounts panel**, which
is where the second account gets set up and so has to show what is there however
little of it is. The **reading**: a single registered account is still the
account being spent, and may not be the one Claude Code is signed in as, so the
usage widget reads it even while declining to name it — the face gets more
accurate without getting busier. And the **waterfall itself**, which is
unconditional: with one account it simply always chooses that one.

The knob disappears by a general rule rather than a special case: a sourced knob
whose source resolves to nothing is not offered at all, because its literal
options alone are one entry, and a choice offering one thing is the
knob-that-does-nothing `widgets.ts` refuses everywhere else. What counts as a
choice stays in `accounts.ts::several`, and `widgets.ts` only knows that an empty
source means no knob.

### Where the pieces are

`accounts.ts` is pure and answers every question of *meaning* — is this account
allowed, which one is next, when does the wall come back, what is any of it
called. All of it is tested (`test/accounts.test.ts`), which is the same split
`limits.ts` draws against `limits.rs` and for the same reason: the policy is the
part that will be argued about, and an argument is worth having against tests.

`accounts.rs` holds the facts: the registry in SQLite, and where each account's
credential store is. It handles no secret — `supervisor.rs` names a store
directory to a child and `limits.rs` reads a credential out of one to ask the
allowance endpoint, and those are the only two places a credential figures at
all.

`signin.rs` is the sign-in that fills a store, kept apart from `accounts.rs`
because it is a *process* rather than a fact: a child, two reader threads, a job
object and a pipe somebody types into, none of which the registry has any
business holding. `signin.ts` beside it is the pure half, turning what that child
said into the four things a panel draws — and pure for the usual reason, that
matching against wording in somebody else's CLI is exactly the code worth having
tests for.

`waterfall.svelte.ts` is the reader the wall watches, on the
`ledger.svelte.ts` pattern — named for what the subsystem does rather than for
the module it serves, because `accounts.svelte.ts` does not survive contact with
Windows: `./accounts.svelte` resolves to the component `Accounts.svelte` on a
case-insensitive filesystem and `svelte-check` refuses two files differing only
in casing. That is the `usage.svelte.ts` trap `ledger.svelte.ts` is named
around, one degree worse — not an ambiguity resolved the wrong way but one that
cannot be resolved at all. `skein.svelte.ts` does the swapping and the holding,
because sending is a Rust call and a `Conversation` never makes one.

## Carrying a waterfall, and then carrying the sign-ins

Two documents, two carriers, and the difference between them is the whole of the
design.

**The waterfall** — the order, the ceilings, which rows are switched on — goes on
the **clipboard**, `theme.ts::exportThemes`'s precedent followed decision for
decision: a versioned wrapper (`{ skeinAccounts: 1, note, accounts: [...] }`), a
normalizer on the way in, three accepted paste shapes, and a rename rather than
an overwrite on a collision. It carries no credential, so every account in it
arrives unsigned, and both halves of the panel say so — `sayImported` at the
moment of the paste and `sayUnsigned` for as long as it stays true, which is
`sayUnmeasured`'s rule. `signedIn` is deliberately absent from the document
rather than merely unused: it is not a stored field, it is computed by looking
for a file on *this* machine, so writing it down would be a claim about a disk
the document is about to leave.

**The sign-ins** go in a **file**, `.volery-accounts.json`, and never on the
clipboard — Windows keeps a clipboard history and can sync it to another device,
which is the argument in one line. It is its own row in the panel and its own
suffix on disk, because a document you can paste into a chat and one holding
three live bearer tokens must not be the same artefact or the same gesture.

### What was given up to make it work, and what was kept

The absolute form of *Skein holds no credential* is gone. What replaced it is
three bounds, and they are the part worth keeping true:

- **The front end never sees a token.** Rust splices the credentials in on the
  way out and takes them straight back out on the way in; `Summary` — two
  timestamps and a plan name — is all that crosses into the webview. The webview
  is the part of this app that renders untrusted content, so this is worth a
  command rather than a convenience, and `a_summary_carries_no_token_at_all` is
  the assertion that holds it.
- **Nothing is installed without being asked for**, and *which* installs may
  skip the asking is policy in `accounts.ts::planSignins` rather than a rule in
  Rust or in the panel. Nothing signed in at that account, or a file whose
  credential is demonstrably newer, goes in on its own; older, identical or
  incomparable waits for a press.
- **What is parked is dropped.** `Carried` is emptied when the panel closes.

And the cost no code can remove, said in the panel before the file is written
rather than after: **the file is plaintext, and anyone who can read it can spend
those subscriptions until you sign out.** A passphrase was offered and a file was
chosen.

### The two rules that are different from the waterfall's, and why

**A colliding row that carries a sign-in is *matched*, not renamed.** The rename
rule is right about a configuration and wrong about a credential. Two rows called
`lyss` and `lyss-2` holding different caps is a disagreement worth being able to
see; two rows holding two credentials for the same subscription is nothing
anybody wants — one is stale, the wall spends whichever ranks first, and the fix
is a removal nobody was warned about. So a colliding credential-bearing row lands
on the row already here, changing nothing about that row's caps, rank or
switched-off-ness, and offering only its credential. That is the case this exists
to serve twice over: a refresh token rotates, the copy on the other machine goes
stale, and the fix is meant to be one file rather than a browser.

**Freshness is compared on the refresh stamp before the access stamp.** The
access token lapses in hours and refreshes itself, so a file copied this morning
is "older" by it within the day on a credential that is otherwise identical —
which would put a press in front of the one case the feature is for. The refresh
stamp is what decides whether a sign-in survives at all, so it is what decides
whether one file is newer than another.

### Does a refresh token rotate on use? Read the client, not the wire

**This is "carry a sign-in across once", and it should be documented as that.**
The question was open here for a long time and was framed as needing an
experiment — hash a refresh token, spend a turn on that account, hash again —
which meant it stayed open, because the experiment costs somebody's money and
invalidates the very credential it is asking about. It did not need one. Claude
Code's own OAuth code answers it, and reading the bundle is the technique this
repo already uses for questions about a service (`usage.md`'s `strings` on
`claude.exe`, `ask.md`'s tiering probe).

Read out of the 2.1.233 bundle, in the function that spends a refresh token:

```js
let a = { grant_type: "refresh_token", refresh_token: e, client_id: …, scope: … };
let l = await ri.post(TOKEN_URL, a, …);
let c = l.data, { access_token: u, refresh_token: d = e, expires_in: p } = c;
```

and in the function that saves the result:

```js
function lrd(e, t) { return {
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,                                   // ← no fallback
  expiresAt: t.expiresAt,
  refreshTokenExpiresAt: t.refreshTokenExpiresAt ?? e?.refreshTokenExpiresAt,
  subscriptionType: t.subscriptionType ?? e?.subscriptionType ?? null, … } }
```

Three things settle it, and the third is the one that is hard to argue with.

- **The response is destructured for a new `refresh_token`, and it replaces the
  stored one.** `refreshToken:` is the one field in `lrd` with no `?? e?.…`
  fallback, where the stamps and the plan all have one. The `= e` default in the
  destructure is the client tolerating a response that omits it, not the client
  expecting it to be absent.
- **A refresh token can be *dead*, and the client has a name for it.** On
  `invalid_grant` the CLI clears `refreshToken`, `accessToken` and `expiresAt` on
  disk and files `tengu_oauth_refresh_token_marked_dead_invalid_grant`; the
  "signed out" reading is literally `refreshToken === ""`. `invalid_grant` on a
  live token is what a *spent* one gets.
- **The save is a compare-and-swap against the token that was posted.** It writes
  only if the refresh token currently on disk is empty or still equal to the one
  this process spent; otherwise it takes the branch instrumented as
  `tengu_oauth_refresh_save_adopted_newer_write` /
  `tengu_oauth_refresh_compromised_cas_adopted_sibling` and keeps what is there.
  **Under a non-rotating deployment that branch is unreachable** — nothing could
  ever make the value on disk differ from the one you hold — and so is the lock
  around the refresh, which exists because spending the same token twice is
  harmful. Anthropic built, named and instrumented an entire mechanism for "a
  sibling refreshed and the token on disk is no longer the one I spent".

What that proves exactly: **the client is built on the premise that a refresh
token stops working because it was used.** It is not a direct observation of the
server returning a rotated token on a given call, and it does not need to be —
the export cannot rely on a deployment *not* rotating, and the client would treat
the loser as signed out if it ever did. So the honest documentation is the
conservative one, and it is now the one written above.

**The stamps are not the evidence, and they nearly were.** `refreshTokenExpiresAt`
falls back to the old value when the response carries no
`refresh_token_expires_in`, so it can sit still across a refresh — measured
2026-09-05 on this machine, where all three account stores refreshed within three
seconds of each other (each `expiresAt` is exactly its file's mtime plus eight
hours) and their `refreshTokenExpiresAt` were 12.0, 11.8 and 11.0 days out. Four
different expiries from one instant reads as "not re-issued, therefore not
rotated", and it is not that at all — it is one `??` in `lrd`. **A field that
falls back is not a field that stayed put.**

The empirical confirmation is still worth having and is now free rather than
costly, because the shape of the experiment inverts: **hash every store and wait,
rather than causing a refresh.** `bun tools/probe-rotation.ts` takes a reading and
compares it against the last one — the accounts on a working machine refresh
themselves roughly every eight hours, so the observation arrives on its own. A
digest that changed while the store was rewritten is rotation, seen; one that held
still across a rewrite is a refresh that did not rotate. It writes SHA-256 and
never a value, which is the same rule `limits.rs::source` and `accounts.rs::Summary`
keep.

Everything above is built so that the answer costs one file either way: a newer
credential installs itself, and `sayLife` says how long what you just imported has
left.
