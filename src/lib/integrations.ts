/* Every credential this app keeps, in one table.
 *
 * There was one — an Azure DevOps PAT — and the panel that took it was named,
 * worded and shaped for that one service. A second (Asana) made the shape the
 * question: two rows is not a pattern and three is, so the thing worth getting
 * right now is that the *third* integration costs one entry here and nothing
 * else. A service id, what to call it, where its token lives, what that service
 * calls the thing you paste, where to go and mint one, and how to check it
 * works. No component, no command, no migration.
 *
 * Pure — no runes, no `invoke`, no DOM — so the table and the readings over it
 * are tested directly (`test/integrations.test.ts`). `keyring.svelte.ts` owns
 * the wall's copy of what is held and what a check said, and `Keyring.svelte`
 * draws a row per entry.
 *
 * ## The target strings are not ours to change
 *
 * `target` is the name the *Windows credential vault* is keyed on, and a rename
 * does not migrate anything: the token stays on disk under a name nothing looks
 * up any more, and the app reads as having forgotten a credential you can still
 * see in Control Panel. Same hazard `identifier: "dev.skein.studio"` and the
 * `mcp__skein__*` tool names spend a section of CLAUDE.md on, and the same
 * answer — the vault keys off the *durable* identity rather than the visible
 * one, which is why `azdo-pat` still says `skein` after the rename to Volery.
 *
 * So these strings are quoted here for the panel to *show* — "here is where
 * your token is, go and delete it without my help" is the whole argument for
 * using Credential Manager at all — and the authority for them is `vault.rs`,
 * which is where the ladder reads one with no front end involved.
 * `test/integrations.test.ts` holds the two files against each other rather
 * than trusting either, because a target that drifts is a credential that
 * silently disappears.
 *
 * **Nothing here is passed to Rust.** The three vault commands take a *service
 * id*, and `creds.rs` maps it to a target of its own — so an unknown id is
 * refused and there is no version of this where the front end can name an
 * arbitrary entry in your vault and delete it. That is stricter than guarding a
 * prefix, and it costs nothing: the id is a word this table already has. */

/** The services, as an id the wire uses. A union rather than a string so a
 *  typo in a component is a build error rather than a command that answers
 *  "no such integration" at runtime. */
export type ServiceId = "azdo" | "asana";

export type Integration = {
  id: ServiceId;
  /** What the panel's row is headed. Lowercase, house style. */
  label: string;
  /** Where the token lives in the Windows credential vault. Shown, never sent —
   *  see the header. Must match `vault.rs`. */
  target: string;
  /** What that service calls the thing you paste. Azure DevOps says "personal
   *  access token", Asana says "personal access token" too but mints it
   *  somewhere entirely different; a third will say something else again, and
   *  the row should use the service's own word so the instructions match the
   *  page you are on. */
  credential: string;
  /** One sentence on what the wall does with it, in the present tense. */
  why: string;
  /** The path through that service's own UI to mint one. Written as the clicks,
   *  because a URL that has moved is worse than a breadcrumb that has not. */
  mint: string;
  /** The scope or permission that matters, if the service has scopes at all.
   *  Azure DevOps' is the whole reason its token exists — a code-scoped
   *  credential reads pull requests and gets a 401 on builds. */
  scope: string | null;
  /** Whether this token is the *only* credential for the service.
   *
   *  The difference is worth a field because it changes what a missing token
   *  means. Azure DevOps has a four-rung ladder (a git credential, an `az`
   *  sign-in, this, an environment variable), so nothing here is required and
   *  an empty row is not a fault. Asana has nothing else — no CLI on the
   *  machine holds an Asana credential — so an empty row there is the reason
   *  the widget is blank, and the panel should say so. */
  sole: boolean;
  /** The request a check makes, in the service's own words, or null where there
   *  is nothing cheap and unambiguous to ask.
   *
   *  This earns its keep for a reason that took a while to be obvious: a stored
   *  token that is *wrong* is indistinguishable from a missing one until
   *  something fails hours later, in a widget, in a voice that names the
   *  network rather than the credential. One unauthenticated-if-it-fails GET at
   *  the moment you paste turns that into an answer. */
  probe: string | null;
};

