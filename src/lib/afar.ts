/* What parks waiting for a person, carried to the wall the person is at.
 *
 * Sink `16864f3d`'s rule: **anything that parks waiting for a person must
 * travel to where the person is, or fail fast.** `ask_user` was the first and
 * its shape is the template every other one follows — the thing waiting rides
 * the card's digest, words only, and what the person says comes back over the
 * prompt wire naming what it answers (`Ask::answers`). This file is the other
 * two, which `shadow.ts` carries in the digest beside `asks`:
 *
 *  - **notices** — a card that finished, ended on a question, gave up, or said
 *    something itself (`notice.ts`). The queue that waits for you is the owning
 *    wall's; the digest carries its rows, and taking one down from here is an
 *    answer that names the notice (`noticeAnswer`).
 *  - **removal confirmations** — Volery's own question, put up by `remove.rs`
 *    before a permanent delete. Crosses only with evidence.
 *  - **close confirmations** — Volery's own question, put up by `spawn.rs` when
 *    a card names one it did not open. Crosses the same way (sink `2770489d`);
 *    unpost stays where it is.
 *
 * ### The removal is the whole of the care
 *
 * Lyss overruled the first proposal, which kept it local: *"it should be my
 * judgement whether to go through it or not, blocked away by volery."* What she
 * gives up by not being at the machine is the glance, so the confirmation owes
 * what the glance would have said, about the disk it is actually about (sink
 * `7207a6d9`): the machine, the path as that machine resolved it, what is there
 * — kind, entries, size, whether those are floors, whether it is inside the
 * card's own tree — and the card's reason.
 *
 * So the question drawn here is **composed from those fields** (`removalHere`)
 * and never from the owning wall's prose. A field missing is then a question
 * this wall cannot compose, and it refuses rather than asks — a confirmation
 * reduced to a path string is the version that deserved the original worry.
 * And it is named for the wall it was *heard from*, which the link vouches for,
 * and refused if the evidence names a different machine: the whole risk is
 * confirming against the wrong filesystem.
 *
 * Both travel in **fields of their own** rather than inside `asks`, for the
 * reason two walls are never upgraded together: a wall from before this reads
 * `asks` and skips what it has no word for, so a removal put in `asks` would
 * reach an older wall as an ordinary question with no machine on it — exactly
 * what must not happen. In a field of its own it reaches that wall as nothing.
 *
 * Pure, and tested in `test/afar.test.ts`. */

import type { AskQuestion } from "./asking";
import { noticeLine, noticeWords, parkedReply, type Notice, type NoticeKind } from "./notice";
import { capText, scrub } from "./shadow";
import { nameBesideProject } from "./naming";

/* ── removals ─────────────────────────────────────────────────────────── */

/** The labels `remove.rs` reads a yes and a no from (`DELETE_IT`, `KEEP_IT`).
 *  Only the first is a yes, and only verbatim; `test/afar.test.ts` reads them
 *  out of the Rust so the two cannot drift. */
export const DELETE_IT = "delete it";
export const KEEP_IT = "keep it";

/** `remove::MAX_GROUPED`: forty paths in at most two directories, drawn as one
 *  listing per directory. Past `REMOVAL_LISTED` the question groups them, as
 *  the owning wall's does. */
export const REMOVAL_TARGETS_CAP = 40;
/** `remove::MAX_PATHS`: up to this many are each described in full. */
export const REMOVAL_LISTED = 8;
/** `remove::MAX_REPOS`. */
const REPOS_CAP = 24;
const PATH_CAP = 1_000;
const REASON_CAP = 2_000;
const NAME_CAP = 80;
const NAMES_CAP = 12;

export type RemovalTarget = {
  /** Absolute, canonical, as the owning machine resolved it. */
  path: string;
  kind: "file" | "directory" | "link";
  /** Always true: a path that is not there is refused before anybody is
   *  asked, so evidence saying otherwise is evidence of nothing. */
  exists: true;
  /** Files under it — 1 for a file. A floor when `capped`. */
  entries: number;
  bytes: number;
  capped: boolean;
  /** Inside the directory the card's own process runs in. */
  own: boolean;
  repo: boolean;
  tracked: number;
  /** Other cards on that wall that have written under it. */
  writers: string[];
  /** Dev servers running out of a tree containing it. */
  servers: string[];
  /** Every git repository the delete takes, `.git` included. A removal is
   *  only ever asked about with these when each has passed `unsafe_repo` on
   *  the owning machine — every branch on a remote, nothing uncommitted,
   *  untracked or stashed — so their presence is the claim *nothing
   *  unpushed*, and the fields say where it was pushed. Absent on a wall from
   *  before 2026-10-25, which never asked about a repository at all. */
  repos: RemovalRepo[];
};

export type RemovalRepo = {
  path: string;
  /** A linked worktree, whose commits live in a repository elsewhere. */
  worktree: boolean;
  /** `name (url)`, one per remote. */
  remotes: string[];
  branches: number;
  /** What git ignores in it and the delete takes anyway. */
  ignored: string[];
};

