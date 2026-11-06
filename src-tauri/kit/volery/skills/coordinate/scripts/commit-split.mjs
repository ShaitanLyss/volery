// Commit some whole files, and chosen hunks of others, without touching the shared index
// or the working tree. For a tree several cards edit at once. Run from inside the repo.
//
//   node commit-split.mjs --message <file> [--paths <file>] [--path <p>]... [--hunks <p>=1,3]...
//
//   --message <file>   the commit message. Write it in .scratch-$SKEIN_CARD/, never /tmp,
//                      which every card on the machine reaches for.
//   --paths <file>     one repo path per line, committed as it is on disk (new, modified or
//                      deleted). CRLF is fine. A directory is refused, since adding one
//                      would take everything under it.
//   --path <p>         the same, one path at a time.
//   --hunks <p>=1,3    only hunks 1 and 3 (1-based, as `git diff -- <p>` numbers them) of
//                      that file's working-tree changes.
//
// How it stays out of other cards' way:
//   - The commit is built in a private index, from HEAD as it was when this started.
//   - HEAD is moved with a compare-and-swap (`git update-ref HEAD <new> <old>`), so if
//     another card committed meanwhile this fails loudly instead of committing a tree
//     that silently reverts theirs. Run it again; it starts from the new HEAD.
//   - Afterwards the shared index entries of the committed paths are set to the new HEAD,
//     which is what `git commit -- <paths>` would have left. Nothing else is touched.
//
// It runs `git commit-tree`, so the repository's own git hooks (pre-commit, commit-msg)
// do not run. Run the repo's checks yourself first.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.on('uncaughtException', (e) => {
  console.error(`commit-split: ${e.message}`);
  process.exit(1);
});

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${why ? `: ${why}` : ''}`);
  }
  return r.stdout;
}

const args = process.argv.slice(2);
let message = null;
const paths = [];
const hunks = new Map();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    return args[++i];
  };
  if (a === '--message') message = next();
  else if (a === '--path') paths.push(next());
  else if (a === '--paths') {
    for (const line of readFileSync(next(), 'utf8').split(/\r?\n/)) if (line.trim()) paths.push(line.trim());
  } else if (a === '--hunks') {
    const v = next();
    const eq = v.lastIndexOf('=');
    if (eq < 1) throw new Error(`--hunks wants <path>=<n>[,<n>...], got ${v}`);
    const keep = v.slice(eq + 1).split(',').map(Number);
    if (keep.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`bad hunk numbers in ${v}`);
    hunks.set(v.slice(0, eq), new Set(keep));
  } else throw new Error(`unknown argument ${a}`);
}
if (!message) throw new Error('--message <file> is required');
if (!paths.length && !hunks.size) throw new Error('nothing to commit: give --path, --paths or --hunks');

const root = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(root);
for (const p of paths) {
  let isDir = false;
  try { isDir = statSync(p).isDirectory(); } catch { /* a deletion */ }
  if (isDir) throw new Error(`${p} is a directory; name the files in it`);
}

/** A diff cut down to the hunks named, keeping each line's own ending so the patch
 *  still ends in a newline whichever hunks are kept. */
function cut(diff, keep) {
  const lines = diff.split(/(?<=\n)/);
  let h = 0;
  const out = [];
  for (const l of lines) {
    if (l.startsWith('@@')) h++;
    if (h === 0 || keep.has(h)) out.push(l);
  }
  const found = lines.filter((l) => l.startsWith('@@')).length;
  for (const n of keep) if (n > found) throw new Error(`asked for hunk ${n}, but the diff has ${found}`);
  return out.join('');
}

const base = git(['rev-parse', 'HEAD']).trim();
const tmp = mkdtempSync(path.join(tmpdir(), 'commit-split-'));
const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
try {
  git(['read-tree', base], { env });
  for (const p of paths) git(['add', '--', p], { env });
  for (const [p, keep] of hunks) {
    const diff = git(['diff', '--', p]);
    if (!diff) throw new Error(`${p} has no unstaged changes to take hunks from`);
    const patch = path.join(tmp, 'hunks.patch');
    writeFileSync(patch, cut(diff, keep));
    git(['apply', '--cached', '--recount', '--whitespace=nowarn', patch], { env });
  }
  process.stdout.write(git(['diff', '--cached', '--stat', base], { env }));
  const tree = git(['write-tree'], { env }).trim();
  if (tree === git(['rev-parse', `${base}^{tree}`]).trim()) throw new Error('that commit would change nothing');
  const commit = git(['commit-tree', tree, '-p', base, '-F', message]).trim();
  try {
    git(['update-ref', '-m', 'commit-split', 'HEAD', commit, base]);
  } catch (e) {
    throw new Error(`HEAD moved while this ran (another commit landed), so nothing was committed. Run it again. (${e.message})`);
  }
  const committed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').filter(Boolean);
  if (committed.length) git(['restore', '--staged', '--source=HEAD', '--', ...committed]);
  process.stdout.write(git(['log', '--oneline', '-1']));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
