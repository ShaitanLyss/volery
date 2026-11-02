import type { WallHold } from "./waiting";

/** Every account spent, as the wall last told Rust (`Skein.#noteAllowance`).
 *
 *  A rune module of its own because two things read it that have no business
 *  importing each other: a card's `waiting` reading, which must not call a
 *  wake "late" while the wall is the thing holding it (`admit.rs`), and
 *  `Skein`, which writes it. `Conversation` never talks to Rust, so it reads
 *  this rather than asking the waterfall. */
export const wallHold = $state<{ now: WallHold }>({ now: null });