/** One repository off the wire, or null when it is malformed. */
function readRepo(raw: unknown): RemovalRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  const path = typeof x.path === "string" ? scrub(x.path).trim() : "";
  const branches = count(x.branches);
  if (!path || path.length > PATH_CAP || typeof x.worktree !== "boolean" || branches === null) return null;
  const remotes = names(x.remotes);
  /* A clone with no remote cannot have passed, so evidence saying so is
     evidence of nothing. */
  if (!x.worktree && !remotes.length) return null;
  return { path, worktree: x.worktree, remotes, branches, ignored: names(x.ignored) };
}

/** `remove::evidence`, as the question carries it. */
export type Removal = {
  /** The flyway name of the machine the delete would happen on. */
  machine: string;
  reason: string;
  targets: RemovalTarget[];
};

/** A removal a card is parked on, as it travels. */
export type DigestRemoval = { askId: string; since: number; removal: Removal };

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, NAMES_CAP)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => capText(v.trim(), NAME_CAP));
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** The evidence off the wire, or null when anything a person would need is
 *  missing. `remove::travels` is the same reading in Rust, on the machine the
 *  delete would happen on; this is it on the machine that draws the question,
 *  and on the owning wall before it publishes one. **Strict in the direction
 *  that refuses**: a field the wrong shape is not degraded to something
 *  drawable, as a digest's fields are, because a removal drawn with a hole in
 *  it is a question about less than it appears to be. */
export function readRemoval(raw: unknown): Removal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const machine = typeof r.machine === "string" ? scrub(r.machine).trim() : "";
  const reason = typeof r.reason === "string" ? scrub(r.reason).trim() : "";
  if (!machine || !reason || !Array.isArray(r.targets)) return null;
  if (!r.targets.length || r.targets.length > REMOVAL_TARGETS_CAP) return null;
  const targets: RemovalTarget[] = [];
  for (const t of r.targets) {
    if (!t || typeof t !== "object") return null;
    const x = t as Record<string, unknown>;
    const path = typeof x.path === "string" ? scrub(x.path).trim() : "";
    const kind = x.kind;
    const entries = count(x.entries);
    const bytes = count(x.bytes);
    if (!path || path.length > PATH_CAP) return null;
    if (kind !== "file" && kind !== "directory" && kind !== "link") return null;
    if (x.exists !== true || entries === null || bytes === null) return null;
    if (typeof x.capped !== "boolean" || typeof x.own !== "boolean") return null;
    /* Strict once present: a repository drawn with a hole in it is a claim of
       *nothing unpushed* about less than it appears to be. */
    let repos: RemovalRepo[] = [];
    if (x.repos !== undefined) {
      if (!Array.isArray(x.repos) || x.repos.length > REPOS_CAP) return null;
      for (const raw of x.repos) {
        const repo = readRepo(raw);
        if (!repo) return null;
        repos.push(repo);
      }
    }
    targets.push({
      path,
      kind,
      exists: true,
      entries,
      bytes,
      capped: x.capped,
      own: x.own,
      repo: x.repo === true,
      tracked: count(x.tracked) ?? 0,
      writers: names(x.writers),
      servers: names(x.servers),
      repos,
    });
  }
  return { machine: capText(machine, NAME_CAP), reason: capText(reason, REASON_CAP), targets };
}

/** The removals a card is parked on, for its digest: Volery's own questions
 *  (`ours`) carrying readable evidence, and nothing else. An agent's
 *  `ask_user` with a `remove` block in it is still an agent's question — it is
 *  `ours` that makes the evidence Volery's. */
export function removalsOf(
  asks: readonly { askId: string; since: number; ours: boolean; remove?: Removal | null }[],
): DigestRemoval[] {
  return asks.flatMap((a) =>
    a.ours && a.remove ? [{ askId: a.askId, since: a.since, removal: a.remove }] : [],
  );
}

/** Removals off the wire. One whose evidence cannot be read is dropped — it
 *  is not drawn at all rather than drawn as less. */
export function readRemovals(raw: unknown): DigestRemoval[] {
  if (!Array.isArray(raw)) return [];
  const out: DigestRemoval[] = [];
  for (const a of raw.slice(0, 4)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const askId = typeof r.askId === "string" ? scrub(r.askId).trim().slice(0, 80) : "";
    const since = typeof r.since === "number" && Number.isFinite(r.since) ? r.since : null;
    const removal = readRemoval(r.removal);
    if (askId && since !== null && removal) out.push({ askId, since, removal });
  }
  return out;
}

/** Bytes, in `remove::human_size`'s register: two figures past a kilobyte,
 *  since the decision is *is this the five-gigabyte one*. */
