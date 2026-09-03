/* What the wall knows about the tokens it holds.
 *
 * One row per entry in `integrations.ts` and nothing service-specific anywhere
 * in it — which is the whole point of the exercise. It was `DevOps`' business
 * when there was one token, and that was the right place for it while the only
 * thing that wanted the answer was the credential ladder; a second service made
 * it the panel's business instead, since a panel for every integration cannot
 * live inside the connection to one of them.
 *
 * Records keyed by service id rather than a class per service, so a third
 * integration is one entry in the table and no code here at all.
 *
 * Named for `creds.rs`, which is the file on the other side of the wire, rather
 * than for `Keyring.svelte`, which is the face — and that is not only taste:
 * `keyring.svelte.ts` beside `Keyring.svelte` is two paths differing in case
 * alone, which TypeScript on Windows reads as one file included twice and
 * refuses to compile.
 *
 * **`held` is a reading of the vault, never something remembered.** Credential
 * Manager is reachable without us — the whole reason `vault.rs` chose it — so
 * Control Panel can delete a token behind our back, and a cached boolean would
 * be stale in the one direction that matters. Asked on open, and again after
 * every write.
 *
 * Nothing here ever holds a token. `set_integration_token` takes one and no
 * command hands one back, so the field is cleared the moment it is sent and the
 * only state kept is a boolean and whatever the service said about it. */

import { invoke } from "@tauri-apps/api/core";
import { INTEGRATIONS, UNASKED, type Check, type ServiceId } from "./integrations";

export class Creds {
  /** Whether each service has a token stored. Absent until asked, which is why
   *  every read goes through `heldFor` rather than indexing this directly. */
  held = $state<Record<string, boolean>>({});
  /** What the last check of each said. */
  check = $state<Record<string, Check>>({});
  /** Which rows have a call in flight, so a row's buttons disable rather than
   *  the whole panel — two services are two independent conversations and one
   *  slow network must not lock the other's field. */
  busy = $state<Record<string, boolean>>({});
  /** What just happened to a row, in a line: "stored", "removed". Cleared by
   *  the next action on the same row. */
  note = $state<Record<string, string>>({});
  /** The command itself failing — the IPC or the vault, as opposed to a service
   *  refusing a token, which is a `Check`. */
  fault = $state<Record<string, string>>({});

  /** Where the wall's projects are, injected the way `DevOps.roots` is and for
   *  the same reason: the verify probe needs an organisation and the ones worth
   *  asking about are the ones whose repositories are standing on the wall. A
   *  function rather than a value, so opening a folder is picked up with
   *  nothing to re-wire. */
  roots: () => string[] = () => [];

  /** Told when a service's credential changed, so whatever was reading with the
   *  old one can go again. Injected rather than imported: this class must not
   *  know that a forge connection exists, or the third integration would have
   *  to be wired into it too. */
  changed: (id: ServiceId) => void = () => {};

  heldFor(id: string): boolean {
    return this.held[id] ?? false;
  }

  checkFor(id: string): Check {
    return this.check[id] ?? UNASKED;
  }

  /* ── reading ─────────────────────────────────────────────────────────────*/

  async askHeld(id: ServiceId): Promise<void> {
    try {
      this.held[id] = await invoke<boolean>("integration_held", { service: id });
    } catch {
      /* A vault that will not answer is a vault with nothing usable in it, and
         whatever was going to use the token will reach the same conclusion. */
      this.held[id] = false;
    }
  }

  /** Every row at once, for the panel opening. */
  async askAll(): Promise<void> {
    await Promise.all(INTEGRATIONS.map((i) => this.askHeld(i.id)));
  }

  /* ── writing ─────────────────────────────────────────────────────────────*/

  async store(id: ServiceId, token: string): Promise<void> {
    const text = token.trim();
    if (!text || this.busy[id]) return;
    this.#begin(id);
    try {
      await invoke("set_integration_token", { service: id, token: text });
      await this.askHeld(id);
      this.note[id] = "stored";
      /* A token replaced is a token worth checking, and this is the moment the
         answer is cheapest to act on — you are looking at the row, with the
         page you minted it on still open. Awaited rather than fired off, so
         "stored" and "checking…" do not race for the same line. */
      await this.verify(id);
      this.changed(id);
    } catch (err) {
      this.fault[id] = String(err);
    } finally {
      this.busy[id] = false;
    }
  }

  async forget(id: ServiceId): Promise<void> {
    if (this.busy[id]) return;
    this.#begin(id);
    try {
      await invoke("clear_integration_token", { service: id });
      await this.askHeld(id);
      /* The verdict goes with the token. A row still reading "accepted" beside
         an empty vault is the one state here that could send somebody looking
         for a bug in the wrong service — `checkReading` guards it too, and this
         is the other half: nothing stale is kept to be drawn. */
      this.check[id] = UNASKED;
      this.note[id] = "removed";
      this.changed(id);
    } catch (err) {
      this.fault[id] = String(err);
    } finally {
      this.busy[id] = false;
    }
  }

  /* ── checking ────────────────────────────────────────────────────────────*/

  /** One authenticated request, because you asked.
   *
   *  Never on a timer, and that is the whole of why it needs no bound: the
   *  wall's standing rule is that a poller must be bounded by somebody
   *  watching, and there is no poller here. A token you have not touched cannot
   *  have changed, and the one that can — revoked at the far end — is not
   *  something this app should be discovering on a clock against somebody
   *  else's server. */
  async verify(id: ServiceId): Promise<void> {
    if (!this.heldFor(id)) return;
    this.check[id] = { at: "asking" };
    try {
      const v = await invoke<{ ok: boolean; who: string; said: string }>("verify_integration", {
        service: id,
        roots: this.roots(),
      });
      const when = Date.now();
      this.check[id] = v.ok
        ? { at: "good", who: v.who, when }
        : { at: "bad", said: v.said, when };
    } catch (err) {
      /* The command failing rather than the service refusing. Drawn in the same
         place, because from the row's point of view they are the same news —
         this token cannot be shown to work — and a second line for it would be
         a distinction only the code cares about. */
      this.check[id] = { at: "bad", said: String(err), when: Date.now() };
    }
  }

  #begin(id: ServiceId) {
    this.busy[id] = true;
    this.note[id] = "";
    this.fault[id] = "";
  }
}