/** The prefix every target shares. Shaped like the urls Git Credential Manager
 *  uses for its own entries so ours sort beside them in Credential Manager, and
 *  keyed on the durable identity rather than the visible one. */
export const VAULT_PREFIX = "dev.skein.studio/";

/** The table. Order is the order the panel draws, most-used first. */
export const INTEGRATIONS: Integration[] = [
  {
    id: "azdo",
    label: "azure devops",
    /* Exactly this, forever. The user's real PAT is under this name right now.
       See the header, and `.claude/rules/integrations.md`. */
    target: "dev.skein.studio/azdo-pat",
    credential: "personal access token",
    why: "reads what is building and which pull requests want you",
    mint: "user settings → personal access tokens → new token",
    scope: "Build (read)",
    sole: false,
    probe: "GET /_apis/profile/profiles/me",
  },
  {
    id: "asana",
    label: "asana",
    target: "dev.skein.studio/asana-pat",
    credential: "personal access token",
    why: "draws a project's board, and moves a card between its columns",
    mint: "my settings → apps → manage developer apps → personal access tokens",
    /* Asana's PATs are not scoped at all — a token is the whole of what the
       account can do, which is worth *not* saying in a scope field, because a
       row that named one would read as though there were a narrower option. */
    scope: null,
    sole: true,
    probe: "GET /users/me",
  },
];

/** One row, or null. Null rather than a throw: the id can arrive from a widget
 *  config read off disk, where a service removed in a later build is an
 *  ordinary thing to find and not an error to fail a paint over. */
export function integrationOf(id: string): Integration | null {
  return INTEGRATIONS.find((i) => i.id === id) ?? null;
}

/** What a check of one row has last said.
 *
 *  Four states rather than a boolean and a string, because "not asked" and
 *  "asked and refused" are the two the panel most needs to keep apart — a row
 *  drawn as bad because nobody has checked it yet is a row telling you to go
 *  and mint a token you already have. */
export type Check =
  | { at: "unasked" }
  | { at: "asking" }
  /** `who` is whatever the service said the token belongs to, and may be empty
   *  if it would not say. Naming the identity is the useful half: a token from
   *  the wrong account is accepted and then sees none of your projects, which
   *  is the failure that reads as an empty widget rather than as an error. */
  | { at: "good"; who: string; when: number }
  /** `said` is the service's own words, quoted rather than reworded — the same
   *  bargain the pipelines fault line strikes, for the same reason: a second
   *  vocabulary is a second thing to keep true. */
  | { at: "bad"; said: string; when: number };

export const UNASKED: Check = { at: "unasked" };

/** The line drawn beside a row.
 *
 *  Pure, and the whole of the row's voice, so what the panel says in each of
 *  the eight states is a thing a test can read. Lowercase and quiet, per the
 *  house rule; the service's own words when it has any.
 *
 *  `held` comes first because it outranks the check: a token you have just
 *  removed cannot be "accepted" any more, whatever the last probe said, and
 *  drawing a stale pass beside an empty row is the one reading here that could
 *  send somebody looking for a bug in the wrong service. */
export function checkReading(held: boolean, check: Check, sole: boolean): string {
  if (!held) {
    /* The two halves of "nothing stored" are different facts. With a ladder
       behind it, an empty row is a row you may never need; with nothing behind
       it, an empty row is why the widget is blank. */
    return sole ? "nothing stored — the widget has nothing to ask with" : "nothing stored";
  }
  switch (check.at) {
    case "unasked":
      return "stored — not checked";
    case "asking":
      return "checking…";
    case "good":
      return check.who ? `accepted — ${check.who}` : "accepted";
    case "bad":
      return check.said;
  }
}

/** Whether a row's reading is a fault, for drawing it in the failed colour.
 *
 *  Apart from the reading rather than folded into it, because colour is status
 *  in this app and a status is a different question from a sentence — and
 *  because "nothing stored" is not a fault even when it is the reason nothing
 *  is drawn. Nobody has done anything wrong by not having a token. */
export function checkFailed(held: boolean, check: Check): boolean {
  return held && check.at === "bad";
}
