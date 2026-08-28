import { expect, test, describe } from "bun:test";
import {
  applyEvent,
  canControl,
  describe as describeState,
  emptyState,
  formatDuration,
  joinArtists,
  normalizeConfig,
  LAYOUTS,
  positionAt,
  progressAt,
  sayHit,
  sayResults,
  worthSearching,
  volumeFromWire,
  volumeToWire,
  type SpotifyState,
  type SpotifyTrack,
} from "../src/lib/spotify";
/* Deliberately reaching into the catalogue: the key `normalizeConfig` reads is
   a contract with `widgets.ts`, and a test that restates it by hand is a test
   that cannot notice the two disagreeing. */
import {
  VARIANT,
  defaultConfig,
  newWidget,
  normalizeWidget,
  optionFor,
  paramsOf,
  specFor,
} from "../src/lib/widgets";

const track = (over: Partial<SpotifyTrack> = {}): SpotifyTrack => ({
  id: "spotify:track:1",
  name: "Cirrus",
  artists: ["Bonobo"],
  album: "The North Borders",
  durationMs: 300_000,
  art: null,
  explicit: false,
  kind: "track",
  ...over,
});

/** A state that is playing, stamped at `t`. */
const playing = (t = 1000, over: Partial<SpotifyState> = {}): SpotifyState => ({
  ...emptyState(),
  phase: "playing",
  track: track(),
  positionMs: 0,
  since: t,
  ...over,
});

describe("where the playhead is", () => {
  /* librespot only speaks on transitions, so every reading between two of them
     is arithmetic against the wall clock. This is the whole reason nothing here
     polls, and therefore the part most worth pinning down. */

  test("a playing track advances with the clock", () => {
    const s = playing(1000);
    expect(positionAt(s, 1000)).toBe(0);
    expect(positionAt(s, 6000)).toBe(5000);
  });

  test("a paused track does not move, however long you look at it", () => {
    const s: SpotifyState = { ...playing(1000), phase: "paused", positionMs: 42_000, since: null };
    expect(positionAt(s, 6000)).toBe(42_000);
    expect(positionAt(s, 9_000_000)).toBe(42_000);
  });

  test("the playhead never runs past the end of the track", () => {
    /* The honest residue of interpolating: a track that ends while nothing is
       listening would otherwise report a position its own duration does not
       contain, and the progress bar would leave the box. */
    const s = playing(0);
    expect(positionAt(s, 999_999_999)).toBe(300_000);
    expect(progressAt(s, 999_999_999)).toBe(1);
  });

  test("a clock that went backwards does not rewind the track", () => {
    const s = playing(5000);
    expect(positionAt(s, 4000)).toBe(0);
  });

  test("progress is zero when there is nothing to be along", () => {
    expect(progressAt(emptyState(), 1234)).toBe(0);
    expect(progressAt({ ...playing(0), track: track({ durationMs: 0 }) }, 5000)).toBe(0);
  });
});

