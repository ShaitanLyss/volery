/* Does every statement in `arrange.rs` actually parse against the schema it
 * will meet? Run it: `bun tools/lift-arrange.ts`.
 *
 * ### Why this exists
 *
 * `arrange.rs`'s own `#[cfg(test)] mod tests` builds a seven-table fixture by
 * hand, and the whole module was red for a day without anybody being able to
 * see it: the fixture's `arrangement` table was written before `adopt_in` grew
 * `origin_x`/`origin_y`, so every test `.unwrap()`-panicked on *table
 * arrangement has no column named origin_x*. That is invisible twice over on
 * this machine — `cargo test` cannot link here at all (`.claude/rules/build.md`,
 * the `0xC0000139` story) and SQL is an opaque string to the compiler either
 * way, so `tools/check-gnu.sh` is green on a module where nothing works.
 *
 * So this is the `tools/lift-*.ts` bargain applied to SQL: take the statements
 * out of the Rust rather than restating them, and run them where they can
 * actually be run. **It reads both schemas out of the source**, so a column
 * added to the migration and forgotten in the fixture is the failure it was.
 *
 * Statements are *prepared*, not executed. SQLite resolves every table and
 * column name at prepare time, which is the whole of what was wrong, and
 * preparing needs no plausible parameters.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const ARRANGE = readFileSync("src-tauri/src/arrange.rs", "utf8");
const STORE = readFileSync("src-tauri/src/store.rs", "utf8");

let passes = 0;
const fail: string[] = [];

function ok(what: string, cond: boolean, detail = "") {
  if (cond) passes++;
  else fail.push(`${what}${detail ? ` — ${detail}` : ""}`);
}

/** The body of the first `r#"…"#` raw string after `from`. */
function rawAfter(src: string, from: string): string {
  const at = src.indexOf(from);
  if (at < 0) throw new Error(`lift-arrange: could not find ${from}`);
  const open = src.indexOf('r#"', at);
  const close = src.indexOf('"#', open + 3);
  if (open < 0 || close < 0) throw new Error(`lift-arrange: no raw string after ${from}`);
  return src.slice(open + 3, close);
}

/** Every `CREATE TABLE …` in a blob, as whole statements. */
function creates(ddl: string): { name: string; sql: string }[] {
  const out: { name: string; sql: string }[] = [];
  for (const m of ddl.matchAll(/CREATE\s+(?:TABLE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)[\s\S]*?;/gi)) {
    out.push({ name: m[1], sql: m[0] });
  }
  return out;
}

/* ── the two schemas ─────────────────────────────────────────────────────── */

const fixture = creates(rawAfter(ARRANGE, "fn db() -> Connection"));
const migration = creates(rawAfter(STORE, "fn migrate_v40"));

ok("the fixture builds the five glass tables plus the two this owns", fixture.length >= 7, `found ${fixture.length}`);
ok("the migration creates arrangement and glass_spot", migration.length >= 2, `found ${migration.length}`);

/** Column names out of a `CREATE TABLE`, which is enough to compare two
 *  spellings of the same table without parsing SQL properly. */
function columnsOf(sql: string): Set<string> {
  const open = sql.indexOf("(");
  const body = sql.slice(open + 1, sql.lastIndexOf(")"));
  const out = new Set<string>();
  for (const part of body.split(",")) {
    const word = part.trim().split(/\s+/)[0];
    if (word && /^\w+$/.test(word) && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(word)) {
      out.add(word.toLowerCase());
    }
  }
  return out;
}

/* **The assertion the bug needed.** The fixture is a second spelling of what
   the migration writes, and two spellings of one schema drift. Anything the
   real table has, the fixture must have — the other direction is allowed, since
   a fixture may carry a column for a table the migration does not own. */
