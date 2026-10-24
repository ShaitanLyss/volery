import { describe, expect, test } from "bun:test";
// @ts-expect-error a plain CommonJS module the browser host loads; no types
import cdp from "../src-tauri/src/browsercdp.cjs";

type Decision = { forward: boolean; send: string[] };
const { TargetFilter, SKIM } = cdp as {
  TargetFilter: new () => {
    fromClient(t: string): void;
    fromBrowser(t: string): Decision;
    ours: Set<string>;
    hidden: Set<string>;
    letGo: number;
  };
  SKIM: number;
};

const j = (v: unknown) => JSON.stringify(v);
const attached = (sessionId: string, browserContextId: string, extra: Record<string, unknown> = {}) =>
  j({
    method: "Target.attachedToTarget",
    params: { sessionId, waitingForDebugger: false, targetInfo: { targetId: `T-${sessionId}`, type: "page", browserContextId, url: "about:blank" }, ...extra },
  });

/** A filter that has watched Playwright create one context, `CTX`. */
function withContext() {
  const f = new TargetFilter();
  f.fromClient(j({ id: 7, method: "Target.createBrowserContext", params: { disposeOnDetach: true } }));
  expect(f.fromBrowser(j({ id: 7, result: { browserContextId: "CTX" } })).forward).toBe(true);
  return f;
}

describe("what the host's connection may see", () => {
  test("a context it made is learned from the reply going past, and its targets pass", () => {
    const f = withContext();
    expect(f.ours.has("CTX")).toBe(true);
    expect(f.fromBrowser(attached("S1", "CTX"))).toEqual({ forward: true, send: [] });
  });

  test("a target in any other context is let go of, never shown", () => {
    const f = withContext();
    const d = f.fromBrowser(attached("S2", "DEFAULT"));
    expect(d.forward).toBe(false);
    expect(d.send.map((s) => JSON.parse(s).method)).toEqual(["Target.detachFromTarget"]);
    expect(JSON.parse(d.send[0]).params).toEqual({ sessionId: "S2" });
    expect(f.letGo).toBe(1);
  });

  /* Playwright auto-attaches with `waitForDebuggerOnStart`, so a page born
     after the connect is paused for us. Letting go of it must not leave it
     paused — measured, the page runs either way, and the resume makes that
     not rest on Chrome's detach doing it. */
  test("a target Chrome paused for us is resumed before it is let go of", () => {
    const f = withContext();
    const d = f.fromBrowser(attached("S3", "OTHER", { waitingForDebugger: true }));
    const sent = d.send.map((s) => JSON.parse(s));
    expect(sent.map((m) => m.method)).toEqual(["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]);
    expect(sent[0].sessionId).toBe("S3");
  });

  test("the replies to its own commands and the hidden session's detach are swallowed", () => {
    const f = withContext();
    const d = f.fromBrowser(attached("S4", "OTHER", { waitingForDebugger: true }));
    const [resume, detach] = d.send.map((s) => JSON.parse(s));
    expect(f.fromBrowser(j({ id: resume.id, result: {}, sessionId: "S4" })).forward).toBe(false);
    expect(f.fromBrowser(j({ id: detach.id, result: {} })).forward).toBe(false);
    expect(f.fromBrowser(j({ method: "Target.detachedFromTarget", params: { sessionId: "S4", targetId: "T-S4" } })).forward).toBe(false);
    expect(f.hidden.size).toBe(0);
    /* Someone else's detach is Playwright's business. */
    expect(f.fromBrowser(j({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } })).forward).toBe(true);
  });

  test("its own ids never collide with the ones Playwright uses", () => {
    const f = withContext();
    const id = JSON.parse(f.fromBrowser(attached("S5", "OTHER")).send[0]).id;
    expect(id).toBeGreaterThanOrEqual(1_000_000_000);
    expect(id).toBeLessThan(2 ** 31);
    /* A reply to Playwright's own id 7 again would be Playwright's. */
    expect(f.fromBrowser(j({ id: 8, result: {} })).forward).toBe(true);
  });

  test("the browser target and a child target on a page's own session pass", () => {
    const f = withContext();
    expect(f.fromBrowser(j({ method: "Target.attachedToTarget", params: { sessionId: "B", targetInfo: { type: "browser" } } })).forward).toBe(true);
    /* A frame or worker arrives on its parent's session: judged by its parent. */
    expect(f.fromBrowser(j({ method: "Target.attachedToTarget", sessionId: "S1", params: { sessionId: "F", targetInfo: { type: "iframe", browserContextId: "DEFAULT" } } })).forward).toBe(true);
  });

  test("a context disposed is no longer ours", () => {
    const f = withContext();
    f.fromClient(j({ id: 9, method: "Target.disposeBrowserContext", params: { browserContextId: "CTX" } }));
    expect(f.fromBrowser(attached("S6", "CTX")).forward).toBe(false);
  });

  test("a context made on another session is not this connection's", () => {
    const f = new TargetFilter();
    f.fromClient(j({ id: 3, sessionId: "X", method: "Target.createBrowserContext" }));
    f.fromBrowser(j({ id: 3, sessionId: "X", result: { browserContextId: "C2" } }));
    expect(f.ours.size).toBe(0);
  });

  test("a long reply is passed on unread, and so is one that does not parse", () => {
    const f = withContext();
    const big = j({ id: 11, result: { data: "x".repeat(SKIM) } });
    expect(f.fromBrowser(big)).toEqual({ forward: true, send: [] });
    expect(f.fromBrowser('{"method":"Target.attachedToTarget",').forward).toBe(true);
  });

  /* A page whose URL is a large data: URL makes its attach event long. */
  test("a long attach event is still judged", () => {
    const f = withContext();
    const huge = j({
      method: "Target.attachedToTarget",
      params: { sessionId: "SB", waitingForDebugger: false, targetInfo: { targetId: "T", type: "page", browserContextId: "DEFAULT", url: `data:text/html,${"x".repeat(SKIM)}` } },
    });
    expect(huge.length).toBeGreaterThan(SKIM);
    expect(f.fromBrowser(huge).forward).toBe(false);
  });
});
