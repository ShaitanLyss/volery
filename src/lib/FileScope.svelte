<script lang="ts">
  /* Which directory the prose inside this counts from.
   *
   * `scopeFiles` is a component-level call, so a surface that draws *one*
   * card's words says it once in its own script and is done. This is for the
   * other shape: a list where each row belongs to a different card, which the
   * away pile is — a morning's questions from five projects, stacked. A single
   * scope around that list would be right for at most one of them.
   *
   * Ten lines rather than a prop, for the reason the whole arrangement exists:
   * a prop is something every row has to remember to pass on, and this is
   * something a row cannot get wrong once it is wrapped. See the note over
   * `scopeFiles` in `paths.svelte.ts`.
   */

  import type { Snippet } from "svelte";
  import { scopeFiles } from "./paths.svelte";

  let { root, children }: { root: string | null; children: Snippet } = $props();

  /* The closure reads the prop rather than a copy of it, so a row whose card
     changes under it re-resolves instead of pointing at the old project. */
  scopeFiles(() => root);
</script>

{@render children()}