for (const real of migration) {
  const mine = fixture.find((f) => f.name === real.name);
  if (!mine) {
    fail.push(`the test fixture has no ${real.name} table at all`);
    continue;
  }
  const want = columnsOf(real.sql);
  const have = columnsOf(mine.sql);
  const missing = [...want].filter((c) => !have.has(c));
  ok(
    `the test fixture's ${real.name} has every column the migration gives it`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(", ")}` : "",
  );
}

/* ── every statement, against that schema ────────────────────────────────── */

const db = new Database(":memory:");
for (const t of fixture) db.run(t.sql);

/** The kinds `arrange.rs` walks, read out of its own `KINDS` table so a sixth
 *  thing on the glass cannot be lifted against only five. */
const KINDS = [...ARRANGE.matchAll(/\(\s*(CARD|TERRITORY|IMAGE|WIDGET|TIMELINE)\s*,\s*"(\w+)"\s*,\s*"(\w+)"\s*\)/g)].map(
  (m) => ({ kind: m[1].toLowerCase(), table: m[2], idc: m[3] }),
);
ok("KINDS names all five things that can stand on the glass", KINDS.length === 5, `found ${KINDS.length}`);

/** Every SQL-looking string literal in the file: the `"…"` ones and the
 *  `format!("…")` ones, which carry `{kind}`/`{table}`/`{idc}` holes. */
function statements(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const text = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) out.push(text);
  }
  return out;
}

const found = statements(ARRANGE);
ok("there are statements to lift at all", found.length >= 8, `found ${found.length}`);

for (const raw of found) {
  const holes = raw.includes("{");
  const shapes = holes
    ? KINDS.map((k) =>
        raw.replace(/\{kind\}/g, k.kind).replace(/\{table\}/g, k.table).replace(/\{idc\}/g, k.idc),
      )
    : [raw];
  for (const sql of shapes) {
    /* `?1`-style parameters prepare fine; what is being checked is that every
       table and column named in the statement exists. */
    try {
      db.query(sql).finalize?.();
      passes++;
    } catch (err) {
      fail.push(`${String(err).split("\n")[0]}\n    in: ${sql.trim().replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
}

/* ── and the round trip the tests are about, actually run ────────────────── */

/* Only once the schema comparison above has passed. Otherwise the first `run`
   here throws the raw SQLite error and the clean diagnostic — *the fixture is
   missing origin_x* — never gets printed, which is the difference between a
   lift that tells you what is wrong and one that tells you it went wrong. */
if (fail.length) report();

db.run("INSERT INTO placement VALUES ('c1', 10.0, 20.0)");
db.run(
  `INSERT INTO arrangement (key, screens_json, seen_at, current, origin_x, origin_y)
   VALUES ('one', '[]', 1, 0, 0, 0)`,
);
db.run(
  `INSERT OR REPLACE INTO glass_spot (arrangement, kind, ref, x, y)
   SELECT 'one', 'card', conversation_id, glass_x, glass_y FROM placement
   WHERE glass_x IS NOT NULL AND glass_y IS NOT NULL`,
);
db.run(
  `UPDATE placement SET
     glass_x = (SELECT s.x FROM glass_spot s
                 WHERE s.arrangement = 'two' AND s.kind = 'card' AND s.ref = placement.conversation_id),
     glass_y = (SELECT s.y FROM glass_spot s
                 WHERE s.arrangement = 'two' AND s.kind = 'card' AND s.ref = placement.conversation_id)`,
);
const after = db.query("SELECT glass_x FROM placement WHERE conversation_id = 'c1'").get() as {
  glass_x: number | null;
};
ok("a room that holds nothing puts the card back on the wall", after.glass_x === null, `got ${after.glass_x}`);

/* And the whole round trip, driven the way a *writer* drives it.
 *
 * `arrange::note` is only ever half of a placement — `save_placement` writes
 * `placement.glass_x` itself and notes the row beside it — and a test that
 * calls one half and reads the other is asserting something no code path does.
 * One of the Rust tests did exactly that and it went red on a release runner,
 * because `cargo test` cannot link on this machine and so the module had never
 * run here at all. This is the same claim where it *can* be run. */
/* A second card, in no room at all to begin with — `c1` was seeded into room
   "one" above, and the claim here is about one that was never in it. */
db.run("INSERT INTO placement VALUES ('c2', NULL, NULL)");

function stick(id: string, x: number | null, y: number | null, room: string) {
  db.run("UPDATE placement SET glass_x = ?, glass_y = ? WHERE conversation_id = ?", [x, y, id]);
  if (x === null || y === null) {
    db.run("DELETE FROM glass_spot WHERE arrangement = ? AND kind = 'card' AND ref = ?", [room, id]);
  } else {
    db.run(
      `INSERT INTO glass_spot (arrangement, kind, ref, x, y) VALUES (?, 'card', ?, ?, ?)
       ON CONFLICT(arrangement, kind, ref) DO UPDATE SET x = ?3, y = ?4`,
      [room, id, x, y],
    );
  }
}

function reconcileTo(room: string) {
  db.run(
    `UPDATE placement SET
       glass_x = (SELECT s.x FROM glass_spot s
                   WHERE s.arrangement = ? AND s.kind = 'card' AND s.ref = placement.conversation_id),
       glass_y = (SELECT s.y FROM glass_spot s
                   WHERE s.arrangement = ? AND s.kind = 'card' AND s.ref = placement.conversation_id)`,
    [room, room],
  );
}

function spotNow(): number | null {
  return (
    db.query("SELECT glass_x FROM placement WHERE conversation_id = 'c2'").get() as {
      glass_x: number | null;
    }
  ).glass_x;
}

stick("c2", 5, 6, "two");
ok("sticking a card writes the column and the row together", spotNow() === 5, `got ${spotNow()}`);
reconcileTo("one");
ok("walking into a room that never held it puts it back on the wall", spotNow() === null, `got ${spotNow()}`);
reconcileTo("two");
ok("walking back finds it where it was left", spotNow() === 5, `got ${spotNow()}`);
stick("c2", null, null, "two");
reconcileTo("one");
reconcileTo("two");
ok("a room you emptied stays empty", spotNow() === null, `got ${spotNow()}`);

/* ── the reading ─────────────────────────────────────────────────────────── */

report();

/** The reading, in the shape `tools/lifts.ts` parses.
 *
 *  That harness greps `test result: ok. N passed` out of each lift, because
 *  every other lift in this family is a `rustc --test` and that is what one
 *  prints. This lift is plain TypeScript and says the same sentence, so it is
 *  counted rather than read as a lift that compiled and asserted nothing —
 *  which is the exact failure mode `lifts.ts` exists to catch and would have
 *  reported about its own newest member. */
function report(): never {
  if (fail.length) {
    for (const f of fail) console.error(`  ✗ ${f}`);
    console.error(`\ntest result: FAILED. ${passes} passed; ${fail.length} failed;`);
    process.exit(1);
  }
  if (passes < 20) {
    console.error(`only ${passes} assertions — this lift has stopped finding anything`);
    console.error(`\ntest result: FAILED. ${passes} passed; 1 failed;`);
    process.exit(1);
  }
  console.log(`test result: ok. ${passes} passed; 0 failed;`);
  process.exit(0);
}
