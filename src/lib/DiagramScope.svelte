<script lang="ts">
  /* Whose words the prose inside this is, for the one thing that needs to know:
   * a ```mermaid fence mermaid refused is reported back to the card that wrote
   * it, and telling the wrong card is worse than not telling anyone (`hooks.md`
   * would have it say *a fence you wrote*, which it did not).
   *
   * The thread draws two kinds of prose that are not the reading card's: a
   * relay letter, which is another card's words, and your own prompt, which is
   * yours. A fence in either is not this card's to be told about, so both are
   * wrapped here and draw with no author at all. Ten lines rather than a prop,
   * for `FileScope.svelte`'s reason: a prop is something every call site has to
   * remember, and this is something a wrapped block cannot get wrong.
   */
  import type { Snippet } from "svelte";
  import { scopeDiagramAuthor } from "./drawing.svelte";

  let { of = null, children }: { of?: string | null; children: Snippet } = $props();

  /* A getter rather than the value, so a block redrawn under a changed prop
     re-resolves instead of holding the one it was made with. */
  scopeDiagramAuthor(() => of);
</script>

{@render children()}
