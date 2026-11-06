// After a commit made in a shared tree: for each file the commit touched, find its named
// imports from local modules that are still dirty in the working tree, and check each name
// is exported by the commit's version of that module. A miss means the commit compiles only
// with uncommitted work beside it (another card's hunk, or a new file left out).
//
//   node check-imports.mjs [<commit>] [--alias <prefix>=<dir>]...
//
// Relative imports resolve on their own. Path aliases need saying, e.g.
//   --alias @/=apps/mobile/src/ --alias @acme/shared=packages/shared/src/index
// Named imports (`import { a, b } from`) in TypeScript, JavaScript, Svelte and Vue files
// only: default and namespace imports are not checked. False positives on
// `export type {X} from`.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const sh = (c) => execSync(c, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });

const args = process.argv.slice(2);
let commit = 'HEAD';
const aliasRoots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--alias') {
    const [prefix, dir] = args[++i].split('=');
    aliasRoots.push([prefix, dir]);
  } else commit = args[i];
}

const files = sh(`git diff-tree --no-commit-id --name-only -r ${commit}`).trim().split('\n')
  .filter((f) => /\.(tsx?|mts|jsx?|mjs|svelte|vue)$/.test(f) && existsSync(path.join(root, f)));
const dirty = new Set(sh('git status --porcelain -uall').split('\n').filter(Boolean).map((l) => l.slice(3).trim()));

function resolve(from, spec) {
  let base;
  if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec);
  else {
    const a = aliasRoots.find(([p]) => spec === p || spec.startsWith(p));
    if (!a) return null;
    base = a[1] + spec.slice(a[0].length);
  }
  for (const ext of ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
    const p = path.posix.normalize(base + ext);
    if (existsSync(path.join(root, p)) && !p.endsWith('/')) return p;
  }
  return null;
}

let problems = 0;
for (const f of files) {
  const src = sh(`git show ${commit}:"${f}"`);
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolve(f, m[2]);
    if (!target || !dirty.has(target)) continue;
    let head = '';
    try { head = sh(`git show ${commit}:"${target}"`); } catch { console.log(`MISSING IN COMMIT: ${f} imports ${target}, not in the commit`); problems++; continue; }
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim().replace(/[$.*+?^(){}|[\]\\]/g, '\\$&');
      if (!name) continue;
      /* Identifier edges rather than `\b`: a name like `$state` starts with a
         character `\b` does not treat as part of a word, so `\b$state` never matches. */
      const id = `(?<![\\w$])${name}(?![\\w$])`;
      const re = new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|class|type|interface|enum)\\s+${id}|export\\s*\\{[^}]*${id}|export\\s+\\*\\s+from`);
      if (!re.test(head)) { console.log(`NOT EXPORTED AT ${commit}: ${name} from ${target} (used by ${f})`); problems++; }
    }
  }
}
console.log(problems ? `${problems} problem(s)` : `ok: ${files.length} files, no import relies on uncommitted work`);
process.exit(problems ? 1 : 0);
