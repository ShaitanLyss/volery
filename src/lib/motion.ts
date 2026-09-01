/* How much the wall is allowed to move.
 *
 * Not a decoration knob — a GPU one, and the measurement is the whole reason it
 * exists. `Card.svelte`'s status glow used to animate `box-shadow`, which
 * Chromium cannot composite: every frame re-rastered the card's layer and
 * re-uploaded its texture. On the live wall that cost **+7.98% of the GPU 3D
 * engine per working card** — one card 13.3%, two 22.4%, three 28.3%, r=+0.677
 * regressed against the persisted mid-turn flag (`store.rs`'s `set_mid_turn`,
 * which is the only honest proxy for "how many cards are drawn `work`": a card
 * waiting on the API burns no CPU while still breathing, so agent CPU says
 * nothing about it).
 *
 * Moving the glow onto a pseudo-element and animating `opacity` takes the
 * re-raster away, and that is the whole of what `full` is. It is *not* the whole
 * of the cost, and the second half is the part worth knowing: on this GPU the
 * dominant term is the **present rate**, not the painted area. Any continuously
 * animating element makes the entire window present at display rate, so an 8px
 * dot cost as much as a card-sized glow. That is why there is no clever third
 * option — the only two levers that work are presenting less often and not
 * moving at all.
 *
 * Measured in isolation, twenty cards, same compositor (Edge 152 / WebView2
 * 151), against a still wall's 0.6%:
 *
 *   `box-shadow`, smooth — what shipped   13–18%
 *   full   opacity, smooth                12.2%
 *   spare  opacity, steps(8)               1.3%
 *   still  nothing moves                   0.6%
 *
 * Pure, so the vocabulary is testable without a browser. `motion.svelte.ts`
 * holds the one rune and writes the attribute every stylesheet reads.
 */

export type MotionId = "full" | "spare" | "still";

export type MotionMode = {
  id: MotionId;
  /** What the menu says. Lowercase and quiet, like everything else on the wall. */
  label: string;
  /** What it costs, in the units the bug was reported in. Not drawn anywhere
   *  yet — it is here so the number and the setting cannot drift apart. */
  cost: string;
};

/** The ring, in the order it cycles: most motion first, so `next` is always
 *  "quieter" and the gesture has a direction you can remember. */
export const MOTIONS: readonly MotionMode[] = [
  { id: "full", label: "full motion", cost: "12.2%" },
  { id: "spare", label: "less motion", cost: "1.3%" },
  { id: "still", label: "no motion", cost: "0.6%" },
] as const;

/** What a wall with nothing stored shows: the design as drawn. A preference
 *  about *this machine's* GPU is not something to assume on someone's behalf —
 *  see the note in `motion.svelte.ts` about where it is kept. */
export const FULL: MotionId = "full";

/** Normalized on the way in, the same bargain `themeFor` strikes: a key edited
 *  by hand, or written by a build that had a fourth mode, costs a session its
 *  motion setting rather than its start-up. */
export function motionFor(stored: unknown): MotionId {
  return MOTIONS.some((m) => m.id === stored) ? (stored as MotionId) : FULL;
}

export function motionAt(id: unknown): MotionMode {
  const want = motionFor(id);
  return MOTIONS.find((m) => m.id === want) ?? MOTIONS[0];
}

/** Round the ring, either way, wrapping at both ends. */
export function nextMotion(id: unknown, dir: number = 1): MotionId {
  const at = MOTIONS.findIndex((m) => m.id === motionFor(id));
  const step = dir < 0 ? -1 : 1;
  return MOTIONS[(at + step + MOTIONS.length) % MOTIONS.length].id;
}

/** Whether this setting lets anything move at all. The one question the styles
 *  ask that is not simply "which arm", and the one a future caller is most
 *  likely to want. */
export function moves(id: unknown): boolean {
  return motionFor(id) !== "still";
}