export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  if (u === 0) return `${bytes} B`;
  return n >= 100 ? `${n.toFixed(0)} ${units[u]}` : `${n.toFixed(1)} ${units[u]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One target's lines, every one a reading of that disk. */
function described(t: RemovalTarget, host: string): string {
  const size =
    t.kind === "directory"
      ? t.capped
        ? `more than ${humanSize(t.bytes)} in more than ${plural(t.entries, "file")} — the count stopped there`
        : `${humanSize(t.bytes)} in ${plural(t.entries, "file")}`
      : humanSize(t.bytes);
  const lines = [
    `**${t.path}**`,
    `- ${t.kind === "link" ? "a link — the link goes, not what it points at" : `a ${t.kind}`}, ${size}`,
    t.own
      ? "- inside the card's own working tree"
      : "- **outside the card's own working tree**",
    !t.repo
      ? "- not in a git work tree — nothing here comes back from a commit"
      : t.tracked
        ? `- git tracks ${plural(t.tracked, "file")} under it, so those come back from a commit`
        : "- in a git work tree but **untracked** — git has no copy of any of it",
  ];
  if (t.writers.length) lines.push(`- **other cards on ${host} have written in here**: ${t.writers.join(", ")}`);
  if (t.servers.length)
    lines.push(`- **a dev server is running out of this tree on ${host}**: ${t.servers.join(", ")}`);
  lines.push(...reposSaid(t));
  return lines.join("\n");
}

/** A name list cut at six with the rest counted — `remove::listed`. */
function listed(items: string[]): string {
  const shown = items.slice(0, 6);
  const more = items.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

function lastSegment(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  return t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1);
}

function parentOf(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  return t.slice(0, Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"), 0));
}

/** `remove::repo_line`, from the fields: what a repository that passed is. */
export function repoLine(r: RemovalRepo): string {
  if (r.worktree)
    return (
      `${r.path} — a linked worktree; its commits live in the main repository, which this does ` +
      `not touch. Nothing uncommitted or untracked in it.`
    );
  return (
    `${r.path} — **pushed to ${r.remotes.join(", ")}, nothing unpushed**: ${plural(r.branches, "local branch", "local branches")} ` +
    `all on a remote, no stash, nothing uncommitted or untracked. As of that clone's last fetch; ` +
    `git was not asked over the network.`
  );
}

/** `remove::repos_said`: the lines a target's repositories add. */
function reposSaid(t: RemovalTarget): string[] {
  const out: string[] = [];
  const key = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (t.repos.some((r) => key(r.path) === key(t.path))) out.push("- **a whole git repository, `.git` included**");
  for (const r of t.repos) {
    out.push(`- ${repoLine(r)}`);
    if (r.ignored.length)
      out.push(`- ignored by git in ${lastSegment(r.path)}, so going with no copy anywhere: ${listed(r.ignored)}`);
  }
  return out;
}

/** `remove::compact`: one target in a grouped listing, every warning kept. */
function compactLine(t: RemovalTarget, host: string): string {
  const floor = t.capped ? "more than " : "";
  const size =
    t.kind === "link"
      ? "a link"
      : t.kind === "directory"
        ? `${floor}${humanSize(t.bytes)} in ${floor}${plural(t.entries, "file")}`
        : humanSize(t.bytes);
  const git = !t.repo ? "not in git" : t.tracked ? `**git tracks ${t.tracked}**` : "untracked";
  let line = `- \`${lastSegment(t.path)}\` — ${size}, ${git}`;
  if (t.writers.length) line += `; **written in by ${t.writers.join(", ")} on ${host}**`;
  if (t.servers.length) line += `; **dev server running on ${host}: ${t.servers.join(", ")}**`;
  const repos = t.repos.map((r) => `\n  - ${repoLine(r)}`).join("");
  return line + repos;
}

/** Many targets, one listing per directory — `remove::question`'s grouped form. */
function grouped(targets: RemovalTarget[], host: string): string[] {
  const order: string[] = [];
  const by = new Map<string, RemovalTarget[]>();
  for (const t of targets) {
    const dir = parentOf(t.path);
    const k = dir.replace(/\\/g, "/").toLowerCase();
    if (!by.has(k)) {
      by.set(k, []);
      order.push(dir);
    }
    by.get(k)!.push(t);
  }
  return order.map((dir) => {
    const here = by.get(dir.replace(/\\/g, "/").toLowerCase())!;
    const bytes = here.reduce((n, t) => n + t.bytes, 0);
    const files = here.reduce((n, t) => n + t.entries, 0);
    const floor = here.some((t) => t.capped) ? "more than " : "";
    const own = here.every((t) => t.own) ? "" : " — **outside the card's own working tree**";
    return [
      `**${here.length} paths in ${dir}**, together ${floor}${humanSize(bytes)} in ${floor}${plural(files, "file")}${own}:`,
      ...here.map((t) => compactLine(t, host)),
    ].join("\n");
  });
}

