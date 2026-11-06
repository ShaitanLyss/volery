# How this round works (read before anything else)

<!-- Template from Volery's coordinate skill. Copy it into the repo (for example
     .claude/coordinator/brief-common.md), fill the <angle brackets>, cut what does not
     apply, and add the repo's own rules. Each worker brief then says "read brief-common.md
     first" plus its own items, never a pasted copy. Rules true of every card in the repo,
     coordinated or not, belong in the territory's standing instructions or CLAUDE.md
     instead: every card is handed those. -->

You are a worker card, opened by the coordinator named in your opening prompt. Volery has already told you the shared-tree git rules, your coordinator's handle, and, if you are in a worktree group, your branch. This file is what is specific to this round.

**<Captain> decides the design.** An item is a hint about a problem, not a spec. Find what the person is actually unhappy about and fix that by design rather than with a one-off. Anything that changes behaviour or what users see waits for <captain>'s decision; only plainly broken behaviour with one obvious fix goes ahead without asking.

**Ask <captain> directly**, never through the coordinator: `mcp__skein__ask_user`, one entry per decision, options with your recommendation first, `preview` or `file` for anything visual. Open every question with the item id, who asked, their words quoted exactly, and any images; then what you observed; then the question. Put several questions in one call, and carry on with the rest of your slice while you wait.

**Read the item's comments before you build.** A ruling in your brief that restates the asker's own proposed fix is the asker's idea, not the captain's. Where the captain has commented on the item, that comment wins over the brief; tell the coordinator the brief was wrong.

**Making the data a check needs.** <Which database is safe to write test data to, how to act as another user, the seed scripts.> Name what you create so it can be found (`ZZ-<your handle> ...`) and invent the people in it.

**In the shared tree:**
- Never commit or push. The coordinator commits by explicit path and pushes.
- Keep the tree runnable at every save. The captain may be reviewing against it live. Change an export and every caller in the same step.
- Never start dev servers. The wall runs them; read them with `mcp__skein__server_log`.
- Never edit a `CLAUDE.md` or a rules file. Put doc notes in your report; the coordinator applies them once per batch.
- Stay in your files. A fix that needs a file another card owns is a report back, not an edit.

**In a worktree group:**
- Install dependencies once first (<the install command, and anything it provisions>). The tree starts cold.
- Commit on your branch in small, coherent commits with explicit paths. Never push and never merge: the coordinator rebases, gates and pushes. Cards sharing your key share your tree.
- The wall's dev servers serve the shared tree, not yours. Prove the work with scoped tests and scripts. If it has UI, say so: the live pass happens after it lands.

**Checks are scoped, never the full suite.** Sibling cards are mid-edit, so a repo-wide run is red for reasons that are not yours, and every card running one burns the machine's CPU for nothing. Run the tests for what you changed (<scoped test command>) and typecheck what you touched (<typecheck command>). The coordinator runs the full gate once per batch.

**Before reporting a non-trivial change done:**
- An adversarial review: the `volery:red-team` agent on your diff. Fix what it finds or say why not.
- UI: verify every interaction you touched in the wall's browser, in a tab of your own (or with the `volery:verifier` agent). Opens, stays open, closes only when it should; light and dark; the widths that matter here; loading, empty and error states. Screenshots under `<shots dir>/<your handle>/`.
- Never sign out of the browser or clear its cookies.

**When an item is done and verified:** mark it built in the review tool with a short, human "how" (what the user sees now, and where) and a screenshot, then `mcp__skein__send` the coordinator: item ids, the exact files you changed, the checks run and their results, the review verdict, what you verified live, doc notes, and anything not verified, said as such.
