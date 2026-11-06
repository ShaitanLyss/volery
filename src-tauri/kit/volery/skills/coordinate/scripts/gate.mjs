// Gate a branch in a clean worktree nobody edits, and push only when the repo's checks pass.
//
//   node gate.mjs --checks "<command>" [--branch main] [--remote origin]
//                 [--worktree <dir>] [--no-push]
//
// Why a separate worktree: the shared tree holds other cards' uncommitted files, so a
// check run there is red for reasons that are not the batch's, and a merge there either
// refuses or takes their work with it.
//
// What it does, in the gate worktree:
//   1. fetches <remote> and moves to <remote>/<branch>, detached, so every run starts from
//      what is published rather than from whatever the last run left;
//   2. fast-forwards to your local <branch>. If the two have diverged it stops and says so:
//      rebase your branch onto the remote's first. It never makes a merge commit;
//   3. runs --checks (a shell command, run in the gate worktree: the repo's own check
//      script, usually limited to what the batch touched) and stops if it exits non-zero;
//   4. pushes HEAD to <remote>/<branch>, unless --no-push. For a repo that lands work
//      through pull requests, use --no-push and push the branch the way the repo does.
//
// Setting one up, once per machine:
//   git worktree add --detach ../<repo>-gate origin/main     (then install dependencies there)
// --worktree, or GATE_WT, says where it is; the default is <repo>/../<repo>-gate.
//
// It refuses to run in the tree you are standing in, and refuses a gate worktree with
// uncommitted changes rather than discarding them.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

process.on('uncaughtException', (e) => {
  console.error(`gate: ${e.message}`);
  process.exit(1);
});

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${why ? `: ${why}` : ''}`);
  }
  return r.stdout;
}

const args = process.argv.slice(2);
let checks = null;
let branch = 'main';
let remote = 'origin';
let gateDir = process.env.GATE_WT || null;
let push = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    return args[++i];
  };
  if (a === '--checks') checks = next();
  else if (a === '--branch') branch = next();
  else if (a === '--remote') remote = next();
  else if (a === '--worktree') gateDir = next();
  else if (a === '--no-push') push = false;
  else throw new Error(`unknown argument ${a}`);
}
if (!checks) throw new Error('--checks "<command>" is required: the repo\'s own check script');

const here = git(['rev-parse', '--show-toplevel']).trim();
gateDir = path.resolve(gateDir || path.join(here, '..', `${path.basename(here)}-gate`));
if (!existsSync(gateDir)) {
  throw new Error(
    `no gate worktree at ${gateDir}. Make one once with: git worktree add --detach ${gateDir} ${remote}/${branch}`,
  );
}
const real = (p) => realpathSync(p).toLowerCase();
if (real(git(['rev-parse', '--show-toplevel'], gateDir).trim()) === real(here)) {
  throw new Error(`${gateDir} is the tree you are standing in, not a gate worktree`);
}
const common = (dir) => real(path.resolve(dir, git(['rev-parse', '--git-common-dir'], dir).trim()));
if (common(gateDir) !== common(here)) {
  throw new Error(`${gateDir} is a worktree of a different repository`);
}
const dirty = git(['status', '--porcelain'], gateDir).trim();
if (dirty) throw new Error(`the gate worktree has uncommitted changes, so nothing was touched:\n${dirty}`);

git(['fetch', '-q', remote], gateDir);
git(['checkout', '-q', '--detach', `${remote}/${branch}`], gateDir);
const ff = spawnSync('git', ['merge', '--ff-only', '-q', branch], { cwd: gateDir, encoding: 'utf8' });
if (ff.status !== 0) {
  throw new Error(
    `local ${branch} and ${remote}/${branch} have diverged, so there is no fast-forward. ` +
      `Rebase ${branch} onto ${remote}/${branch} in your own tree, then run the gate again.`,
  );
}
console.log(`gate at ${git(['log', '--oneline', '-1'], gateDir).trim()}`);

const run = spawnSync(checks, { cwd: gateDir, shell: true, stdio: 'inherit' });
if (run.status !== 0) {
  console.log(`RED (exit ${run.status ?? run.signal}): not pushed`);
  process.exit(1);
}
if (!push) {
  console.log('green, not pushed (--no-push)');
  process.exit(0);
}
const pushed = spawnSync('git', ['push', remote, `HEAD:${branch}`], { cwd: gateDir, encoding: 'utf8' });
if (pushed.status !== 0) {
  console.log(`PUSH FAILED:\n${(pushed.stderr || pushed.stdout).trim()}`);
  process.exit(1);
}
console.log(`green, pushed to ${remote}/${branch}`);