/** The question this wall draws for a removal parked on `host` — or null, and
 *  it is not drawn, when the evidence names a different machine.
 *
 *  Composed here from the fields alone, so nothing the owning wall's prose said
 *  can be missing from it without the fields being missing too, which
 *  `readRemoval` has already refused. The machine leads, in the header the peek
 *  prints and in the first line of the body: the one way this goes wrong that
 *  a local confirmation cannot is deciding about the wrong disk. */
export function removalHere(r: Removal, host: string): AskQuestion[] | null {
  if (!host || r.machine.toLowerCase() !== host.toLowerCase()) return null;
  const which = r.targets.length === 1 ? "this" : `these ${r.targets.length}`;
  const body = [
    `A card on **${host}** wants to **delete** ${which} — on ${host}'s disk, not this machine's:`,
    ...(r.targets.length > REMOVAL_LISTED ? grouped(r.targets, host) : r.targets.map((t) => described(t, host))),
    `Its reason: *${r.reason}*`,
    `**This is permanent.** It is not moved to a recycle bin and nothing on either wall can bring ` +
      `it back. ${host} checks again at the moment of deleting and refuses if the tree has ` +
      `changed under it — uncommitted work appearing there, say — so what you are approving is ` +
      `what is described here.`,
  ].join("\n\n");
  return [
    {
      header: `delete on ${host}`,
      question: body,
      options: [
        { label: DELETE_IT, detail: `Gone for good, from ${host}. The card is told what was removed.` },
        { label: KEEP_IT, detail: "Nothing is touched. The card is told you said so." },
      ],
    },
  ];
}

/* ── deferring one from here ──────────────────────────────────────────── */

/** What a *defer* sent to another wall says. `ask::DEFER_ANSWER` is the same
 *  string, held by a test: a defer has no field of its own on the prompt wire
 *  and a wall from before it would read a new field as absent, which is an
 *  answer. So it is a sentence an older wall can hand an agent *as* an answer
 *  without harm — nothing decided, do not decide it — and a wall that knows it
 *  files the question in its pile exactly as a local defer does. */
export const DEFER_ANSWER =
  "Defer this question: I will answer it later. Nothing has been decided — do not decide it yourself.";

/* ── closes ───────────────────────────────────────────────────────────── */

/** The labels `spawn.rs` reads a yes and a no from (`CLOSE_IT`, `LEAVE_IT`);
 *  `test/afar.test.ts` reads them out of the Rust so the two cannot drift. */
export const CLOSE_IT = "close it";
export const LEAVE_IT = "leave it open";

const HANDLE_CAP = 64;

/** A card as a close names it: the title she knows it by and its handle, since
 *  two cards can share a title and the handle is what `close` resolved. */
export type ClosingCard = { title: string; handle: string };

/** `spawn::close_evidence`, as the question carries it. */
export type Closing = {
  /** The flyway name of the machine the close would happen on. */
  machine: string;
  card: ClosingCard;
  by: ClosingCard;
  /** What the asking card said, or null — it gave none, and that is drawn. */
  why: string | null;
  /** The plan still in flight on the card being closed (`with_timeline`), or
   *  null. Closing archives it as unfinished, which the local question says and
   *  so must this one. */
  timeline: string | null;
};

/** A close a card is parked on, as it travels. */
export type DigestClosing = { askId: string; since: number; closing: Closing };

function readCard(raw: unknown): ClosingCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? scrub(r.title).trim() : "";
  const handle = typeof r.handle === "string" ? scrub(r.handle).trim() : "";
  if (!title || !handle) return null;
  return { title: capText(title, NAME_CAP), handle: handle.slice(0, HANDLE_CAP) };
}

/** The evidence off the wire, or null when anything a person would need is
 *  missing — `spawn::travels` is the same reading in Rust, on the machine the
 *  close would happen on. Strict in the direction that refuses, like
 *  `readRemoval`: `why` may be absent (null) and is never half-there. */
export function readClosing(raw: unknown): Closing | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const machine = typeof r.machine === "string" ? scrub(r.machine).trim() : "";
  const card = readCard(r.card);
  const by = readCard(r.by);
  if (!machine || !card || !by) return null;
  let why: string | null = null;
  if (r.why !== null && r.why !== undefined) {
    why = typeof r.why === "string" ? scrub(r.why).trim() : "";
    if (!why) return null;
    why = capText(why, REASON_CAP);
  }
  let timeline: string | null = null;
  if (r.timeline !== null && r.timeline !== undefined) {
    const t = typeof r.timeline === "string" ? scrub(r.timeline).trim() : "";
    if (!t) return null;
    timeline = capText(t, REASON_CAP);
  }
  return { machine: capText(machine, NAME_CAP), card, by, why, timeline };
}

/** The closes a card is parked on, for its digest: Volery's own questions
 *  (`ours`) carrying readable evidence, and nothing else. */
export function closingsOf(
  asks: readonly { askId: string; since: number; ours: boolean; close?: Closing | null }[],
): DigestClosing[] {
  return asks.flatMap((a) =>
    a.ours && a.close ? [{ askId: a.askId, since: a.since, closing: a.close }] : [],
  );
}

