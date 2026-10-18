/* Finding a word in a conversation, as state a thread holds and a bar draws.
 *
 * The arithmetic is `hunt.ts`, pure and tested. This is the live half: whether
 * a find is open, what is typed, which match the cursor is on, and what that
 * makes lit. It lived in `Transcript.svelte` beside the column it lights, and it
 * is a class rather than staying there because the column moved into
 * `Thread.svelte` while the bar stayed where each reading puts it — the panel
 * floats it over its own column, and chat view will float it over its own
 * (`docs/chat-mode.md` §7.2). Two drawings of one find, and neither forks it:
 * the thread constructs this, lights its blocks from it and carries the view to
 * a match; `HuntBar.svelte` is the field.
 */

import type { Block } from "./transcript";
import { huntBlocks, huntCap, matchAt, stepTo, tally } from "./hunt";

export class Hunting {
  /** Whether the bar is up. */
  on = $state(false);
  query = $state("");
  /** Which match the cursor is on, counted across every block. */
  mark = $state(0);
  /** The field, bound by whoever draws it, so `open` can put the caret there. */
  field: HTMLInputElement | undefined = $state();

  #blocks: () => Block[] = () => [];
  #carry: () => void = () => {};

  /** `blocks` is everything the conversation shows, past and live, because
   *  "this transcript" is what a reader sees and the split into history and
   *  live is how it got there. `carry` takes the view to the match at `mark`. */
  constructor(blocks: () => Block[], carry: () => void) {
    this.#blocks = blocks;
    this.#carry = carry;
  }

  readonly found = $derived(this.on ? huntBlocks(this.#blocks(), this.query) : []);
  readonly matches = $derived(tally(this.found));
  readonly cap = $derived(huntCap(this.query, this.matches, this.mark));
  /** Which block keys carry a match — read in the markup, so a band is one
   *  lookup rather than a scan per block. */
  readonly lit = $derived(new Set(this.found.map((f) => f.key)));
  /** The block the cursor is in, for the brighter of the two bands. */
  readonly here = $derived(matchAt(this.found, this.mark)?.key ?? null);

  /** Open the bar, or put the caret back in it if it is already open — and
   *  select what is there, so a second Ctrl+F means "search for something
   *  else" rather than losing what you typed, which is what every find bar
   *  does. After the field exists: a frame is what the column already waits on. */
  open() {
    this.on = true;
    requestAnimationFrame(() => {
      this.field?.focus();
      this.field?.select();
    });
  }

  close() {
    this.on = false;
    this.query = "";
    this.mark = 0;
  }

  step(by: number) {
    if (this.matches === 0) return;
    this.mark = stepTo(this.matches, this.mark, by);
    this.#carry();
  }
}
