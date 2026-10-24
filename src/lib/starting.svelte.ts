/* Starting a conversation from chat view's empty state (`docs/chat-mode.md`
 * §6.3, §5.9): the place it works in, the preset it opens as, whether it plans
 * first, whether this machine can start one at all — and the first send, which
 * opens the card and then hands the draft to the composer.
 *
 * Constructed once in `App.svelte`, beside the composer, because the choices
 * outlive the empty state: you pick a place, read another conversation, come
 * back, and the chip still says what you picked. The rules are `starting.ts`'s.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tick } from "svelte";
import type { Conversation } from "./conversation.svelte";
import type { Skein } from "./skein.svelte";
import type { Field } from "./field.svelte";
import type { Composer } from "./composer.svelte";
import type { CardHandle } from "./cards.svelte";
import type { Opener } from "./shadow";
import { NOTHING } from "./drafts";
import { defaultPresetFor, presetById, type Preset } from "./presets";
import { readSignin, type Progress } from "./signin";
import { waterfall } from "./waterfall.svelte";
import {
  FIRST_ACCOUNT,
  machineNow,
  placeAtHome,
  placeOnWall,
  presetOf,
  readiness,
  startingPlace,
  storedOf,
  type Known,
  type Place,
  type PresetChoice,
  type Seen,
  type StoredPlace,
} from "./starting";

/** Per machine and disposable, like the view itself (`viewmode.ts`): the place
 *  you last started from and the preset you last chose. */
const KEY = "skein.start.v1";

/** `claude.rs::Auth`. */
export type Auth = { loggedIn: boolean; method: string; plan: string | null };

type Host = {
  skein: Skein;
  field: Field;
  composer: Composer;
  /** App's openers, which set the focus and hold the one `spawning` latch a
   *  double press must not get past. */
  openIn: (dir: string, worktree?: string, preset?: Preset | null) => Promise<Conversation | null>;
  openChat: (preset?: Preset | null) => Promise<Conversation | null>;
  /** The walls on the flyway, as the roster says them. */
  roster: () => Opener[];
  /** Open an empty card in `project` on `host` and resolve to it once it is
   *  drawn here and has the focus, or null — the reason already a fault. */
  openThere: (host: string, project: string, preset: Preset | null) => Promise<CardHandle | null>;
};

export class Starter {
  /** Where the next conversation works. Settled from what is remembered the
   *  first time the empty state draws (`settle`), and then only by choosing. */
  place = $state<Place>({ kind: "chat" });
  /** The machine it opens on: a wall's name on the flyway, or null for this one.
   *  Only for this launch, on purpose: a card on another laptop runs with its
   *  permissions skipped and bills there, so a restart opens on this machine
   *  rather than on wherever the last conversation happened to go. */
  machine = $state<string | null>(null);
  /** The preset it opens as, in `Skein.open`'s three states. */
  preset = $state<PresetChoice>(null);
  /** Plan first, for the conversation about to start. Not remembered: it is a
   *  decision about one piece of work. */
  plan = $state(false);
  /** The machine's own credential (`claude_auth`): null before asking,
   *  `"unknown"` when the CLI could not say. */
  auth = $state<Auth | "unknown" | null>(null);
  /** A sign-in from the empty state, while it runs. */
  signing = $state<{ out: string; running: boolean; fault: string | null } | null>(null);
  /** Between the first send and the card taking it. */
  starting = $state(false);

  #h: Host;
  #stored: StoredPlace | null = null;
  #settled = false;
  #asking: Promise<void> | null = null;
  #off: UnlistenFn[] = [];

