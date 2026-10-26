/* Where a card's browser calls may read and write files.
 *
 * Playwright's MCP checks every file a tool names — a screenshot's
 * `filename`, a snapshot or console log saved to disk, `paths` to upload, a
 * script or storage state to load — against two roots: the client's `cwd` and
 * its output folder (`<cwd>/.playwright-mcp`). The host hands it the card's
 * launch directory as that `cwd`, once, when the card's first call builds its
 * backend.
 *
 * Cards work in git worktrees beside the checkout they were launched in, and
 * make them whenever they like — long after that first call. So a card in
 * `nova-hop` (a worktree of `nova`, launched in `nova`) could not save a
 * screenshot where it works: "outside allowed roots", and its evidence went
 * into a checkout other cards own, where its own git could not see it. And a
 * *relative* filename resolved against the launch directory, so a card
 * working in `rise-r1` silently wrote into `rise` — the tree it had been told
 * never to touch (sinks ac92fe93, c6683061).
 *
 * The roots are therefore the launch directory **and the same directory in
 * every worktree of its repository**, read from `git worktree list` on every
 * call that names a file, so a worktree made a minute ago counts. Nothing in
 * a call widens them: the bound is what its own repository already holds. A
 * card launched in `repo/sub` gets `<worktree>/sub` in each worktree, never a
 * whole worktree above where it was put. The bound is against accidents, not
 * a security boundary — `browser_run_code_unsafe` runs any script inside the
 * host, and a card can always write a file with its own tools.
 *
 * Which root a call runs under is decided here and then *enforced by
 * Playwright*: the host runs the call with its workspace set to that root
 * (`browserhost.cjs`, `workspace`), so Playwright's own check — and its
 * resolution of anything this file does not know about — is about that root.
 * A tool this file has never heard of still gets the launch directory, as
 * before. Paths are matched here the way that check matches them, with links
 * resolved, so a junction or a subst drive does not make the two disagree.
 *
 * A relative name is the one thing with no honest answer: the host cannot see
 * which tree a card is working in (the CLI reports the launch directory on
 * every record, whatever the card has `cd`'d into). It resolves against the
 * launch directory, as it always did, **except** where that is a guess —
 * a card launched in the main checkout of a repository that has worktrees
 * beside it, or one where git did not answer. There it is refused, naming the
 * trees, and the card passes an absolute path. A card launched in a linked
 * worktree (one Volery made for it) works where it was put, and its relative
 * names resolve there.
 *
 * Pure: the host runs git and hands the answers in. `test/browserroots.test.ts`.
 */
"use strict";

const path = require("path");

/** The argument names Playwright's tools take a file path under (0.0.83):
 *  `filename` on every save and load, `paths` on upload and drop. */
function named(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  if (typeof args.filename === "string" && args.filename.trim()) out.push(args.filename);
  if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string" && p.trim()) out.push(p);
  return out;
}

/** Every entry of `git worktree list --porcelain`, main first, with whether
 *  git marks it `bare` (no tree to write in) or `prunable` (its folder, or its
 *  link back to the repository, has gone). */
function parseWorktrees(porcelain) {
  const out = [];
  for (const line of String(porcelain || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) out.push({ path: line.slice("worktree ".length), bare: false, prunable: false });
    else if (!out.length) continue;
    else if (line === "bare") out[out.length - 1].bare = true;
    else if (line === "prunable" || line.startsWith("prunable ")) out[out.length - 1].prunable = true;
  }
  return out;
}

