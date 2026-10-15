import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { ANSI_PALETTE, ansiVar, parseAnsi, stripAnsi } from "../src/lib/ansi";
import { contrast } from "../src/lib/palette";

const E = "\x1b";

describe("stripAnsi", () => {
  test("plain text is untouched", () => {
    expect(stripAnsi("ready in 702 ms")).toBe("ready in 702 ms");
  });

  test("removes colour and leaves the words", () => {
    expect(stripAnsi(`${E}[32mVITE${E}[0m v6.4.3`)).toBe("VITE v6.4.3");
  });

  test("removes cursor and erase sequences a PTY emits", () => {
    expect(stripAnsi(`${E}[2K${E}[1Gbuilding...`)).toBe("building...");
  });

  test("removes OSC title sequences", () => {
    expect(stripAnsi(`${E}]0;npm run dev\x07done`)).toBe("done");
  });
});

describe("parseAnsi", () => {
  test("undecorated text becomes one default span", () => {
    expect(parseAnsi("hello")).toEqual([
      { text: "hello", color: null, bold: false, dim: false },
    ]);
  });

  test("a colour applies until it is reset", () => {
    const s = parseAnsi(`${E}[31merror${E}[0m ok`);
    expect(s[0]).toMatchObject({ text: "error", color: 1 });
    expect(s[1]).toMatchObject({ text: " ok", color: null });
  });

  test("bright colours map above the first eight", () => {
    expect(parseAnsi(`${E}[92mgreen`)[0].color).toBe(10);
  });

  test("bold and dim are tracked and cleared by 22", () => {
    const s = parseAnsi(`${E}[1mB${E}[22mN`);
    expect(s[0]).toMatchObject({ text: "B", bold: true });
    expect(s[1]).toMatchObject({ text: "N", bold: false });
  });

  test("combined codes in one escape all apply", () => {
    const [s] = parseAnsi(`${E}[1;33mwarn`);
    expect(s).toMatchObject({ color: 3, bold: true });
  });

  test("a bare reset behaves like 0", () => {
    const s = parseAnsi(`${E}[31mred${E}[mplain`);
    expect(s[1]).toMatchObject({ text: "plain", color: null });
  });

  test("39 returns to the default without clearing bold", () => {
    const s = parseAnsi(`${E}[1;31mx${E}[39my`);
    expect(s[1]).toMatchObject({ color: null, bold: true });
  });

  test("256-colour arguments are consumed, not read as more codes", () => {
    // 38;5;196 must not leave "5" or "196" to be misread as bold/colour.
    const s = parseAnsi(`${E}[38;5;196mtext`);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe("text");
    expect(s[0].bold).toBe(false);
  });

  test("truecolour arguments are consumed too", () => {
    const s = parseAnsi(`${E}[38;2;255;0;0;1mtext`);
    // The trailing 1 after the colour triple is a real bold.
    expect(s[0]).toMatchObject({ text: "text", bold: true });
  });

  test("adjacent runs with the same styling are merged", () => {
    const s = parseAnsi(`${E}[31ma${E}[31mb`);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe("ab");
  });

  test("non-SGR escapes are dropped from the text", () => {
    const s = parseAnsi(`${E}[2K${E}[32mready${E}[0m`);
    expect(s.map((x) => x.text).join("")).toBe("ready");
  });

  test("a real vite line survives intact", () => {
    const line = `  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ${E}[36mhttp://localhost:1420/${E}[39m`;
    expect(stripAnsi(line)).toBe("  ➜  Local:   http://localhost:1420/");
    const s = parseAnsi(line);
    expect(s.some((x) => x.color === 2)).toBe(true); // the green arrow
    expect(s.some((x) => x.color === 6)).toBe(true); // the cyan url
    expect(s.some((x) => x.bold)).toBe(true); // "Local"
  });

  test("every index the parser can produce exists in the palette", () => {
    for (const code of [30, 37, 90, 97]) {
      const [s] = parseAnsi(`${E}[${code}mx`);
      expect(ANSI_PALETTE[s.color!]).toBeString();
    }
  });
});

describe("the sixteen colours live in tokens.css", () => {
  const css = readFileSync(new URL("../src/lib/tokens.css", import.meta.url), "utf8");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (head: RegExp) => {
    const m = head.exec(stripped);
    if (!m) throw new Error(`no ${head} block in tokens.css`);
    const out = new Map<number, string>();
    for (const d of m[1].matchAll(/--ansi-(\d+):\s*([^;]+);/g)) out.set(Number(d[1]), d[2].trim());
    return out;
  };
  /* The grounds the light skins have used (meadow, sugar, the cooler cream) and
     two from the brief that rebuilt them; the darkest is the one that binds. */
  const WELLS = ["#e9e8de", "#ece6df", "#f0e3e9", "#efebe4", "#fffbfd"];
  const dark = block(/:root\s*\{([^}]*--ansi-0:[^}]*)\}/);
  const light = block(/:root\[data-ground="light"\]\s*\{([^}]*)\}/);

  test("a span is drawn with the variable", () => {
    expect(ansiVar(3)).toBe("var(--ansi-3)");
  });

  test("the dark set is exactly what ANSI_PALETTE says", () => {
    expect(dark.size).toBe(16);
    ANSI_PALETTE.forEach((hex, i) => expect(dark.get(i)).toBe(hex));
  });

  test("the light set names all sixteen", () => {
    expect([...light.keys()].sort((a, b) => a - b)).toEqual(ANSI_PALETTE.map((_, i) => i));
  });

  test("every light colour is text against the light wells", () => {
    let measured = 0;
    for (const [i, v] of light) {
      if (v.startsWith("var(")) continue; // the ink ramp, held by palette.test.ts
      for (const well of WELLS) {
        const c = contrast(v, well);
        expect(c, `--ansi-${i} ${v} on ${well}`).not.toBeNull();
        expect(c!).toBeGreaterThanOrEqual(4.5);
        measured += 1;
      }
    }
    // A skipped assertion reads as a satisfied one: twelve hex colours, every well.
    expect(measured).toBe(12 * WELLS.length);
  });
});