describe("folding librespot's events", () => {
  test("playing stamps the clock, pausing unstamps it", () => {
    const a = applyEvent(emptyState(), { kind: "track", track: track() }, 0);
    const b = applyEvent(a, { kind: "playing", positionMs: 0 }, 1000);
    expect(b.phase).toBe("playing");
    expect(b.since).toBe(1000);

    const c = applyEvent(b, { kind: "paused", positionMs: 5000 }, 6000);
    expect(c.phase).toBe("paused");
    expect(c.since).toBeNull();
    expect(c.positionMs).toBe(5000);
  });

  /* The bug this guards. A `seeked` says where the playhead is and says nothing
     about whether it is moving — so restamping `since` unconditionally would
     start a *paused* track advancing on screen, under a pause button, with the
     audio silent. Scrubbing while paused is exactly how you would find it. */
  test("seeking while paused does not start the track moving", () => {
    const paused: SpotifyState = { ...playing(1000), phase: "paused", since: null };
    const after = applyEvent(paused, { kind: "seeked", positionMs: 90_000 }, 7000);
    expect(after.positionMs).toBe(90_000);
    expect(after.since).toBeNull();
    expect(positionAt(after, 60_000)).toBe(90_000);
  });

  test("seeking while playing restamps, so the new position is the one that advances", () => {
    const after = applyEvent(playing(1000), { kind: "seeked", positionMs: 90_000 }, 7000);
    expect(after.since).toBe(7000);
    expect(positionAt(after, 9000)).toBe(92_000);
  });

  test("a new track pins the playhead at zero and leaves it still", () => {
    /* The `track` event arrives before the first `playing`. Carrying the old
       position over would show the new track already part-played. */
    const s = applyEvent(playing(1000, { positionMs: 120_000 }), { kind: "track", track: track({ id: "b", name: "Kong" }) }, 5000);
    expect(s.track?.name).toBe("Kong");
    expect(s.positionMs).toBe(0);
    expect(s.since).toBeNull();
  });

  /* The bug this guards, and it is the one a person actually reported: the
     browser leg and the session leg were one phase, so the widget went on
     saying "waiting for the browser…" through a `session.connect` that took
     four minutes to fail — with the browser long since closed and the token
     already in the vault. Two phases means the face cannot say the wrong one.
     Measured 2026-08-28; see `.claude/rules/spotify.md`. */
  test("the two legs of a sign-in are two phases", () => {
    const linking = applyEvent(emptyState(), { kind: "linking" }, 0);
    expect(linking.phase).toBe("linking");
    expect(describeState(linking)).toBe("waiting for the browser…");

    const opening = applyEvent(linking, { kind: "opening" }, 1000);
    expect(opening.phase).toBe("opening");
    expect(describeState(opening)).not.toBe(describeState(linking));

    /* Neither is a session, so neither offers a transport. */
    expect(canControl(linking)).toBe(false);
    expect(canControl(opening)).toBe(false);
  });

  /* Both in-flight legs are cleared by an outcome rather than left standing,
     which is what `spotify_start` now emits a `closed` for on every failure
     path — a `linking` nothing ever clears is a face describing a sign-in that
     stopped happening. */
  test("a failed sign-in leaves neither leg on screen", () => {
    const opening = applyEvent(
      applyEvent(emptyState(), { kind: "linking" }, 0),
      { kind: "opening" },
      1000,
    );
    const dead = applyEvent(opening, { kind: "closed", fault: "the access points did not answer" }, 2000);
    expect(dead.phase).toBe("fault");
    expect(dead.fault).toBe("the access points did not answer");

    const done = applyEvent(opening, { kind: "session", device: "volery" }, 2000);
    expect(done.phase).toBe("idle");
    expect(done.fault).toBeNull();
  });

  test("a closed session takes the track with it", () => {
    /* A track left on screen under a dead player is a set of controls that do
       nothing, which is worse than an empty box. */
    const s = applyEvent(playing(1000), { kind: "closed", fault: null }, 2000);
    expect(s.phase).toBe("off");
    expect(s.track).toBeNull();
    expect(s.since).toBeNull();
  });

  test("a closed session carrying a fault says so, and keeps it readable", () => {
    const s = applyEvent(playing(1000), { kind: "closed", fault: "spotify dropped the connection" }, 2000);
    expect(s.phase).toBe("fault");
    expect(s.fault).toBe("spotify dropped the connection");
  });

  test("stopping keeps the session but drops what was playing", () => {
    const s = applyEvent(playing(1000), { kind: "stopped" }, 2000);
    expect(s.phase).toBe("idle");
    expect(s.track).toBeNull();
  });

  test("a position past the end of the track is clamped as it lands", () => {
    const s = applyEvent(playing(0), { kind: "playing", positionMs: 900_000 }, 0);
    expect(s.positionMs).toBe(300_000);
  });

  /* `$state` invalidates readers by comparing the new value against the old, so
     a fold that mutated in place would bump nothing and the face would paint
     once and then never again — the trap CLAUDE.md records against the editor's
     grid, in a second place that could grow it. */
  test("every fold returns a fresh object", () => {
    const before = playing(1000);
    const after = applyEvent(before, { kind: "volume", volume: 32767 }, 2000);
    expect(after).not.toBe(before);
    expect(before.volume).toBe(1);
  });

  test("an event from a newer build is ignored rather than guessed at", () => {
    const before = playing(1000);
    const after = applyEvent(before, { kind: "quantum-shuffle" } as never, 2000);
    expect(after).toEqual(before);
  });

  test("shuffle and repeat are carried straight through", () => {
    let s = applyEvent(playing(1000), { kind: "shuffle", shuffle: true }, 0);
    expect(s.shuffle).toBe(true);
    s = applyEvent(s, { kind: "repeat", repeat: "track" }, 0);
    expect(s.repeat).toBe("track");
  });
});

