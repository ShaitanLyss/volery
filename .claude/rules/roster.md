---
paths:
  - "src/lib/roster.ts"
  - "src/lib/Roster.svelte"
  - "src/lib/rosters.svelte.ts"
  - "src-tauri/src/mcp.rs"
---

# A roster: something else's work, drawn on this wall

#### A roster: something else's work, drawn on this wall

The wall already draws two things it does not own — `pipelines` and `reviews`, off Azure
DevOps. Both are hard-wired: `azdo.rs` knows the endpoints, `azdo.ts` knows the vocabulary,
and a second forge would grow a second pair of files. That is affordable for a product every
Volery user could plausibly have. It is **not** affordable for one company's internal ticket
system, and the request that produced this rule was exactly that — RISE, which exists at one
employer and nowhere else.

So a roster is the shape that lets the wall draw something Volery has never heard of: **one
widget kind, one contract, and no name in this repository belonging to anyone's product.**

## What was already true, and what this is therefore not for

Volery passes `--strict-mcp-config` in exactly one place — `chat_argv`. A **project** card is
spawned with `--mcp-config` carrying the skein server and nothing else, and the CLI's own help
is explicit that strict means *only* the passed config; without it, every other MCP
configuration is loaded too. Confirmed 2026-08-25 by opening a card on a repo whose `.mcp.json`
registers a server and asking `/mcp`: it was there.

**A card already reaches whatever its own repository configures.** This feature does not make
that work and must not be justified by it. What a wall-level registry buys is three narrower
things, and each is a real gap:

- **Chat cards.** Strict, so a repo's config never reaches one. The registry is the only route.
- **Cards in another tree.** A `.mcp.json` is cwd-bound, and a nova card asking whether a
  problem has been reported before is asking about a system nova's repo has no entry for.
- **One place both halves read.** The widget and the cards resolve the same server, which is
  what makes a drawn row something you can hand to an agent (see *the ref*, below).

## The contract, and where the coupling sits

A server offers rows by publishing an MCP **resource** whose `mimeType` is
`application/vnd.volery.rows+json`. Volery calls `resources/list`, keeps what it recognises,
and offers those as a widget's subject. A server implementing none of it offers nothing, and
nothing here has to know why.

```json
{ "id": "4821",
  "title": "SDP import fails on a reissued asset tag",
  "subtitle": "Data and Transformation - RISE - 3d",
  "tier": "soft",
  "badge": "P2",
  "href": "https://.../tickets/4821",
  "ref": "ticket:4821" }
```

**A resource rather than a tool call, and the distinction is the whole reliability of this.**
A tool result is `content: [{ type: "text" }]`, and its shape is free to change whenever it
reads better to a model — which is the correct property for a tool and precisely the wrong one
for something a widget parses. A resource carries a uri and a mimeType and is data for the
client. That mimeType **is** the handshake; nothing else negotiates.

**Resources take no arguments, so scope is a template.** `.../roster/{scope}` via
`resources/templates/list`, and the template parameter is what the widget's *showing* knob
reaches through — the same knob `pipelines` and `reviews` each carry.

**`tier` is the only vocabulary Volery exports, and the direction is deliberately the opposite
of `azdo.ts`.** There, a build status is mapped onto `Tier` *inside* Volery, because Volery
owns the taxonomy and knows what a failed stage means. Here it cannot: nothing in this
repository can know what a RISE P2 is worth. So the server maps its own statuses to the wall's
five (`work` `ask` `soft` `rest` `fail`), and that enum is the entire published surface. Every
other field is free text.

That is what keeps a roster a **drawn instrument** rather than a table somebody configured.
Colour on this wall means urgency and means the same thing in every direction you look; a
widget that let a feed choose its own colours would be the first thing here to break that, and
the standing rule about decorative colour would have nothing left to stand on.

**Row order is the server's, and Volery does not re-sort.** Decided 2026-08-28, before the code
exists, which is the right way round — sink e2cb0a2d raised it while the RISE half was being
built and it would have been settled by accident otherwise.

The argument is the one `tier` already makes, one step further. RISE returns rows ordered
`fail, ask, soft, work, rest`, which is deliberately **not** `azdo.ts`'s `WEIGHT`
(`ask, fail, work, soft, rest`) — two rungs differ, and RISE's reasoning is specific to what it
publishes: for a ticket the question is "does this need me to act", so one in motion is the one
nobody need look at, and `soft` (neglected) therefore outranks `work` (moving). That reasoning
is right for tickets and would be wrong for pipeline runs. Which is the point: **the ordering
is domain knowledge the publishing server has and this repository does not** — the same reason
nothing here can know what a P2 is worth.

So the array order in the resource *is* the display order. Consequences worth stating, because
each is a thing somebody will otherwise be tempted to add:

