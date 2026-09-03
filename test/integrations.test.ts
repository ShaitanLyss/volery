import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  INTEGRATIONS,
  UNASKED,
  VAULT_PREFIX,
  checkFailed,
  checkReading,
  integrationOf,
  type Check,
} from "../src/lib/integrations";

/* The table, and the one string in it that is not ours to change.
 *
 * Most of what is asserted here is bookkeeping, and it is the bookkeeping that
 * would actually cost something: a target that drifts from `vault.rs` is a
 * credential that silently disappears — the token stays on disk under a name
 * nothing looks up any more, so the app reads as having forgotten it while
 * Control Panel can still see it sitting there. */

describe("the vault targets", () => {
  test("azure devops' target is spelled exactly as it always was", () => {
    /* Written out as a literal rather than derived from anything, because this
       test's whole job is to be the thing a rename trips over. The user's real
       PAT is under this name. See `.claude/rules/integrations.md`. */
    expect(integrationOf("azdo")?.target).toBe("dev.skein.studio/azdo-pat");
  });

  test("every target sits under the one prefix", () => {
    /* The prefix is the durable identity, and it being shared is what makes
       `dev.skein.studio/*` in Credential Manager the honest answer to "what has
       this app got of mine". A row that wandered out of the namespace would be
       a credential nobody could find by looking. */
    for (const i of INTEGRATIONS) expect(i.target.startsWith(VAULT_PREFIX)).toBe(true);
  });

  test("no two rows share an id or a target", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    const targets = INTEGRATIONS.map((i) => i.target);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(targets).size).toBe(targets.length);
  });

  /* Read out of the Rust rather than imported, the same arrangement
     `chrome.test.ts` uses on `App.svelte`: `creds.rs` is the authority for
     which entry a service id resolves to, because that is the copy the vault
     actually sees, and this file quotes the strings only so the panel can show
     them. Two copies with nothing holding them together is the drift this test
     exists to make loud. */
  describe("held against the Rust that owns them", () => {
    const creds = readFileSync("src-tauri/src/creds.rs", "utf8");
    const vault = readFileSync("src-tauri/src/vault.rs", "utf8");

    test("every id in the table is a service Rust will answer for", () => {
      for (const i of INTEGRATIONS) expect(creds).toContain(`id: "${i.id}"`);
    });

    test("every target in the table is spelled the same way in Rust", () => {
      /* Either file — azdo's lives in `vault.rs`, since the credential ladder
         reads it with no front end involved, and the rest are declared beside
         the commands in `creds.rs`. What matters is that the byte string exists
         somewhere Rust will hand to `CredReadW`. */
      for (const i of INTEGRATIONS) {
        expect(creds.includes(i.target) || vault.includes(i.target)).toBe(true);
      }
    });

    test("Rust answers for no service the table does not offer", () => {
      /* The other direction, and the one that catches a half-finished
         integration: a row in `creds.rs` with no entry here is a credential you
         can store and never see, which is worse than one you cannot store. */
      const declared = [...creds.matchAll(/\bid: "([a-z]+)"/g)].map((m) => m[1]);
      expect(declared.length).toBeGreaterThan(0);
      for (const id of declared) expect(integrationOf(id)).not.toBeNull();
    });
  });
});

describe("the table is drawable", () => {
  test("every row says what it is for and where to get one", () => {
    /* The panel has no fallback prose. A row with an empty `mint` is a row that
       tells you to go and find a token with no hint where, which is the whole
       thing this table exists to carry. */
    for (const i of INTEGRATIONS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.why.length).toBeGreaterThan(0);
      expect(i.mint.length).toBeGreaterThan(0);
      expect(i.credential.length).toBeGreaterThan(0);
    }
  });

  test("the prose is lowercase, like the rest of the app's", () => {
    /* Not the mint path, which quotes menu items the service capitalises, and
       not the scope, which is a proper name (`Build (read)`) that has to match
       what is printed on the page you are looking at. */
    for (const i of INTEGRATIONS) {
      expect(i.label).toBe(i.label.toLowerCase());
      expect(i.why[0]).toBe(i.why[0].toLowerCase());
    }
  });

  test("an unknown id is null rather than a throw", () => {
    /* A widget config read off disk can name a service a later build dropped,
       and that is an ordinary thing to find rather than a paint to fail. */
    expect(integrationOf("bitbucket")).toBeNull();
    expect(integrationOf("")).toBeNull();
  });
});

describe("what a row says", () => {
  const good = (who: string): Check => ({ at: "good", who, when: 1 });
  const bad = (said: string): Check => ({ at: "bad", said, when: 1 });

  test("nothing stored, with a ladder behind it, is not a complaint", () => {
    /* Azure DevOps is the case: the git credential usually covers pull requests
       already, so an empty row here is a row you may never need to fill. */
    expect(checkReading(false, UNASKED, false)).toBe("nothing stored");
  });

  test("nothing stored, with nothing behind it, says why the widget is blank", () => {
    /* Asana is the case, and this is the reading that saves the support
       conversation: no CLI on this machine holds an Asana credential, so an
       empty row is not merely empty, it is the cause. */
    expect(checkReading(false, UNASKED, true)).toBe(
      "nothing stored — the widget has nothing to ask with",
    );
  });

  test("a token nobody has checked does not claim to work", () => {
    expect(checkReading(true, UNASKED, false)).toBe("stored — not checked");
  });

  test("a check in flight says so rather than showing the last answer", () => {
    expect(checkReading(true, { at: "asking" }, false)).toBe("checking…");
  });

  test("an accepted token names the identity it belongs to", () => {
    /* The useful half. A token minted as the wrong account is accepted and then
       sees none of your projects, which reads as an empty widget rather than as
       an error — the exact failure the Azure DevOps panel already warns about
       in prose, now answerable. */
    expect(checkReading(true, good("Lyss Delprat"), false)).toBe("accepted — Lyss Delprat");
  });

  test("a service that will not say who just says accepted", () => {
    expect(checkReading(true, good(""), false)).toBe("accepted");
  });

  test("a refusal is quoted in the service's own words", () => {
    expect(checkReading(true, bad("asana answered 401: Not Authorized"), true)).toBe(
      "asana answered 401: Not Authorized",
    );
  });

  test("removing a token does not leave a pass drawn beside an empty row", () => {
    /* `held` outranks the check, and this is the one reading here that could
       send somebody looking for a bug in the wrong place: a row that still says
       "accepted" after you pressed forget it. */
    expect(checkReading(false, good("Lyss Delprat"), false)).toBe("nothing stored");
    expect(checkReading(false, bad("401"), false)).toBe("nothing stored");
  });
});

describe("what counts as a fault", () => {
  test("only a refused token is drawn as failed", () => {
    /* Colour is status in this app, and not having a token is not a status
       anybody has earned. */
    expect(checkFailed(true, { at: "bad", said: "401", when: 1 })).toBe(true);
    expect(checkFailed(true, UNASKED)).toBe(false);
    expect(checkFailed(true, { at: "asking" })).toBe(false);
    expect(checkFailed(true, { at: "good", who: "", when: 1 })).toBe(false);
  });

  test("a refusal remembered against a token since removed is not a fault", () => {
    expect(checkFailed(false, { at: "bad", said: "401", when: 1 })).toBe(false);
  });
});