describe("readings", () => {
  test("minutes and seconds, and an hour once there is one", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9_000)).toBe("0:09");
    expect(formatDuration(222_000)).toBe("3:42");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  test("a duration never shows a second the track has not reached", () => {
    /* Floor rather than round: 3:41.9 is still 3:41, and a reading that gets
       there first is an instrument you stop trusting. */
    expect(formatDuration(221_999)).toBe("3:41");
  });

  test("nonsense durations read as zero rather than NaN", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
  });

  test("artists join, and a long tail is counted rather than shown", () => {
    expect(joinArtists(["Bonobo"])).toBe("Bonobo");
    expect(joinArtists(["A", "B", "C"])).toBe("A, B, C");
    expect(joinArtists(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
  });

  test("empty artist names do not become empty commas", () => {
    expect(joinArtists(["Bonobo", "", "  "])).toBe("Bonobo");
    expect(joinArtists([])).toBe("");
  });

  test("the line under the controls says what is true", () => {
    expect(describeState(emptyState())).toBe("not signed in");
    expect(describeState({ ...emptyState(), phase: "idle", device: "volery" })).toBe(
      "volery — ready, nothing playing",
    );
    expect(describeState(playing(0))).toBe("Bonobo");
    expect(describeState({ ...emptyState(), phase: "fault", fault: "premium is required" })).toBe(
      "premium is required",
    );
  });

  test("a fault with nothing to say still says something", () => {
    expect(describeState({ ...emptyState(), phase: "fault", fault: null })).toBe(
      "something went wrong",
    );
  });

  test("the transport is live only when there is something to transport", () => {
    expect(canControl(emptyState())).toBe(false);
    expect(canControl({ ...emptyState(), phase: "idle" })).toBe(false);
    expect(canControl(playing(0))).toBe(true);
    expect(canControl({ ...playing(0), phase: "paused" })).toBe(true);
  });
});

describe("volume", () => {
  test("the ends are the ends", () => {
    expect(volumeFromWire(0)).toBe(0);
    expect(volumeFromWire(65535)).toBe(1);
    expect(volumeToWire(0)).toBe(0);
    expect(volumeToWire(1)).toBe(65535);
  });

  test("it survives the round trip either way round", () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(volumeFromWire(volumeToWire(v))).toBeCloseTo(v, 4);
    }
  });

  test("out of range is clamped rather than allowed into the mixer", () => {
    expect(volumeToWire(4)).toBe(65535);
    expect(volumeToWire(-1)).toBe(0);
    expect(volumeFromWire(999_999)).toBe(1);
    expect(volumeFromWire(NaN)).toBe(0);
  });
});

describe("the widget's config, read the way every opaque column is", () => {
  /* The bug this block did not catch the first time, and now cannot miss.
     `normalizeConfig` read `o.layout` while the catalogue writes `o.variant`,
     so the reading knob appeared in the right-click, persisted, and did
     nothing — falling back to "full" on every read. Everything stayed green:
     these tests passed, `widgets.test.ts` passed, `check` was clean, the widget
     drew. It was green because it asserted the same wrong key the code used,
     which is the whole lesson — a test written from the implementation proves
     the implementation agrees with itself and says nothing about the contract
     with the other side. So the first test below imports the catalogue's own
     constant rather than spelling the key out. */
  test("the key is the catalogue's, not one this file made up", () => {
    expect(VARIANT).toBe("variant");
    expect(normalizeConfig({ [VARIANT]: "bar" }).layout).toBe("bar");
  });

  test("the key the face reads is NOT the key it is stored under", () => {
    /* `layout` is the field; `variant` is the column. Reading a config keyed
       the way the face names it must not work, or the seam has drifted back. */
    expect(normalizeConfig({ layout: "bar" }).layout).toBe("full");
  });

  test("nothing at all is still drawable", () => {
    expect(normalizeConfig(undefined)).toEqual({ layout: "full", art: true, progress: true });
    expect(normalizeConfig(null)).toEqual({ layout: "full", art: true, progress: true });
  });

  test("a layout nothing can draw falls back rather than reaching the face", () => {
    expect(normalizeConfig({ variant: "hologram" }).layout).toBe("full");
  });

  test("a knob that is there is kept", () => {
    expect(normalizeConfig({ variant: "bar", art: false, progress: false })).toEqual({
      layout: "bar",
      art: false,
      progress: false,
    });
  });

  test("a knob of the wrong type does not become one", () => {
    /* This is the shape that would put `undefined` inside a frame loop. */
    expect(normalizeConfig({ art: "yes", progress: 1 })).toEqual({
      layout: "full",
      art: true,
      progress: true,
    });
  });
});

