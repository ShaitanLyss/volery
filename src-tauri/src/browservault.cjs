/* The saved sign-ins, merged.
 *
 * Every card's browser context starts from the vault (`sessions/wall.json`, in
 * Playwright's `storageState` shape) and then lives its own life: a card that
 * signs in, or whose session refreshes, holds newer cookies and storage than
 * the file. Saving gathers them back. Several contexts may hold the same
 * cookie, and this is the rule for which one wins.
 *
 * - **What changed since the vault beats what did not.** Every context was
 *   seeded from the same file, so a value that still matches it says nothing,
 *   and one that differs is somebody's newer sign-in. Chrome records when a
 *   cookie expires and not when it was set, so "most recent" cannot be read
 *   off the cookie itself; this is the nearest honest reading.
 * - **Among changed values, the later expiry wins** — a session cookie (no
 *   expiry) counts as latest — and a tie goes to the later capture. Callers
 *   pass captures oldest context first.
 * - **Nothing is removed.** A cookie missing from one context is not a
 *   sign-out of the wall; it may simply be a card that never visited that
 *   site. Expired cookies are dropped, from the vault as well.
 * - **Local storage merges per origin and per key** by the same rule, minus
 *   the expiry: a changed value beats an unchanged one, the later capture
 *   breaks a tie.
 *
 * Pure, so `test/browservault.test.ts` runs it directly. Shared by the host,
 * which merges a card's context into the vault when it closes and on a save.
 */
"use strict";

function cookieKey(c) {
  return `${c.name}\n${c.domain}\n${c.path || "/"}`;
}

function expiry(c) {
  return c.expires === undefined || c.expires === null || c.expires < 0 ? Infinity : c.expires;
}

function alive(c, now) {
  return expiry(c) > now;
}

function cookiesOf(state) {
  return Array.isArray(state && state.cookies) ? state.cookies.filter((c) => c && typeof c.name === "string") : [];
}

/** Whether an origin is one storage may be saved under: an http(s) origin in
 *  its canonical form, and nothing else. Every new card's context is seeded
 *  from the vault and Playwright opens each saved origin to restore it, so one
 *  that is not a web origin would fail the seeding of every card after it —
 *  and the vault never drops an origin by itself. */
function webOrigin(origin) {
  if (typeof origin !== "string") return false;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === origin;
  } catch {
    return false;
  }
}

function originsOf(state) {
  return Array.isArray(state && state.origins) ? state.origins.filter((o) => o && webOrigin(o.origin)) : [];
}

/** Merge `captures` into `vault`. `now` is in seconds, as cookie expiries are. */
function mergeStates(vault, captures, now) {
  const before = new Map();
  for (const c of cookiesOf(vault)) if (alive(c, now)) before.set(cookieKey(c), c);

  const offered = new Map();
  for (const state of captures) {
    for (const c of cookiesOf(state)) {
      if (!alive(c, now)) continue;
      const k = cookieKey(c);
      if (!offered.has(k)) offered.set(k, []);
      offered.get(k).push(c);
    }
  }

  const cookies = new Map(before);
  for (const [k, list] of offered) {
    const old = before.get(k);
    const changed = list.filter((c) => !old || c.value !== old.value);
    const pool = changed.length ? changed : list;
    let pick = pool[0];
    for (const c of pool.slice(1)) if (expiry(c) >= expiry(pick)) pick = c;
    cookies.set(k, pick);
  }

  const stored = new Map();
  for (const o of originsOf(vault)) {
    const items = new Map();
    for (const it of o.localStorage || []) items.set(it.name, it.value);
    stored.set(o.origin, { before: new Map(items), items });
  }
  for (const state of captures) {
    for (const o of originsOf(state)) {
      if (!stored.has(o.origin)) stored.set(o.origin, { before: new Map(), items: new Map(), changed: new Set() });
      const slot = stored.get(o.origin);
      slot.changed = slot.changed || new Set();
      for (const it of o.localStorage || []) {
        const was = slot.before.get(it.name);
        const differs = was === undefined || was !== it.value;
        /* A changed value always lands; an unchanged one never overwrites a
           change another capture already made. */
        if (differs) {
          slot.items.set(it.name, it.value);
          slot.changed.add(it.name);
        } else if (!slot.changed.has(it.name)) {
          slot.items.set(it.name, it.value);
        }
      }
    }
  }

  return {
    cookies: [...cookies.values()],
    origins: [...stored.entries()]
      .filter(([, s]) => s.items.size > 0)
      .map(([origin, s]) => ({ origin, localStorage: [...s.items.entries()].map(([name, value]) => ({ name, value })) })),
  };
}

/** The browser's own context, read over plain CDP, in the vault's shape.
 *
 *  Each origin is the one the host read off the page's URL, never one the page
 *  reported about itself, and only a web origin is kept. A partitioned cookie
 *  is left out rather than translated: its key is a shape Playwright and Chrome
 *  spell differently, and a cookie the seeding rejects fails the whole seed.
 *
 *  The host's Playwright connection no longer sees that context's pages
 *  (`browsercdp.cjs`), so `storageState()` cannot be asked of it; the host
 *  reads the cookies (`Storage.getCookies`) and each page's localStorage
 *  itself and this puts them in the shape `mergeStates` takes — the same
 *  conversion `src/lib/browser.ts`'s `storageStateFrom` makes for the widget's
 *  fallback: a session cookie is `-1` whichever way CDP spelled it, a missing
 *  `sameSite` is `Lax` (Playwright refuses a document without one, and `Lax`
 *  is what Chrome treats absence as), an expired cookie is dropped. */
function stateFromCdp(cookies, origins, now) {
  const out = [];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || !c.name || !c.domain || c.partitionKey) continue;
    const raw = typeof c.expires === "number" ? c.expires : -1;
    const expires = c.session || raw < 0 ? -1 : Math.floor(raw);
    if (expires >= 0 && now > 0 && expires <= now) continue;
    out.push({
      name: c.name,
      value: c.value ?? "",
      domain: c.domain,
      path: c.path || "/",
      expires,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: c.sameSite === "Strict" || c.sameSite === "None" ? c.sameSite : "Lax",
    });
  }
  const merged = new Map();
  for (const o of Array.isArray(origins) ? origins : []) {
    if (!o || !webOrigin(o.origin)) continue;
    const into = merged.get(o.origin) || new Map();
    for (const [name, value] of o.entries || []) if (typeof name === "string") into.set(name, String(value));
    merged.set(o.origin, into);
  }
  return {
    cookies: out,
    origins: [...merged.entries()]
      .filter(([, items]) => items.size > 0)
      .map(([origin, items]) => ({ origin, localStorage: [...items.entries()].map(([name, value]) => ({ name, value })) })),
  };
}

/** A vault read off disk, or an empty one if it is missing or not a vault. */
function readVault(text) {
  try {
    const v = JSON.parse(text);
    return { cookies: cookiesOf(v), origins: originsOf(v) };
  } catch {
    return { cookies: [], origins: [] };
  }
}

module.exports = { mergeStates, readVault, stateFromCdp, webOrigin };
