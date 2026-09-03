---
paths:
  - "src/lib/integrations.ts"
  - "src/lib/creds.svelte.ts"
  - "src/lib/Keyring.svelte"
  - "src-tauri/src/creds.rs"
  - "src-tauri/src/vault.rs"
  - "test/integrations.test.ts"
---

# Integration tokens: one panel, a table, and a string nobody may rename

#### Integration tokens

Volery reads a few things that are not on this machine, and each of them wants a credential
somebody went and minted. There was one — an Azure DevOps PAT — and everything above
`vault.rs` was named for it: three commands called `*_azdo_token`, a panel worded for one
service, a header button that said **azdo token**. A second service (Asana) made the shape
the question rather than the work.

**The vault was already general and the layer above it was missing.** `vault.rs` has taken an
explicit target since Spotify's refresh token wanted the same treatment — `store_at`,
`read_at`, `clear_at`, `held_at` — so a second credential costs a target string and a row in
a table, not a new credential layer. What it cost instead was `creds.rs` (the commands),
`integrations.ts` (the table) and `Keyring.svelte` drawing a row per entry. Noticing that
before writing any Rust is most of the lesson: **the thing that is specific to one service is
usually the presentation, and the mechanism underneath has usually already been generalised
by whatever came second.**

### `dev.skein.studio/azdo-pat` is not renameable

Same class of hazard `CLAUDE.md` spends a section on for `identifier: "dev.skein.studio"` and
the `mcp__skein__*` tool names, and the sharpest of the three, because it is somebody's
credential rather than their data.

The Windows credential vault is keyed on that exact string. **A rename does not migrate the
credential** — it leaves the token on disk under a name nothing looks up any more, so the app
reads as having forgotten it while Control Panel can still see it sitting there. There is no
error, no empty state that says why, and the person whose token it is has no reason to suspect
the app rather than the service. `vault.rs`'s header states the reasoning from the other end:
the target keys off the *durable* identity precisely so a visible rename cannot do this, which
is why it still says `skein` after the rename to Volery.

So the rule for a new integration is: **generalise the presentation and the plumbing, keep
every existing target string.** New ones join the same family — `dev.skein.studio/<service>-pat`,
Asana's being `dev.skein.studio/asana-pat`. `test/integrations.test.ts` asserts azdo's
spelling as a literal, which is a test whose whole job is to be the thing a rename trips over.
A migration is conceivable and is not a thing to do quietly: it is a question for the person
whose credential it is.

### The front end names a service, never a target

The obvious wire shape is a command that takes a vault target, guarded by a prefix. It was
rejected, and the reason generalises past this file.

`clear_at(target)` reachable from the front end with any string is a command that deletes
**any** Windows credential on the machine — Git Credential Manager's included. A
`dev.skein.studio/…` prefix check bounds the damage and is still a *guard*: something that
holds because it was remembered, in a file somebody will edit later.

So the wire vocabulary is a **service id** (`"azdo"`, `"asana"`) and `creds.rs` is the only
place that maps one to a target. An id it does not answer for is refused by name. That is not
a guard, it is an absence of the capability — and it costs nothing, because the id is a word
the table already has.

The consequence is two copies of each target string, which is exactly what the section above
says must not drift. They are held together rather than trusted: `integrations.ts` quotes them
so the panel can *show* you where your token is — "here is the entry, go and delete it without
my help" is the whole argument for using Credential Manager instead of a blob of our own — and
`test/integrations.test.ts` reads `creds.rs` and `vault.rs` off disk and asserts the two agree,
in both directions. A row in Rust with no entry in the table is a credential you can store and
never see, which is worse than one you cannot store.

### The table is the whole vocabulary

`src/lib/integrations.ts`, pure, tested directly, one entry per service: the id, what to call
it, the vault target, what *that service* calls the thing you paste, one sentence on what the
wall does with it, the path through its own UI to mint one, the scope that matters, and the
request a check makes. Same bargain `widgets.ts`'s catalogue strikes on the other side of the
wire, and the same test of whether it worked: **the third integration should be one entry and
no code.**

Two fields are less obvious than the rest and both earn their place by changing what the panel
*says*:

- **`sole`** — whether this token is the only credential for the service. Azure DevOps has a
  four-rung ladder behind it, so an empty row is a row you may never need to fill; Asana has
  nothing else, since no CLI on this machine holds an Asana credential, so an empty row there
  is *the reason the widget is blank*. Same absence, two different facts, and the second one
  saves the support conversation.