/** Closes off the wire. One whose evidence cannot be read is dropped — it is
 *  not drawn at all rather than drawn as less. */
export function readClosings(raw: unknown): DigestClosing[] {
  if (!Array.isArray(raw)) return [];
  const out: DigestClosing[] = [];
  for (const a of raw.slice(0, 4)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const askId = typeof r.askId === "string" ? scrub(r.askId).trim().slice(0, 80) : "";
    const since = typeof r.since === "number" && Number.isFinite(r.since) ? r.since : null;
    const closing = readClosing(r.closing);
    if (askId && since !== null && closing) out.push({ askId, since, closing });
  }
  return out;
}

/** The question this wall draws for a close parked on `host` — or null, and it
 *  is not drawn, when the evidence names a different machine.
 *
 *  Composed from the fields alone, as `removalHere` is. The machine leads, in
 *  the header and the first line: the thing a local confirmation cannot get
 *  wrong is which wall the card is on, and this one can. */
export function closingHere(c: Closing, host: string): AskQuestion[] | null {
  if (!host || c.machine.toLowerCase() !== host.toLowerCase()) return null;
  const itself = c.by.handle === c.card.handle;
  const target = `**${c.card.title}** (${c.card.handle})`;
  const why = c.why ? ` It says: *${c.why}*` : " It gave no reason.";
  const lead = itself
    ? `${target}, a card on **${host}**, is asking to be closed — it says its work is done.${why}`
    : `**${c.by.title}** (${c.by.handle}), a card on **${host}**, wants to close ${target}, ` +
      `which is also on ${host} and is not a card it opened.${why}`;
  const body = [
    lead,
    ...(c.timeline
      ? [
          `It has a timeline still in flight: ${c.timeline}. Closing the card moves it to the archive ` +
            `as left unfinished, where it can be picked back up.`,
        ]
      : []),
    `Closing takes the card off ${host}'s wall and ends its process. It does not delete ` +
      `anything — the transcript stays where Claude Code wrote it and the session can be ` +
      `adopted back at any time. ${host} checks again at the moment of closing and refuses ` +
      `if the card has started work since.`,
  ].join("\n\n");
  return [
    {
      header: `close on ${host}`,
      question: body,
      options: [
        { label: CLOSE_IT, detail: `Take it off ${host}'s wall. The transcript is kept.` },
        { label: LEAVE_IT, detail: "It stays. The agent is told you said so." },
      ],
    },
  ];
}

/* ── every other confirmation ─────────────────────────────────────────── */

/* Sink `a02ecd0e`. A card on one laptop asked Lyss to approve opening a pull
 * request while she sat at the other, reading that card over the flyway — the
 * conversation reached her and the one thing she had to act on did not. Volery's
 * own questions were excluded from the flyway by default and each that crossed
 * was its own piece of work (removals, then closes, above), so every confirmation
 * written after those was silently local. Her words: *"almost everything should
 * travel across the flyway, by design, we shouldn't have to special case it."*
 *
 * So there is one generic block, written by `ask::Confirm` beside every question
 * Volery composes and stamped on at park — a confirmation cannot be parked without
 * one unless it names why it stays (`ask::Stay`). This file reads it and draws it,
 * knowing no kind: a confirmation added next month crosses with nothing here
 * changed. The removal and close readers above are kept because they are richer
 * and because a wall a build older than this sends only those. */

/** The most facts one confirmation carries — `ask::FACTS_CAP`. */
export const CONFIRM_FACTS_CAP = 16;
const FACT_CAP = 4_000;
const ACT_CAP = 200;
const LABEL_CAP = 80;

/** `ask::Confirm::block`, as the question carries it. */
export type Confirm = {
  /** The flyway name of the machine the question is parked on and acted on. */
  machine: string;
  /** What is being decided, as the header names it: *open a pull request*. */
  act: string;
  facts: { label: string; value: string }[];
  /** What the card said, or null. */
  why: string | null;
  /** What it costs and who sees it, or null. */
  stakes: string | null;
  /** The question's own options — the exact labels the owning wall's settle
   *  reads a yes from, so a click here is the button there. */
  options: { label: string; detail: string | null }[];
};

/** A confirmation a card is parked on, as it travels. */
export type DigestConfirm = { askId: string; since: number; confirm: Confirm };

function said(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = scrub(v).trim();
  return s ? s : null;
}

/** `null`, or a non-empty string; anything else is a malformed field. */
function optional(v: unknown, cap: number): { ok: true; v: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, v: null };
  const s = said(v);
  return s === null ? { ok: false } : { ok: true, v: capText(s, cap) };
}

/** The block off the wire, or null when anything a person would need is
 *  missing — `ask::confirm_travels` is the same reading in Rust, on the machine
 *  that would act, and `test/fixtures/confirm.json` holds the two to one corpus.
 *  Strict in the direction that refuses, as `readRemoval` is: a confirmation
 *  drawn with a hole in it is a question about less than it appears to be. */