  constructor(h: Host) {
    this.#h = h;
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
        place?: StoredPlace | null;
        preset?: PresetChoice;
      } | null;
      this.#stored = raw?.place ?? null;
      const p = raw?.preset;
      this.preset = typeof p === "string" ? p : null;
    } catch {
      /* A malformed entry is a fresh start, which is all it ever held. */
    }
  }

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ place: this.#stored, preset: this.preset }));
    } catch {
      /* Storage full or refused: the choice still holds for this launch. */
    }
  }

  /** The walls on the flyway, as the roster says them — reactive. */
  get roster(): Opener[] {
    return this.#h.roster();
  }

  /** The place the empty state opens on, decided once per launch from what is
   *  remembered and what the wall holds. Later draws keep what was chosen. */
  settle(projects: readonly Known[], seen: readonly Seen[]) {
    if (this.#settled) {
      /* A project deleted while chosen is not a place any more. */
      const p = this.place;
      if (this.machine === null && p.kind === "project" && !projects.some((k) => k.name === p.name)) this.place = startingPlace(null, projects, seen);
      return;
    }
    this.#settled = true;
    this.place = startingPlace(this.#stored, projects, seen);
  }

  choose(p: Place) {
    this.place = p;
    this.#settled = true;
    /* What was chosen on another machine is that machine's projects, not the
       place you start from: it is not remembered. */
    const s = this.machine === null ? storedOf(p) : null;
    if (s) {
      this.#stored = s;
      this.#save();
    }
  }

  /** A place chosen from this wall's own pages — a project's *new conversation
   *  here* — which can only mean this machine. */
  chooseHere(p: Place) {
    this.machine = null;
    this.choose(p);
  }

  /** Pick the machine, and carry the place with it: kept where that wall holds
   *  the project in use, else the first it holds, and back to a folder here when
   *  it is this machine again. Not remembered across launches. */
  chooseMachine(host: string | null, projects: readonly Known[], seen: readonly Seen[]) {
    const row = host === null ? null : this.#h.roster().find((r) => r.host === host);
    if (host !== null && !row) return;
    this.machine = host;
    this.#settled = true;
    this.place = row ? placeOnWall(row, this.place, projects, seen) : placeAtHome(this.place, this.#stored, projects, seen);
  }

  /** A machine chosen and since gone quiet, or switched to take no work, is
   *  this machine again at once — the send must not go to a wall that would only
   *  refuse it. Asked as the roster changes. */
  settleMachine(projects: readonly Known[], seen: readonly Seen[]) {
    if (this.machine !== null && machineNow(this.machine, this.#h.roster()) === null) this.chooseMachine(null, projects, seen);
  }

  choosePreset(choice: PresetChoice) {
    this.preset = choice;
    this.#save();
  }

  /** *Open a folder…* (Ctrl+O): pick one the way a folder is picked, and make
   *  it the place. Nothing opens yet — the first send does, so a folder picked
   *  by mistake costs nothing. True when one was picked. */
  async pickFolder(): Promise<boolean> {
    if (this.machine !== null) return false;
    const picked = await openDialog({ directory: true, multiple: false, title: "Where should this conversation work?" });
    if (typeof picked !== "string") return false;
    const known = this.#h.skein.projects.find((p) => p.root_path === picked);
    this.choose(known ? { kind: "project", name: known.name, dir: known.root_path } : { kind: "folder", dir: picked });
    return true;
  }

  /** What the choice resolves to now, the wall's default standing in for
   *  nobody saying. */
  get resolved(): Preset | undefined {
    return presetOf(this.preset, defaultPresetFor(this.#h.skein.defaultPreset));
  }

  /** Whether a conversation can start here (`starting.ts::readiness`). */
  get ready() {
    return readiness(waterfall.claude, this.auth, waterfall.usable.length);
  }

  /** Ask the CLI whether it is signed in. About a second a spawn
   *  (`tools/probe-auth.ts`), so asked when the empty state draws and on *look
   *  again*, never on a timer — and once at a time. */
  check(): Promise<void> {
    if (this.#asking) return this.#asking;
    this.#asking = (async () => {
      try {
        this.auth = await invoke<Auth>("claude_auth");
      } catch {
        this.auth = "unknown";
      } finally {
        this.#asking = null;
      }
    })();
    return this.#asking;
  }

  /** *Look again*: the CLI's presence and the accounts, then the credential. */
  async lookAgain() {
    this.auth = null;
    await waterfall.refresh();
    await this.check();
  }

  /** *Sign in to Claude*: `signin.rs`'s browser flow, into a managed account —
   *  the first registered one if there is any, else a new one named
   *  `FIRST_ACCOUNT`. Never the machine's own credential, which `signin.rs`
   *  deliberately cannot write (`starting.ts`, the note on `FIRST_ACCOUNT`). */
  async signIn() {
    if (this.signing?.running) return;
    const label = waterfall.list[0]?.label ?? FIRST_ACCOUNT;
    this.signing = { out: "", running: true, fault: null };
    try {
      if (!waterfall.list.some((a) => a.label === label)) await waterfall.add(label);
      this.#unlisten();
      this.#off.push(
        await listen<{ label: string; text: string }>("signin:out", (e) => {
          if (e.payload.label !== label || !this.signing) return;
          this.signing = { ...this.signing, out: this.signing.out + e.payload.text };
        }),
        await listen<{ label: string; ok: boolean; signed_in: boolean }>("signin:done", (e) => {
          if (e.payload.label !== label) return;
          this.#unlisten();
          const fault = e.payload.signed_in ? null : (this.progress?.fault ?? "the sign-in did not finish");
          this.signing = { out: this.signing?.out ?? "", running: false, fault };
          void this.lookAgain();
        }),
      );
      await waterfall.signIn(label);
    } catch (err) {
      this.#unlisten();
      this.signing = { out: this.signing?.out ?? "", running: false, fault: String(err) };
    }
  }

  /** Hand over the code the browser shows, for the fallback the CLI prints when
   *  it cannot come back on its own. */
  async paste(code: string) {
    const label = waterfall.list[0]?.label ?? FIRST_ACCOUNT;
    await invoke("paste_signin", { label, code });
  }

  /** What the sign-in has said so far, read the way the accounts panel reads
   *  it (`signin.ts`). */
  get progress(): Progress | null {
    return this.signing ? readSignin(this.signing.out) : null;
  }

  #unlisten() {
    for (const off of this.#off.splice(0)) off();
  }

  release() {
    this.#unlisten();
  }

  /** The first send: open the card in the chosen place as the chosen preset,
   *  then send the draft to it through the composer — the one send path, so
   *  the pictures, the naming and the stir guard are what they always are.
   *
   *  The draft is taken out of the field before the card opens and put back
   *  once the focus has moved. Otherwise the focus moving parks it under the
   *  empty sheet (`drafts.ts::switchTo`) and hands the new card an empty field,
   *  and the message would send nothing. A card that fails to open gives the
   *  words back where they were. */
  async start(): Promise<boolean> {
    const { field, composer, skein } = this.#h;
    if (this.starting || !field.text.trim()) return false;
    this.starting = true;
    const draft = field.draft;
    field.take(NOTHING);
    try {
      const place = this.place;
      if (this.machine !== null) {
        /* On another machine: an empty card in the project that wall holds,
           then the draft goes to it as it goes to any card elsewhere — through
           the composer, which reaches the card in front of it wherever it
           runs. Plan first is a gear, and a card elsewhere has no gear verb. */
        const host = machineNow(this.machine, this.#h.roster());
        const card = host && place.kind === "project" ? await this.#h.openThere(host, place.name, this.resolved ?? null) : null;
        if (!card) {
          if (!host) skein.fault = `${this.machine} cannot take a conversation from here now — it was not started`;
          field.take(draft);
          return false;
        }
        this.plan = false;
        await tick();
        field.take(draft);
        await composer.send(false);
        return true;
      }
      const preset = this.preset === null ? undefined : this.preset === "" ? null : (presetById(this.preset) ?? undefined);
      const conv =
        place.kind === "chat" ? await this.#h.openChat(preset) : await this.#h.openIn(place.dir, undefined, preset);
      if (!conv) {
        field.take(draft);
        return false;
      }
      if (this.plan && conv.kind === "project") await skein.setGear(conv, "planning");
      /* A picked folder is a project now (`ensure_project`), and remembered as
         one: the next empty state opens on it. */
      if (place.kind === "folder") {
        const p = skein.projects.find((k) => k.root_path === conv.cwd);
        if (p) this.choose({ kind: "project", name: p.name, dir: p.root_path });
      }
      this.plan = false;
      await tick();
      field.take(draft);
      await composer.send(false);
      return true;
    } finally {
      this.starting = false;
    }
  }
}