- **Nothing is added to the contract.** No `weight`, no `rank`, no per-row number. A published
  weight would be a second way to say the same thing and the two would disagree the first time
  a server sorted its own array differently from the numbers it stamped on it. Order is already
  a total ordering and JSON arrays already carry it.
- **`azdo.ts`'s `WEIGHT` stays where it is and does not become shared.** It is Volery sorting
  *Volery's own* readings, which it owns the taxonomy for. Exporting it would be exporting a
  ranking of tickets nobody here has ever seen.
- **`Roster.svelte` must therefore not sort, group or stable-sort by tier** — and this is the
  line most likely to be crossed by somebody being helpful, because grouping a mixed list by
  colour looks like an improvement right up until it silently overrules the server's judgement
  about which of two rows matters more. The widget's own knobs may still *filter* (a `showing`
  scope reaches through the template) and may cap length; neither reorders what is left.
- **A server with no opinion gets what it asked for.** Publishing in whatever order its
  database returned is a choice too, and drawing that faithfully is the honest answer to a feed
  that did not think about it — better than Volery inventing a ranking and making it look
  considered.

**`ref` is a string the same server understands**, and it is why this is not a read-only pane.
A row can be handed to a card, and what lands in the dock is a prompt naming the ticket for
tools the card already has — because the registry entry that fed the widget is the entry that
was injected into the card. Neither half gives you that alone.

## One kind, not one per fact

`azdo.md` argues pipelines and reviews are two widgets rather than one with a variant, on two
tests: a variant means a different *reading of the same fact*, and you want both up at once.
Ticket queues, approval queues and an asset register are different facts by that test, so it
looks like it demands a kind apiece.

It does not, and the reason is the decisive clause rather than the premise: **a variant is
exclusive.** `subject` is not a variant — it is per-instance config, so two rosters showing
different subjects stand on the wall together and nothing is lost. The test was never "are
these different facts", it was "does picking one cost you the other", and here it does not.
A kind per fact would mean Volery growing a widget kind for every resource somebody else's
server publishes, which is the thing this design exists to avoid.

## What the registry row is

```
mcp_server: id, name, transport(stdio|http), command, args_json, cwd,
            env_json, url, enabled, reach(wall|projects), projects_json
```

- **`reach`, because injecting a server into every card is a context tax on every card that
  will never ask.** Per-project opt-in is one column, not a feature.
- **`cwd` and args are absolute, and the registry owns them rather than the card.** The entry
  this was designed against reads `bun --env-file=apps/backend/.env.local apps/mcp/src/index.ts`
  — relative, resolving only from that repo's root. A chat card has no project and no cwd at
  all, so an entry that depended on the card's would work everywhere except the one place the
  registry was built for.
- **No secret in that table.** `store.rs` is an unencrypted SQLite file that `portage.rs`
  exports layouts out of; the argument at the top of `vault.rs` applies unchanged. A registry
  secret lives at `dev.skein.studio/mcp/<name>` and `env_json` names the variable to inject it
  as. Same vault, same Keyring shape, same reason.

## The two standing rules this lands on

- **A stdio server is a spawn, so it goes in a `jobs::Job`.** It is a child that spawns
  children (a `bun`, a `node`, whatever the entry point starts), and `child.kill()` reaches
  exactly one process. This is the case that rule was written for.
- **It does not get a timer.** A ticket queue emits no event, which would make it the fourth
  thing on this wall that goes and looks — and CLAUDE.md says the fourth owes an argument.
  It owes the *update check's* argument, not the sampler's: `attention.focused` is already an
  event, a queue is worth reading exactly when you come back to the window, and the residue is
  bounded by a floor. Not a clock.

## Chat cards: what the promise becomes

`chat_argv`'s comment says a chat card can reach nothing on this machine. With a registry that
becomes false as written and true as restated: the strict flag stays **on**, and the config it
is strict against has more than one server in it. A chat card can reach *what you registered
on this wall* — still not the repo's config, still not your global one, still no filesystem and
no shell. That restatement belongs in `chat.md` and in that comment, not left to be discovered.

The registry is therefore also the one place a capability is widened, which is the right number
of places for it to be.

## Still open

- **Writes.** RISE's server carries write tools and a project card is spawned
  `--dangerously-skip-permissions`, so a broadcast can write to a ticket system with no prompt.
  Decided 2026-08-25 to leave them open — a `rise_...` API token carries its owner's roles
  (`api-token-roles.ts`) and that is the bound. Note what that means: there is no read-only
  token to hand the wall, so if the bound ever needs to be tighter it is a change at the server,
  not a flag here.
- **Where a row goes when you click it.** `href` opens a browser, which is the obvious answer
  and the least interesting one. The `ref` route — dropping it on a card — is the reason the
  field exists and is unbuilt.
- ~~**Who owns row order.**~~ Settled 2026-08-28: the server's, and Volery does not re-sort.
  See "Row order is the server's" above.
