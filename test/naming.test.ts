import { describe, expect, test } from "bun:test";

import {
  NEW_THREAD,
  TITLE_MAX,
  UNNAMED,
  cardName,
  displayName,
  isNamed,
  nameBesideProject,
  titleFromPrompt,
} from "../src/lib/naming";
import { handOver } from "../src/lib/relay";

describe("isNamed", () => {
  test("the sentinel is not a name", () => {
    expect(isNamed(UNNAMED)).toBe(false);
  });

  test("neither is nothing", () => {
    expect(isNamed("")).toBe(false);
    expect(isNamed("   ")).toBe(false);
    expect(isNamed(null)).toBe(false);
    expect(isNamed(undefined)).toBe(false);
  });

  test("anything anybody chose is", () => {
    expect(isNamed("wire the supervisor to job objects")).toBe(true);
    /* Not a special case: a card an agent genuinely titled "Untitled" has been
       named, and the sentinel is spelled in lower case. */
    expect(isNamed("Untitled")).toBe(true);
  });
});

describe("titleFromPrompt", () => {
  test("a short prompt is the title", () => {
    expect(titleFromPrompt("fix the ring")).toBe("fix the ring");
  });

  test("a long one is cut, and says it was", () => {
    const t = titleFromPrompt("x".repeat(80));
    expect(t).toHaveLength(TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
  });

  test("exactly the limit is not cut", () => {
    const t = titleFromPrompt("y".repeat(TITLE_MAX));
    expect(t).toBe("y".repeat(TITLE_MAX));
    expect(t).not.toContain("…");
  });

  /* A prompt is not a line. Pasted paragraphs land in a `nowrap` span, which
     draws a newline as nothing at all and jams the words either side together. */
  test("whitespace is collapsed and trimmed", () => {
    expect(titleFromPrompt("  read the\n\nstore\tcarefully  ")).toBe(
      "read the store carefully",
    );
  });

  test("nothing typed is no title", () => {
    expect(titleFromPrompt("")).toBe("");
    expect(titleFromPrompt(" \n ")).toBe("");
  });

  /* A card an agent opens without a title is named after its brief, which for
     a handover is enveloped for the wire — and naming it after the envelope
     would call every such card `[skein relay] handed over`. */
  test("a handover is named after its brief, never its envelope", () => {
    expect(titleFromPrompt(handOver("widen the roster read"))).toBe("widen the roster read");
  });
});

describe("cardName", () => {
  test("a named card is itself, and settled", () => {
    expect(cardName("wire the supervisor", "half a draft")).toEqual({
      text: "wire the supervisor",
      provisional: false,
    });
  });

  test("an unnamed card with nothing aimed at it is a new thread", () => {
    expect(cardName(UNNAMED)).toEqual({
      text: NEW_THREAD,
      provisional: true,
    });
  });

  /* The whole point: the card is called what you are about to ask it, before you
     ask. Provisional, because it is not the name yet. */
  test("an unnamed card wears the draft", () => {
    expect(cardName(UNNAMED, "look at the layout tests")).toEqual({
      text: "look at the layout tests",
      provisional: true,
    });
  });

  /* One function names the card and previews the naming, so the preview cannot
     disagree with what Enter is going to produce. */
  test("the preview is cut exactly as sending would cut it", () => {
    const long = "read every file under src-tauri and tell me what changed";
    expect(cardName(UNNAMED, long).text).toBe(titleFromPrompt(long));
    expect(cardName(UNNAMED, long).text).toHaveLength(TITLE_MAX);
  });

  test("a draft never renames a card that has a name", () => {
    expect(cardName("Wire the supervisor", "something else entirely")).toEqual({
      text: "Wire the supervisor",
      provisional: false,
    });
  });

  test("whitespace alone leaves it a new thread", () => {
    expect(cardName(UNNAMED, "   ").text).toBe(NEW_THREAD);
  });
});

describe("displayName", () => {
  /* Footprints and meter rows are read at a distance or out of context, where
     an absence explains nothing and whereabouts is the more useful fact. */
  test("an unnamed card is where it is", () => {
    expect(displayName(UNNAMED, "skein")).toBe("skein");
    expect(displayName("", "skein")).toBe("skein");
    expect(displayName(null, "skein")).toBe("skein");
  });

  test("a named one is what it is called", () => {
    expect(displayName("tidy the territories", "skein")).toBe(
      "tidy the territories",
    );
  });
});

describe("nameBesideProject", () => {
  /* The dock, the peek and the ask panel all print the project themselves, so
     falling back to it the way the footprints do would say it twice. */
  test("an unnamed card adds nothing to its project", () => {
    expect(nameBesideProject(UNNAMED)).toBe("");
    expect(nameBesideProject("")).toBe("");
    expect(nameBesideProject(null)).toBe("");
  });

  test("a named one adds its name", () => {
    expect(nameBesideProject("fix the ring")).toBe("fix the ring");
  });

  /* Never the draft: those readouts are about reach and attention, and the
     draft they would echo is in the field directly below them. */
  test("it takes no draft at all", () => {
    expect(nameBesideProject.length).toBe(1);
  });
});
