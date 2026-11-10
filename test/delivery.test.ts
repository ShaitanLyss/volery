import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { KEPT_FOR_RENEWAL, turnStands } from "../src/lib/classify";

/* 2026-11-11, EOS coordinator `cf3ca26d`: the card scheduled a renewal, you
   typed a message in the three seconds after its turn ended, and the wall
   kept that message in the card's inbox (`renew.rs::hold`) — which is right.
   What was not right was that `send_prompt` answered `Ok(())` for it, so the
   front end drew a turn on words no model had. Nothing was ever going to
   close that turn, and the renewal's own timer declines to renew a card that
   looks busy: the card read `stopping…` for the life of the process, the
   message waited in an inbox nothing would drain, and neither Escape nor the
   dock's stop could do anything about either, because both write an interrupt
   and an interrupt at an idle process is answered with silence.

   The rule under this file is the half a pure test can hold. `supervisor.rs`
   is the half it cannot: `send_prompt` now answers `sent` or `held`, and an
   interrupt answers whether there was a turn to stop at all. */

describe("a prompt the wall took, and the turn it opens", () => {
  test("words that reached the process leave their turn standing", () => {
    expect(turnStands("sent", true)).toBe(true);
    /* And one added to a turn already running is that turn's, which had its
       own `result` coming either way. */
    expect(turnStands("sent", false)).toBe(true);
  });

  test("words the wall kept for a renewal take back the turn the gesture opened", () => {
    expect(turnStands("held", true)).toBe(false);
    /* A card with a renewal scheduled is idle by construction, so this is the
       only case that reaches the front end — but a turn the process was
       already in is not the gesture's to take back, and taking it would be the
       same lie in the other direction. */
    expect(turnStands("held", false)).toBe(true);
  });

  /* One value written in two languages, held together the way `handle.test.ts`
     holds the verb table to `act.rs`'s. The failure this guards is silent by
     construction: `how === "held"` on a spelling this end does not know is
     simply false, and the turn stands — the bug again, with a green suite. */
  test("supervisor.rs answers in the two words this end reads", () => {
    const src = readFileSync(join(import.meta.dir, "../src-tauri/src/supervisor.rs"), "utf8");
    const at = src.indexOf("pub enum Delivery");
    expect(at).toBeGreaterThan(0);
    const variants = [...src.slice(at, src.indexOf("}", at)).matchAll(/^\s{4}(\w+),$/gm)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(variants).toEqual(["sent", "held"]);
    /* The wire spelling is the rename, so it is asserted rather than assumed:
       dropping the `rename_all` would send `Sent`/`Held` and read as neither. */
    const serde = src.slice(src.lastIndexOf("#[derive", at), at);
    expect(serde).toContain('rename_all = "lowercase"');
  });

  /* And neither answer is dropped on the floor, which is the shape of the bug:
     the command used to answer the same thing for both, so there was nothing
     for the front end to read even if it had wanted to. */
  test("the front end reads both answers", () => {
    const skein = readFileSync(join(import.meta.dir, "../src/lib/skein.svelte.ts"), "utf8");
    expect(skein).toContain('invoke<Delivery>("send_prompt"');
    expect(skein).toContain('if (how === "held")');
    expect(skein).toContain("conv.keptForRenewal()");
    expect(skein).toContain('invoke<boolean>("interrupt_conversation"');
    expect(skein).toContain("conv.nothingWasRunning()");
    /* And the answer is not acted on while the turn is still only the
       gesture's: the process's mark cannot speak about a prompt that has not
       been written, and taking the turn back there would put the card at rest
       under a turn about to start (found in review). */
    expect(skein).toContain("!conv.openedByGesture");
  });

  test("the card says where the kept words are", () => {
    expect(KEPT_FOR_RENEWAL).toContain("renewal");
    /* Lowercase and quiet, like every other line on the wall. */
    expect(KEPT_FOR_RENEWAL).toBe(KEPT_FOR_RENEWAL.toLowerCase());
  });
});
