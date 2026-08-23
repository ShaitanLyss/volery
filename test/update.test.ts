import { expect, test, describe } from "bun:test";
import {
  isNewer,
  offerFrom,
  parseVersion,
  pickInstaller,
  READY_LINE,
  sayOffer,
  sayProgress,
  STAGES,
  unanswered,
  type Latest,
  type Stage,
} from "../src/lib/update";

/* Whether there is a newer Volery, and whether to say so.
 *
 * The asymmetry is the thing to keep in mind reading these: not offering an
 * update costs somebody one manual download some other day, and offering one
 * wrongly downloads four megabytes and closes a wall with twenty working cards
 * on it. So nearly every test below is about a reason to stay quiet. */

const assets = (...names: string[]) =>
  names.map((name) => ({
    name,
    url: `https://github.com/ShaitanLyss/volery/releases/download/v0.7.0/${name}`,
    size: 4_308_099,
  }));

const said = (over: Partial<Latest> = {}): Latest => ({
  running: "0.6.1",
  tag: "v0.7.0",
  name: "Volery v0.7.0",
  notes: "",
  assets: assets("Volery_0.7.0_x64-setup.exe", "Volery_0.7.0_x64_en-US.msi"),
  ...over,
});

describe("reading a version", () => {
  test("with or without the v, which is a tag and a version of one thing", () => {
    expect(parseVersion("0.6.1")).toEqual([0, 6, 1]);
    expect(parseVersion("v0.6.1")).toEqual([0, 6, 1]);
    expect(parseVersion("  v1.20.3 ")).toEqual([1, 20, 3]);
  });

  /* The prerelease policy, in the one place it is implemented: a tag somebody
     marked as not-quite is a tag this refuses to order, so nothing downstream
     can offer it. Closing a wall to install a release candidate is not a thing
     to do without being asked for it by name. */
  test("anything after the numbers is not a version this will order", () => {
    expect(parseVersion("0.7.0-rc.1")).toBeNull();
    expect(parseVersion("0.7.0-beta")).toBeNull();
    expect(parseVersion("0.7.0+build.4")).toBeNull();
  });

  test("nor is anything that is not three numbers", () => {
    expect(parseVersion("0.7")).toBeNull();
    expect(parseVersion("nightly")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
  });
});

describe("is it newer", () => {
  test("later in any position", () => {
    expect(isNewer("v0.7.0", "0.6.1")).toBe(true);
    expect(isNewer("v0.6.2", "0.6.1")).toBe(true);
    expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
  });

  /* Ten is later than nine, which a string comparison gets wrong and which is
     the whole reason this parses rather than compares text. */
  test("ten is later than nine", () => {
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.9.0", "0.10.0")).toBe(false);
  });

  test("the same version is not newer, so nothing re-installs itself", () => {
    expect(isNewer("v0.6.1", "0.6.1")).toBe(false);
  });

  /* An older tag means somebody pulled a release. Rolling the wall backwards
     unasked is worse than doing nothing at all. */
  test("an older tag is never offered", () => {
    expect(isNewer("v0.5.0", "0.6.1")).toBe(false);
  });

  /* A build that cannot read its own version has no business replacing itself
     on the strength of a comparison it could not make. */
  test("doubt on either side is silence", () => {
    expect(isNewer("v0.7.0", "nightly")).toBe(false);
    expect(isNewer("main", "0.6.1")).toBe(false);
    expect(isNewer("", "")).toBe(false);
  });
});

describe("which file could actually install it", () => {
  /* The NSIS installer and only it: `update.rs`'s INSTALL_ARGS are flags that
     installer parses out of its own command line, and the MSI beside it on
     every release wants msiexec and a different vocabulary. Downloading one it
     cannot drive quietly would be worse than not offering. */
  test("the nsis setup, never the msi beside it", () => {
    const picked = pickInstaller(said().assets);
    expect(picked?.name).toBe("Volery_0.7.0_x64-setup.exe");
  });

  test("no installer at all means no offer", () => {
    expect(pickInstaller(assets("Volery_0.7.0_x64_en-US.msi"))).toBeNull();
    expect(pickInstaller([])).toBeNull();
  });

  /* Matched on the shape of the name and not on the product name, so the rename
     from Skein did not leave a release nobody could update from — and the next
     rename will not either. */
  test("a release built under the old name is still installable", () => {
    expect(pickInstaller(assets("Skein_0.6.1_x64-setup.exe"))?.name).toBe(
      "Skein_0.6.1_x64-setup.exe",
    );
  });

  test("an asset that is not fetched over https is not fetched", () => {
    expect(
      pickInstaller([
        { name: "Volery_0.7.0_x64-setup.exe", url: "http://example.com/x.exe", size: 1 },
      ]),
    ).toBeNull();
  });
});

describe("what the wall is offered", () => {
  test("a newer release with an installer on it", () => {
    const offer = offerFrom(said());
    expect(offer).not.toBeNull();
    expect(offer!.version).toBe("0.7.0");
    expect(offer!.tag).toBe("v0.7.0");
    expect(offer!.url).toContain("-setup.exe");
    expect(sayOffer(offer!)).toBe("update to 0.7.0");
  });

  /* Every reason to stay quiet, through the one function the wall calls. */
  test("and nothing at all in every other case", () => {
    expect(offerFrom(null)).toBeNull();
    expect(offerFrom(said({ tag: "v0.6.1" }))).toBeNull();
    expect(offerFrom(said({ tag: "v0.5.0" }))).toBeNull();
    expect(offerFrom(said({ tag: "v0.7.0-rc.1" }))).toBeNull();
    expect(offerFrom(said({ running: "nightly" }))).toBeNull();
    expect(offerFrom(said({ assets: assets("Volery_0.7.0_x64_en-US.msi") }))).toBeNull();
    expect(offerFrom(said({ assets: [] }))).toBeNull();
  });
});

describe("what it says while it works", () => {
  test("megabytes, because that is the unit an installer is described in", () => {
    expect(sayProgress(1_048_576, 4_194_304)).toBe("downloading 1.0 of 4.0 MB");
  });

  /* No Content-Length is a total nobody knows, and a percentage of an unknown
     total is a bar that lies. */
  test("an unknown total says only what has arrived", () => {
    expect(sayProgress(2_097_152, 0)).toBe("downloading 2.0 MB");
  });

  /* The wall is about to vanish, and a wall that vanished mid-turn with no
     warning is indistinguishable from a crash. */
  test("the ready line says the app is going to close", () => {
    expect(READY_LINE).toContain("close");
    expect(READY_LINE).toContain("come back");
  });
});

describe("unanswered", () => {
  test("only a quiet header is still asking", () => {
    expect(unanswered("quiet")).toBe(true);
    for (const s of STAGES.filter((x) => x !== "quiet")) {
      expect(unanswered(s)).toBe(false);
    }
  });

  /* The one with teeth. A reply can be in flight when the button is pressed, and
     an answer landing a moment later must not put `offered` back over a download
     already three megabytes in. */
  test("a reply arriving mid-download may not write an offer", () => {
    expect(unanswered("fetching")).toBe(false);
    expect(unanswered("armed")).toBe(false);
  });

  /* Asking again cannot mend a download that broke: the offer is still in hand
     and the version you are on is still the one you have. */
  test("a failed download is not a reason to keep asking", () => {
    expect(unanswered("failed")).toBe(false);
  });

  /* Exhaustive on purpose — a stage added later must be *decided* about rather
     than falling into "keep asking" because nobody looked. */
  test("every stage is accounted for", () => {
    expect(STAGES).toHaveLength(5);
    const open = STAGES.filter(unanswered);
    expect(open).toEqual(["quiet"]);
  });

  /* A network failure leaves the stage alone, which is what makes a wall opened
     with no signal one that checks again rather than one that never does. */
  test("a failure to reach github leaves the question open", () => {
    const afterNetworkFailure: Stage = "quiet";
    expect(unanswered(afterNetworkFailure)).toBe(true);
  });
});