/** Windows paths compare without case (`path` *is* `path.win32` there). */
function sameish(P, a, b) {
  return P === path.win32 ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `file` is `root` or under it. Both already resolved. A name that
 *  merely begins with two dots (`..cache`) is inside. */
function inside(P, root, file) {
  if (sameish(P, root, file)) return true;
  const rel = P.relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(".." + P.sep) && !P.isAbsolute(rel);
}

/** A path with every link on it resolved, as Playwright's own check does
 *  (`resolveSymlinks`) — for a file not yet written, its nearest existing
 *  folder resolved and the rest kept. `realpath` throws for what is not
 *  there; leaving it out compares the text. */
function nearestReal(p, realpath, P = path) {
  const abs = P.resolve(p);
  if (!realpath) return abs;
  let at = abs;
  const rest = [];
  for (;;) {
    try {
      return P.join(realpath(at), ...rest);
    } catch {
      const up = P.dirname(at);
      if (up === at) return abs;
      rest.unshift(P.basename(at));
      at = up;
    }
  }
}

const textOnly = (P) => (p) => P.resolve(p);

/**
 * The directories a card may name files under, launch first.
 *
 * `launch` is where the card was started; `top` is the top of the worktree
 * that holds it (`git rev-parse --show-toplevel`, which answers with links
 * resolved), or empty when it is not in a repository; `worktrees` is every
 * usable worktree of that repository. Where the card was launched below its
 * tree's top, each worktree contributes the same subdirectory — the bound is
 * parallel to where the card was put.
 */
function cardRoots({ launch, top, worktrees }, P = path, real = textOnly(P)) {
  const home = P.resolve(launch);
  const roots = [home];
  if (!top || !Array.isArray(worktrees)) return roots;
  const topR = P.resolve(top);
  let rel;
  if (inside(P, topR, home)) rel = P.relative(topR, home);
  /* Launched through a junction, a subst drive or an 8.3 name: git's top is
     the real path, so the text does not nest and the real paths do. */
  else if (inside(P, real(topR), real(home))) rel = P.relative(real(topR), real(home));
  else return roots;
  /* One folder once, under the spelling met first — the launch directory's,
     so a card that came in through a junction keeps its own name for it. */
  for (const w of worktrees) {
    const r = P.resolve(w, rel);
    if (!roots.some((x) => sameish(P, x, r) || sameish(P, real(x), real(r)))) roots.push(r);
  }
  return roots;
}

/** Whether a relative name would be a guess: the card was launched in its
 *  repository's main worktree and other worktrees stand beside it — or git
 *  did not answer (`unread`), so nobody can say. `main` is the first entry
 *  git listed, when it is a tree rather than a bare repository. */
function relativeIsGuess({ top, worktrees, main, unread }, P = path, real = textOnly(P)) {
  if (unread) return true;
  if (!top || !main || !Array.isArray(worktrees) || worktrees.length < 2) return false;
  return sameish(P, P.resolve(top), P.resolve(main)) || sameish(P, real(top), real(main));
}

const list = (roots) => roots.map((r) => `- ${r}`).join("\n");

/**
 * What to do with one call: `null` when it names no file, `{ root }` for the
 * directory to run it under, or `{ refuse }` with the sentence the card reads.
 *
 * Matched the way Playwright will check it, links resolved on both sides, so
 * the root chosen here is one its check passes. `output` is Playwright's output
 * folder, which a file may always be in and which belongs to the launch
 * directory. Where a file is under two roots — a worktree kept inside the
 * main checkout — the deeper one is the root.
 */
function plan({ args, launch, roots, output, guess, unread }, P = path, real = textOnly(P)) {
  const files = named(args);
  if (!files.length) return null;
  const home = P.resolve(launch);
  const out = output ? P.resolve(output) : null;
  const silent = unread
    ? `\nGit did not answer in ${home} (it failed or took over five seconds), so this card's worktrees could not be ` +
      `read and only the launch directory is listed — try again in a moment.`
    : "";
  const chosen = [];
  for (const f of files) {
    if (!P.isAbsolute(f)) {
      if (guess) {
        const why = unread
          ? `the browser could not read this repository's worktrees, so it cannot tell whether a relative name would ` +
            `land in the tree you are working in`
          : `that repository has other worktrees beside it, so a relative name could land in a tree this card is not ` +
            `working in — the browser cannot see which one you are in`;
        return {
          refuse:
            `Relative file name refused: "${f}". This card was launched in ${home}, and ${why}. Pass an absolute path ` +
            `inside the tree you are working in:\n${list(roots)}\n` +
            `Or leave the file name out to save into ${out ?? P.join(home, ".playwright-mcp")}.${silent}`,
        };
      }
      chosen.push(home);
      continue;
    }
    const abs = P.resolve(f);
    const fileReal = real(abs);
    if (out && (inside(P, real(out), fileReal) || inside(P, out, abs))) {
      chosen.push(home);
      continue;
    }
    /* A root its check will pass (links resolved) beats one that only
       matches as text; among equals, the deeper. */
    let best = null;
    let bestReal = false;
    for (const r of roots) {
      const isReal = inside(P, real(r), fileReal);
      if (!isReal && !inside(P, r, abs)) continue;
      if (!best || (isReal && !bestReal) || (isReal === bestReal && r.length > best.length)) {
        best = r;
        bestReal = isReal;
      }
    }
    if (!best) {
      return {
        refuse:
          `File access denied: ${abs} is outside this card's roots. A card may read and write files only under the ` +
          `directory it was launched in and the same directory in each worktree of its repository (\`git worktree list\`), ` +
          `so that it can keep evidence in the tree it works in without writing anywhere else by accident:\n` +
          `${list(roots)}${out ? `\n- ${out} (the browser's own output folder)` : ""}${silent}`,
      };
    }
    chosen.push(best);
  }
  const root = chosen[0];
  if (chosen.some((c) => !sameish(P, c, root))) {
    return {
      refuse:
        `These files are in different working trees: ${files.join(", ")}. One call reaches one tree — ` +
        `split it into one call per tree.`,
    };
  }
  return { root };
}

/**
 * The whole decision for one call, git included: `null` to run it as it is,
 * `{ root }` to run it under another tree, `{ refuse }` to answer it unrun.
 *
 * `git(cwd, args)` resolves to stdout, to `null` when git says the directory
 * is not in a repository, and to `undefined` when it failed any other way —
 * timed out, not installed. The last is *not* "no repository": read that way,
 * a git that hung would quietly bring back the relative name landing in the
 * main checkout. `exists` and `realpath` are the disk. Asked on every call
 * that names a file, which is what makes a worktree added after the card
 * started count.
 */
async function decide({ args, launch, outputDir, git, exists, realpath }, P = path) {
  if (!launch || !named(args).length) return null;
  const real = (p) => nearestReal(p, realpath, P);
  let top = "";
  let listed = [];
  let unread = false;
  const head = await git(launch, ["rev-parse", "--show-toplevel"]);
  if (typeof head === "string") {
    top = head.trim();
    const porcelain = await git(launch, ["worktree", "list", "--porcelain"]);
    if (typeof porcelain === "string") listed = parseWorktrees(porcelain);
    else unread = true;
  } else if (head === undefined) unread = true;
  /* A worktree git marks prunable, or whose folder has gone, is no place to
     write: Playwright would create its folders again. */
  const worktrees = listed.filter((w) => !w.bare && !w.prunable && exists(w.path)).map((w) => w.path);
  const main = listed[0] && !listed[0].bare ? listed[0].path : null;
  const tree = { launch, top, worktrees, main, unread };
  const output = outputDir ? P.resolve(outputDir) : P.join(launch, ".playwright-mcp");
  const p = plan({ args, launch, roots: cardRoots(tree, P, real), output, guess: relativeIsGuess(tree, P, real), unread }, P, real);
  if (!p || p.refuse) return p;
  return P.relative(P.resolve(launch), p.root) === "" ? null : p;
}

module.exports = { named, parseWorktrees, nearestReal, cardRoots, relativeIsGuess, plan, inside, decide };