export function readConfirm(raw: unknown): Confirm | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const machine = said(r.machine);
  const act = said(r.act);
  if (!machine || !act) return null;
  if (!Array.isArray(r.facts) || !r.facts.length || r.facts.length > CONFIRM_FACTS_CAP) return null;
  const facts: Confirm["facts"] = [];
  for (const f of r.facts) {
    if (!f || typeof f !== "object") return null;
    const x = f as Record<string, unknown>;
    const label = said(x.label);
    const value = said(x.value);
    if (!label || !value) return null;
    facts.push({ label: capText(label, LABEL_CAP), value: capText(value, FACT_CAP) });
  }
  if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > 4) return null;
  const options: Confirm["options"] = [];
  for (const o of r.options) {
    if (!o || typeof o !== "object") return null;
    const x = o as Record<string, unknown>;
    const label = said(x.label);
    if (!label) return null;
    const detail = said(x.detail);
    options.push({ label: capText(label, ACT_CAP), detail: detail ? capText(detail, 400) : null });
  }
  const why = optional(r.why, REASON_CAP);
  const stakes = optional(r.stakes, REASON_CAP);
  if (!why.ok || !stakes.ok) return null;
  return { machine: capText(machine, NAME_CAP), act: capText(act, ACT_CAP), facts, why: why.v, stakes: stakes.v, options };
}

/** The confirmations a card is parked on, for its digest: every question Volery
 *  composed carrying a readable block — **except one already travelling as a
 *  removal or a close**, which a wall of the build before this reads only in
 *  those fields. A wall of this build draws it from there too (`#sheets` keeps
 *  the first sheet per ask), so publishing it twice would only cost bytes. */
export function confirmsOf(
  asks: readonly {
    askId: string;
    since: number;
    ours: boolean;
    confirm?: Confirm | null;
    remove?: Removal | null;
    close?: Closing | null;
  }[],
): DigestConfirm[] {
  return asks.flatMap((a) =>
    a.ours && a.confirm && !a.remove && !a.close ? [{ askId: a.askId, since: a.since, confirm: a.confirm }] : [],
  );
}

/** Confirmations off the wire. One whose block cannot be read is dropped — not
 *  drawn at all rather than drawn as less. */
export function readConfirms(raw: unknown): DigestConfirm[] {
  if (!Array.isArray(raw)) return [];
  const out: DigestConfirm[] = [];
  for (const a of raw.slice(0, 6)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const askId = typeof r.askId === "string" ? scrub(r.askId).trim().slice(0, 80) : "";
    const since = typeof r.since === "number" && Number.isFinite(r.since) ? r.since : null;
    const confirm = readConfirm(r.confirm);
    if (askId && since !== null && confirm) out.push({ askId, since, confirm });
  }
  return out;
}

/** The question this wall draws for a confirmation parked on `host` — or null,
 *  and it is not drawn, when the block names a different machine.
 *
 *  Composed from the fields alone, never from the owning wall's prose, which is
 *  written from that machine's point of view and says *here* about a place that
 *  is not here. The machine leads, in the header the peek prints and in the
 *  first line, and the last line says the one thing every kind shares: nothing
 *  happens on this machine, and that one checks again when the answer arrives. */
export function confirmHere(c: Confirm, host: string, card: string): AskQuestion[] | null {
  if (!host || c.machine.toLowerCase() !== host.toLowerCase()) return null;
  const who = card.trim() ? `**${card.trim()}**, a card on **${host}**,` : `A card on **${host}**`;
  const body = [
    `${who} wants to **${c.act}**.`,
    c.facts.map((f) => `- **${f.label}**: ${f.value.includes("\n") ? f.value.replace(/\n/g, "\n  ") : f.value}`).join("\n"),
    ...(c.why ? [`Its reason: *${c.why}*`] : []),
    ...(c.stakes ? [c.stakes] : []),
    `Nothing happens on this machine. If you say yes, ${host} does it — as it would if you had ` +
      `pressed the button there — and checks again at that moment.`,
  ].join("\n\n");
  return [{ header: `${c.act} on ${host}`, question: body, options: c.options.map((o) => ({ ...o })) }];
}

/* ── notices ──────────────────────────────────────────────────────────── */

/** `notice::AFAR_PREFIX` and `AFAR_ACK`, which the owning wall reads. */
export const NOTICE_AFAR_PREFIX = "notice:";
export const NOTICE_AFAR_ACK = "acknowledged";

/** A notice's text as it travels. Generous — a closing summary is the reading
 *  — and bounded, because one wall must not make another hold an unbounded
 *  string per card. The owning wall's own row is clipped at 12,000. */
export const NOTICE_TEXT_CAP = 6_000;
export const NOTICES_CAP = 6;

