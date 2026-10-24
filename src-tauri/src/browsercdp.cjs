/* What the host's one connection to Chrome is allowed to see: the browser
 * contexts it made, and nothing else.
 *
 * playwright-core 1.64's `connectOverCDP` auto-attaches to every target in the
 * browser and then waits for every page to initialise
 * (`_waitForAllPagesToBeInitialized`). So one tab that never answers — an
 * `alert()` left open, a renderer in a loop — held the connect of the whole
 * wall. Since each card became a context of its own the host connects once,
 * which narrowed that to one connect, and measured it (`probe-card-tabs.ts
 * stall`, part 4): a looping tab in the browser's own context, the host
 * restarted, and every card's first browser call failed at 30s with
 * `connectOverCDP: Timeout 30000ms exceeded` until that tab was closed.
 *
 * None of those tabs are the host's business. A card's pages are in its own
 * context; the browser's own context holds the widget's pages, the first blank
 * page and anything the person opened; other contexts are other clients'. So
 * the host dials Chrome through this filter, which lets Playwright see a target
 * only if it belongs to a context created on this connection — learned from
 * the `Target.createBrowserContext` replies going past. Everything else is
 * attached to by Chrome as usual (Playwright's `setAutoAttach` asks for every
 * target) and then let go of at once: resumed if Chrome paused it for us
 * (`waitForDebuggerOnStart`), detached, and never mentioned to Playwright. A
 * page let go of that way runs normally — measured, part 5: detached with or
 * without the resume, the page ran its script and answered every question.
 *
 * Pure: a message in, a decision out. `browserhost.cjs` owns the sockets and
 * `test/browsercdp.test.ts` runs this directly.
 */
"use strict";

/** Messages longer than this are skimmed rather than parsed: the long ones
 *  are screenshots and snapshots, not worth parsing to find that out. A long
 *  one that *is* a target event — an attach for a page holding a large
 *  `data:` URL — is still parsed, told apart by how Chrome begins an event
 *  (`{"method":"Target.`); a reply begins `{"id":`. */
const SKIM = 64 * 1024;
const TARGET_EVENT = '{"method":"Target.';

/** Ids for the filter's own commands, far above any Playwright will reach and
 *  inside the int32 Chrome reads an id as. */
const OWN_IDS_FROM = 1_000_000_000;

class TargetFilter {
  constructor() {
    /** Contexts made on this connection: the only ones Playwright is shown. */
    this.ours = new Set();
    /** Ids of `Target.createBrowserContext` requests not answered yet. */
    this.creating = new Set();
    /** Sessions the filter attached to and is letting go of. */
    this.hidden = new Set();
    /** Ids of the filter's own commands, whose replies nobody else asked for. */
    this.own = new Set();
    this.next = OWN_IDS_FROM;
    /** How many targets were let go of — for the host's log. */
    this.letGo = 0;
  }

  /** A message on its way from Playwright to Chrome. Only watched, never
   *  changed: what it learns is which contexts are this connection's. */
  fromClient(text) {
    if (text.length > SKIM) return;
    if (!text.includes("Target.createBrowserContext") && !text.includes("Target.disposeBrowserContext")) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.sessionId) return;
    if (m.method === "Target.createBrowserContext" && m.id !== undefined) this.creating.add(m.id);
    if (m.method === "Target.disposeBrowserContext") this.ours.delete(m.params && m.params.browserContextId);
  }

  /** A message on its way from Chrome to Playwright. Returns whether to pass
   *  it on, and anything to send Chrome in its place. */
  fromBrowser(text) {
    const pass = { forward: true, send: [] };
    if (text.length > SKIM && !text.startsWith(TARGET_EVENT)) return pass;
    if (!this.creating.size && !this.hidden.size && !this.own.size && !text.includes("Target.attachedToTarget")) return pass;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return pass;
    }

    if (m.id !== undefined && m.method === undefined) {
      if (this.own.delete(m.id)) return { forward: false, send: [] };
      if (!m.sessionId && this.creating.delete(m.id) && m.result && m.result.browserContextId) {
        this.ours.add(m.result.browserContextId);
      }
      return pass;
    }
    /* Anything on a session being let go of — there is nothing enabled on it,
       so in practice only the replies to our own two commands. */
    if (m.sessionId && this.hidden.has(m.sessionId)) return { forward: false, send: [] };

    if (m.method === "Target.detachedFromTarget" && !m.sessionId) {
      const sid = m.params && m.params.sessionId;
      if (this.hidden.delete(sid)) return { forward: false, send: [] };
      return pass;
    }

    if (m.method === "Target.attachedToTarget" && !m.sessionId) {
      const p = m.params || {};
      const info = p.targetInfo || {};
      /* The browser target itself, and anything in a context of ours. A child
         target — a frame, a worker — arrives on its parent's session, which
         is why only root-level attachments are judged at all. */
      if (info.type === "browser" || this.ours.has(info.browserContextId)) return pass;
      const sid = p.sessionId;
      if (!sid) return pass;
      this.hidden.add(sid);
      this.letGo++;
      const send = [];
      if (p.waitingForDebugger) send.push(this.command("Runtime.runIfWaitingForDebugger", undefined, sid));
      send.push(this.command("Target.detachFromTarget", { sessionId: sid }));
      return { forward: false, send };
    }
    return pass;
  }

  command(method, params, sessionId) {
    const id = this.next++;
    this.own.add(id);
    const m = { id, method };
    if (params) m.params = params;
    if (sessionId) m.sessionId = sessionId;
    return JSON.stringify(m);
  }
}

module.exports = { TargetFilter, SKIM };