/* Written by b2de0761, who owns the catalogue, after the `layout`/`variant` bug
   above. The distinction they drew is the one that matters: the tests above
   prove `normalizeConfig` responds to `VARIANT`, and `widgets.test.ts` proves
   the catalogue offers three readings — and *neither* proves a value leaving
   that menu arrives at this face. These test the composition. */
describe("the seam between the catalogue and the face", () => {
  test("a fresh spotify widget's config is one the face can read", () => {
    expect(normalizeConfig(defaultConfig("spotify")).layout).toBe("full");
  });

  /* The readings the catalogue actually offers, asked of the catalogue rather
     than written down here — a hardcoded list is a third place to get this
     wrong, and would not notice a fourth reading appearing on either side. */
  const offered = () => {
    const spec = specFor("spotify")!;
    const param = paramsOf(spec).find((p) => p.key === VARIANT)!;
    expect(param.kind).toBe("choice");
    return (param as { options: { value: string }[] }).options.map((c) => c.value);
  };

  test("every reading the menu offers actually reaches the face", () => {
    /* The one with teeth: a real menu id, through `optionFor`, into the
       normalizer. A reading the menu offers that the face cannot draw would
       fall back to "full" in silence — here it fails. */
    const w = newWidget("spotify", 0, 0);
    for (const value of offered()) {
      const patch = optionFor(w, `cfg:${VARIANT}:${value}`);
      expect(patch).toEqual({ key: VARIANT, value });
      expect(normalizeConfig({ ...w.config, [patch!.key]: patch!.value }).layout).toBe(value);
    }
  });

  test("and the face draws no reading the menu cannot reach", () => {
    /* The other direction, which the loop above cannot see: a layout the face
       supports but nothing offers is a feature with no way to turn it on —
       the catalogue's own "a parameter with no way to reach it does not
       exist" rule, pointed the other way. */
    expect([...LAYOUTS].sort()).toEqual([...offered()].sort());
  });

  test("a reading survives the round trip through the opaque column", () => {
    /* Through `JSON.stringify` deliberately: `widget.config_json` is an opaque
       column and this round trip is what happens on every launch, not a
       hypothetical. */
    const w = newWidget("spotify", 0, 0);
    const back = normalizeWidget(
      JSON.parse(JSON.stringify({ ...w, config: { ...w.config, variant: "bar" } })),
    );
    expect(normalizeConfig(back!.config).layout).toBe("bar");
  });
});

/* ── the widget's own search ───────────────────────────────────────────────*/

describe("searching from the wall rather than from a card", () => {
  const hit = (over: Record<string, string> = {}) => ({
    kind: "track",
    uri: "spotify:track:1",
    title: "After Dark",
    by: "mikeeysmind",
    extra: "4:48",
    ...over,
  });

  test("the line under a result joins only the halves that exist", () => {
    expect(sayHit(hit())).toBe("mikeeysmind \u00b7 4:48");
    /* A playlist has no artist and a sparse track has no extra — neither may
       leave a stray separator behind, which is the whole reason this is one
       function rather than a template in the markup. */
    expect(sayHit(hit({ by: "" }))).toBe("4:48");
    expect(sayHit(hit({ extra: "" }))).toBe("mikeeysmind");
    expect(sayHit(hit({ by: "", extra: "" }))).toBe("");
    expect(sayHit(hit({ by: "   ", extra: "  " }))).toBe("");
  });

  test("an empty query is never worth a round trip", () => {
    /* Enter on an empty box is the commonest keystroke in any search field. */
    expect(worthSearching("")).toBe(false);
    expect(worthSearching("   ")).toBe(false);
    expect(worthSearching("a")).toBe(true);
    /* No opinion about length beyond emptiness: Spotify's own search language
       is rich enough that guessing at "too short" would refuse real queries. */
    expect(worthSearching("artist:coltrane year:1965")).toBe(true);
  });

  test("the results area says nothing before you have asked anything", () => {
    /* An empty box with "no results" under it is an accusation. */
    expect(sayResults("idle", 0, null)).toBeNull();
    expect(sayResults("searching", 0, null)).toBe("searching\u2026");
    expect(sayResults("done", 3, null)).toBeNull();
    expect(sayResults("done", 0, null)).toBe("nothing found");
  });

  test("a failed search says why, and says something even when it cannot", () => {
    expect(sayResults("failed", 0, "spotify would not renew the sign-in")).toBe(
      "spotify would not renew the sign-in",
    );
    expect(sayResults("failed", 0, null)).toBe("the search did not work");
  });
});