- **`scope`** — `null` where the service has no scopes at all. Asana's PATs are unscoped, and
  a row that named a scope anyway would read as though there were a narrower option to choose.

The readings over it (`checkReading`, `checkFailed`) are pure and are the whole of a row's
voice, so what the panel says in each of its eight states is a thing a test can read rather
than something you have to open the app to find out.

### Verifying is the part that earns its keep

**A stored token that is wrong is indistinguishable from a missing one** until something fails
hours later, in a widget, in a voice that names the network rather than the credential. So
every row has one cheap authenticated GET behind a *check it* button, and the answer sits
beside the row.

- **Pressed, and once automatically after a store.** That second one is the moment it is
  cheapest to act on: you are looking at the row with the page you minted the token on still
  open. Nowhere else, and never on a clock — the wall's standing rule is that a poller must be
  bounded by somebody watching, and the bound here is that there is no poller. A token you have
  not touched cannot have changed, and the one thing that *can* change it (revoked at the far
  end) is not something to discover on a timer against somebody else's server.
- **The probe is the scope that matters, not merely a live token**, and for Azure DevOps that
  decides the endpoint. `profiles/me` is the tidy org-less check and is the wrong one: it needs
  `vso.profile`, which a PAT scoped to **Build (read)** alone does not carry — so it would
  refuse exactly the token the row exists to take and report it as a bad credential. It asks
  `builds?$top=1` against an organisation on this wall instead. Where the wall has no Azure
  DevOps organisation on it, the row says so rather than guessing, which is the honest answer
  and not a fault. **A check that can be wrong in the reassuring direction is worse than no
  check; a check that is wrong in the alarming direction sends people to re-mint a token that
  was fine.**
- **It names the identity.** `GET /users/me` answers with the account, and that is both halves
  of the check at once: a token minted as the wrong person is *accepted* and then sees none of
  your projects, which reads as an empty widget rather than as an error. The panel has warned
  about that in prose for weeks; naming the account is the version of the warning that can be
  acted on.
- **A refusal is quoted in the service's own words.** Same bargain the pipelines fault line
  strikes, for the same reason: a second vocabulary for one fact is a second thing to keep
  true. `trailing` reads the two error shapes it knows (`{"message": …}` and
  `{"errors":[{"message": …}]}`) and gives up quietly otherwise, because under a TLS-intercepting
  proxy both services answer with a page of HTML, and a status code alone is a short true
  sentence where a thousand characters of markup beside it is not a longer one.
- **`held` outranks the verdict.** A row that still says *accepted* after you pressed **forget
  it** is the one reading here that could send somebody looking for a bug in the wrong
  service. Guarded twice on purpose: `checkReading` ignores a stale verdict when nothing is
  stored, and `forget` clears the verdict as it clears the token.
- **Colour is status and not having a token is not one.** `checkFailed` is a separate
  question from `checkReading` for that reason — nobody has done anything wrong by not having
  a credential.

### Where the state lives, and one Windows filename trap

`creds.svelte.ts` owns the wall's copy: four records keyed by service id (held, check, busy,
fault) and no per-service code at all. `held` is a *reading of the vault*, asked when the
panel opens and after every write, never cached — Credential Manager is reachable without us,
which is the whole reason `vault.rs` chose it, so a remembered boolean is stale in the one
direction that matters.

`DevOps.held` is a getter over an injected seam (`devops.token`) rather than a field of its
own, so the vault is read in exactly one place and it is the panel's. The connection still
needs the boolean — "the pipelines half is faulting" and "the pipelines half is faulting and
there is no token to fall back on" are different states of the app and only one is a bug — and
`snapshot.azdo.token` keeps its name so a wall test need not know the panel moved.

The store is `creds.svelte.ts` rather than `keyring.svelte.ts`, and that is not taste:
`keyring.svelte.ts` beside `Keyring.svelte` is two paths differing in case alone, which
TypeScript on Windows reads as one file included twice and refuses to compile. Naming it after
`creds.rs` — the file on the other side of the wire — was the fix and is the better name
anyway.

### The one service-specific thing left in the panel

Azure DevOps' quoted fault line, and it is specific for a reason no table column could carry:
**it is the only integration whose stored token is one rung of a ladder** rather than the whole
credential. So the widget's own fault says something no probe can — *which rung was refused* —
and that is worth showing next to the row where you would fix it. Anything else that ever
grows a ladder gets the same treatment. Nothing else has one, and if a second ever does, that
is the moment the exception becomes a field.
