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
 *    before a permanent delete. The one of Volery's three own questions that
 *    crosses (close and unpost stay where they are), and only with evidence.
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

/** `remove::MAX_PATHS`: a confirmation listing more is one nobody reads. */
export const REMOVAL_TARGETS_CAP = 8;
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
};

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
  return lines.join("\n");
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
    ...r.targets.map((t) => described(t, host)),
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