/** A notice in a card's queue, as it travels. */
export type DigestNotice = {
  id: string;
  kind: NoticeKind;
  text: string;
  /** On the owning wall's clock — subtracted only from the snapshot's `at`. */
  raisedAt: number;
  /** Set while the notice holds its card's turn open: then it is answered
   *  like a parked question, by this id, into the call. */
  askId: string | null;
};

const KINDS: readonly NoticeKind[] = ["done", "question", "error", "card"];

/** A card's notices for its digest, oldest first. */
export function noticesOf(notices: readonly Notice[], card: string): DigestNotice[] {
  return notices
    .filter((n) => n.conversationId === card)
    .slice(0, NOTICES_CAP)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      text: capText(n.text, NOTICE_TEXT_CAP),
      raisedAt: n.raisedAt,
      askId: n.askId ?? null,
    }));
}

/** Notices off the wire. A notice with no id is nothing anybody could take
 *  down; an unknown kind reads as `done`, the one that claims least. */
export function readNotices(raw: unknown): DigestNotice[] {
  if (!Array.isArray(raw)) return [];
  const out: DigestNotice[] = [];
  for (const n of raw.slice(0, NOTICES_CAP)) {
    if (!n || typeof n !== "object") continue;
    const r = n as Record<string, unknown>;
    const id = typeof r.id === "string" ? scrub(r.id).trim().slice(0, 80) : "";
    const raisedAt = typeof r.raisedAt === "number" && Number.isFinite(r.raisedAt) ? r.raisedAt : null;
    if (!id || raisedAt === null) continue;
    const askId = typeof r.askId === "string" ? scrub(r.askId).trim().slice(0, 80) : "";
    out.push({
      id,
      kind: KINDS.includes(r.kind as NoticeKind) ? (r.kind as NoticeKind) : "done",
      text: typeof r.text === "string" ? capText(r.text, NOTICE_TEXT_CAP) : "",
      raisedAt,
      askId: askId || null,
    });
  }
  return out;
}

/** A travelled notice as this wall's `Notice.svelte` draws one. Keyed on the
 *  shadow, so it can never be mistaken for a row of this wall's own queue, and
 *  `raisedAt` put on this wall's clock by the caller (`askedAt`'s arithmetic). */
export function noticeHere(n: DigestNotice, shadowId: string, raisedAt: number): Notice {
  return {
    id: `${shadowId}:${n.id}`,
    conversationId: shadowId,
    kind: n.kind,
    text: n.text,
    raisedAt,
    away: false,
    waited: false,
    ...(n.askId ? { askId: n.askId } : {}),
  };
}

/** What taking a notice down from here sends: what it answers, and the text.
 *
 *  A notice holding its card's turn open is a parked call, so it is answered
 *  by its ask id with exactly what the owning wall's dock would have sent
 *  (`parkedReply`). Any other names itself with the prefix, and the text is the
 *  reply as typed — the owning wall composes the follow-up there
 *  (`followUpText`) — or `NOTICE_AFAR_ACK` for taking it down without a word. */
export function noticeAnswer(n: DigestNotice, reply = ""): { answers: string; text: string } {
  const said = reply.trim();
  if (n.askId) return { answers: n.askId, text: parkedReply(said) };
  return { answers: `${NOTICE_AFAR_PREFIX}${n.id}`, text: said || NOTICE_AFAR_ACK };
}

/** The notice an arriving answer names, if it names one. */
export function noticeOf(answers: string | null | undefined): string | null {
  if (!answers?.startsWith(NOTICE_AFAR_PREFIX)) return null;
  return answers.slice(NOTICE_AFAR_PREFIX.length).trim() || null;
}

/** Notices on other walls, in the attention ladder's words — one row per card,
 *  its newest, exactly as `App.svelte` makes this wall's own; and none for a
 *  card that has a question open, which `remoteQuestions` already rang for, as
 *  a local card with a pending ask has no notice row. `notices` is the shadow's
 *  own reading, so a notice whose wall has gone quiet is not news. */
export function remoteNotices(
  shadows: readonly {
    id: string;
    host: string;
    project: string;
    title: string;
    open: readonly unknown[];
    notices: readonly Notice[];
  }[],
  now: number,
): {
  id: string;
  key: string;
  project: string;
  title: string;
  kind: "notice";
  detail: string;
  waitedSeconds: number;
}[] {
  return shadows.flatMap((s) => {
    const n = s.notices[s.notices.length - 1];
    if (!n || s.open.length) return [];
    return [
      {
        id: s.id,
        key: n.id,
        project: `${s.project} · on ${s.host}`,
        title: nameBesideProject(s.title),
        kind: "notice" as const,
        detail: `${noticeWords(n).mark.toLowerCase()} — ${noticeLine(n.text)}`,
        waitedSeconds: Math.max(0, Math.floor((now - n.raisedAt) / 1000)),
      },
    ];
  });
}

/* ── the pile ─────────────────────────────────────────────────────────── */

