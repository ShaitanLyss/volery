/* Whether there is a newer Volery, and what to say about it.
 *
 * Pure, and tested directly (`test/update.test.ts`). The same split `limits.ts`
 * draws against `limits.rs`: Rust asks GitHub and this decides what the answer
 * means. Every judgement worth arguing about is here — is that tag newer, can
 * that asset actually be installed, is a prerelease something to offer — and an
 * argument is worth having against tests.
 *
 * The one rule underneath all of it: **when in doubt, offer nothing.** An update
 * that is not offered costs a person one manual download some other day. An
 * update offered wrongly downloads four megabytes and closes a wall with twenty
 * cards on it. So an unparseable version, a missing installer and an unreadable
 * answer all come out the same way, which is silence. */

/** What `update.rs` answers with. Mirrors `update::Latest`. */
export type Latest = {
  running: string;
  tag: string;
  name: string;
  notes: string;
  assets: { name: string; url: string; size: number }[];
};

/** An update worth offering: the version, and the file that would install it. */
export type Offer = {
  version: string;
  /** The tag as GitHub spells it, for the release link. */
  tag: string;
  url: string;
  size: number;
};

/** A version as three numbers, or null for one nothing should be ordered by.
 *
 *  Deliberately strict about what it will parse and deliberately silent about
 *  what it will not. `0.6.1` and `v0.6.1` are the same version; `0.7.0-rc.1` is
 *  **not** parsed at all, and that is the prerelease policy in one line — a tag
 *  carrying anything after the numbers is one somebody marked as not-quite, and
 *  a wall that closed itself to install a release candidate would be doing
 *  something nobody asked for. If prereleases ever want offering, they want
 *  offering *as* prereleases, with the word on the button. */
export function parseVersion(s: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  if (parts.some((n) => !Number.isSafeInteger(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Is `tag` a later version than `running`?
 *
 *  False when either is unparseable, which is the doubt rule: a build whose own
 *  `CARGO_PKG_VERSION` cannot be read is not a build that should be replacing
 *  itself on the strength of a comparison it could not make.
 *
 *  Strictly later, so re-running the same version is never offered. Equal is not
 *  newer and neither is older — an older tag means somebody pulled a release,
 *  and rolling a wall *backwards* without being asked is worse than doing
 *  nothing. */
export function isNewer(tag: string, running: string): boolean {
  const a = parseVersion(tag);
  const b = parseVersion(running);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

/** The asset that can actually be installed, or null.
 *
 *  The NSIS `-setup.exe` and nothing else, because it is the only artifact this
 *  app knows how to *drive*: `update.rs`'s `INSTALL_ARGS` are flags that
 *  installer parses out of its own command line. The MSI beside it on every
 *  release would need `msiexec` and a different argument vocabulary, and an
 *  updater that downloaded one and then could not run it quietly would be worse
 *  than one that never offered.
 *
 *  Matched on the shape of the name rather than on the product name, so the
 *  rename from Skein did not have to be a release nobody could update from —
 *  and the next one will not either. */
export function pickInstaller(
  assets: { name: string; url: string; size: number }[],
): { name: string; url: string; size: number } | null {
  return (
    assets.find((a) => /-setup\.exe$/i.test(a.name) && a.url.startsWith("https://")) ?? null
  );
}

/** What, if anything, to offer — the whole decision in one function.
 *
 *  Everything the wall draws comes through here, so there is one place that can
 *  say no and one place a test can ask. */
export function offerFrom(latest: Latest | null): Offer | null {
  if (!latest) return null;
  if (!isNewer(latest.tag, latest.running)) return null;
  const asset = pickInstaller(latest.assets);
  if (!asset) return null;
  const version = latest.tag.trim().replace(/^v/, "");
  return { version, tag: latest.tag.trim(), url: asset.url, size: asset.size };
}

/** The line on the button. Lowercase and quiet, like everything else up there. */
export function sayOffer(offer: Offer): string {
  return `update to ${offer.version}`;
}

/** How far the download has got, as something to read rather than a percentage
 *  nobody asked for.
 *
 *  Megabytes, one decimal, because that is the unit an installer is described in
 *  and a percentage of an unknown total is a bar that lies. A `total` of zero is
 *  a server that sent no `Content-Length`, and then only the amount so far is
 *  honest. */
export function sayProgress(got: number, total: number): string {
  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  if (total > 0) return `downloading ${mb(got)} of ${mb(total)} MB`;
  return `downloading ${mb(got)} MB`;
}

/** What the wall says once the installer is on disk and armed.
 *
 *  It has to say that Volery is going to *close*, because it is, and a wall that
 *  vanished mid-turn with no warning would be indistinguishable from a crash.
 *  The restart is promised because `INSTALL_ARGS` genuinely asks for it. */
export const READY_LINE =
  "ready — volery will close, install, and come back up";

/** Where the release itself is, for somebody who would rather read first. */
export function releaseUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

/* ── Whether to go on asking ──────────────────────────────────────────────── */

/** What is happening, for the header to draw one thing at a time.
 *
 *  Here rather than in `release.svelte.ts` because the two rules below turn on
 *  it, and this is the file that holds every judgement about an update. */
export type Stage = "quiet" | "offered" | "fetching" | "armed" | "failed";

/** Every stage there is, so a rule over them can be tested exhaustively rather
 *  than at the two values somebody happened to think of. */
export const STAGES: Stage[] = ["quiet", "offered", "fetching", "armed", "failed"];

/** Is the question still open?
 *
 *  One predicate doing two jobs, because they are one idea. It decides whether
 *  to ask GitHub again, and it decides whether an answer may be written onto the
 *  header — and the second is the one with teeth. A reply can be in flight when
 *  you press the button, so an answer landing a moment later must not put
 *  `offered` back over a download that has already started, or the header would
 *  offer you an update you are three megabytes into fetching.
 *
 *  Every stage but `quiet` is closed, each for its own reason: `offered` already
 *  says the thing another ask could only say again, `fetching` and `armed` are
 *  past deciding, and `failed` is a button you pressed that did not work — which
 *  asking again cannot mend, since the offer is still in hand and the version you
 *  are on is still the one you have.
 *
 *  Note `quiet` covers the interesting failure too: no network, GitHub down, a
 *  rate limit. Those leave the stage alone, so the question stays open and the
 *  next ask picks it up — which is the one thing asking once a launch could never
 *  do. A wall opened on a train used to be a wall that never checked again. */
export function unanswered(stage: Stage): boolean {
  return stage === "quiet";
}