/** `presence::AFAR_PREFIX`, which the owning wall reads: an answer naming a
 *  row in its pile — a question filed while she was away everywhere — rather
 *  than a parked call (sinks `52c0affa`, `3368f78f`). `test/filed.test.ts`
 *  reads it out of the Rust so the two cannot drift. */
export const PILE_AFAR_PREFIX = "deferred:";

/** What "not worth answering" sends: the owning wall takes the row off its
 *  pile and tells the card nothing, as the button does there. Read only by a
 *  wall that knows the prefix — an older one refuses the whole answer as no
 *  longer waiting, since nothing it holds is parked under that id. */
export const PILE_DROP = "not worth answering";

/** What an answer to a filed question names on the prompt wire. */
export function pileAnswer(row: string): string {
  return `${PILE_AFAR_PREFIX}${row}`;
}

/** An answer to another wall's filed question, given while that wall was not
 *  heard from, and held here until it is.
 *
 *  **The one thing on the prompt wire that waits for a wall to come back**, and
 *  the asymmetry is the point. A prompt, an answer to a *parked* question and
 *  every confirmation are refused into a quiet wall (`elsewhere.md`, *refused
 *  now, never queued for later*): each is only worth delivering while somebody
 *  is waiting on it, and a lid lifted eight hours later would deliver something
 *  you have since changed your mind about. A filed question is the opposite
 *  case by construction — the card was told the answer comes later, as a new
 *  message, whenever you get to it — so holding the answer is exactly what was
 *  promised. What makes it safe is the claim on the owning wall: the row is
 *  taken before the answer is sent, so an answer from here that arrives after
 *  one given there is refused rather than delivered twice.
 *
 *  Words only. A picture can be megabytes, and a held answer is kept across a
 *  restart of this wall, in `localStorage`; one that carries attachments to a
 *  quiet wall is refused with its sheet left filled in. */
export type HeldAnswer = {
  /** The prompt's request id, minted once and reused for every try — what
   *  makes a resend after a lost reply one answer rather than two. */
  id: string;
  host: string;
  /** The card's id on its own wall. */
  card: string;
  /** The pile row it answers. */
  row: string;
  text: string;
  /** The question's header, for the line that says what it answered. */
  about: string;
  /** This wall's clock when it was given. */
  at: number;
};

/** As many as are kept: eight a card, for a handful of cards, with room. */
export const HELD_CAP = 64;

/** Held answers back out of storage. Anything malformed is dropped rather than
 *  sent: a held answer is something a person wrote, and a guess at one is not. */
export function readHeld(raw: unknown): HeldAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: HeldAnswer[] = [];
  const word = (v: unknown, cap: number) => (typeof v === "string" ? scrub(v).trim().slice(0, cap) : "");
  for (const h of raw.slice(0, HELD_CAP)) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const id = word(r.id, 80);
    const host = word(r.host, 200);
    const card = word(r.card, 80);
    const row = word(r.row, 80);
    const text = typeof r.text === "string" ? r.text : "";
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null;
    if (!id || !host || !card || !row || !text.trim() || at === null) continue;
    if (out.some((x) => x.host === host && x.card === card && x.row === row)) continue;
    out.push({ id, host, card, row, text, about: word(r.about, 300) || "a question", at });
  }
  return out;
}

/** A wall has just been heard: which of the answers held for it go now, and
 *  which have nothing left to answer.
 *
 *  `filed` is what that wall's own snapshot says each card still has in its
 *  pile, keyed `card\nrow`. A row still filed is sent; a row no longer filed
 *  was answered there, or from a third wall, or its card is gone — and an
 *  answer sent to it would only be refused, so it is let go and said. Only off
 *  a snapshot the wall itself sent: a stored copy says nothing about now. */
export function heldDue(
  held: readonly HeldAnswer[],
  host: string,
  filed: ReadonlySet<string>,
): { send: HeldAnswer[]; gone: HeldAnswer[] } {
  const send: HeldAnswer[] = [];
  const gone: HeldAnswer[] = [];
  for (const h of held) {
    if (h.host !== host) continue;
    (filed.has(`${h.card}\n${h.row}`) ? send : gone).push(h);
  }
  return { send, gone };
}

/** Why an answer to one of this wall's filed questions, arriving from another
 *  wall, cannot be taken — or null when it can. Pure over what the pile holds,
 *  so the one judgement both walls depend on is asserted without either: the
 *  row has to be in this wall's pile **and** belong to the card the answer was
 *  addressed to. The claim that follows is what stops a second answer; this is
 *  what stops an answer reaching the wrong card. */
export function pileRefusal(
  pile: readonly { id: string; conversationId: string }[],
  card: string,
  row: string,
  me: string,
): string | null {
  const d = pile.find((x) => x.id === row);
  if (!d) {
    return `that question is no longer waiting on ${me || "that wall"} — it was answered there or from another wall, or its card has gone`;
  }
  if (d.conversationId !== card) return "that question belongs to another card on that wall";
  return null;
}
