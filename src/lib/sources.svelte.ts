/* What the Integrations panel knows about the event sources.
 *
 * `creds.svelte.ts`'s shape, one table over: records keyed by source name for
 * what is in flight and what just happened, and the rows themselves as Rust
 * last sent them. **Nothing here ever holds a connection string** — `set_source`
 * takes one, no command hands one back, and the field it was typed into is
 * cleared as it is sent.
 *
 * Read when the panel opens and kept current by `sources:changed` while it is
 * open — `watch` returns the release, so the subscription is bounded by
 * somebody looking, and a closed panel costs nothing. The card face does not
 * read this at all: what a card is subscribed to comes through
 * `subscription:armed` into `Conversation.subscriptions`.
 *
 * Until the Rust half is in the build, every command rejects; `missing` says
 * so and the section reads as absent rather than broken. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UNASKED, type Check } from "./integrations";
import { readSource, readSources, type SourceRow } from "./sources";

export class Sources {
  rows = $state<SourceRow[]>([]);
  /** The list could not be read at all — a build with no sources. */
  missing = $state(false);
  check = $state<Record<string, Check>>({});
  busy = $state<Record<string, boolean>>({});
  /** "stored", "removed" — cleared by the next action on the row. */
  note = $state<Record<string, string>>({});
  /** A command refused, worded by Rust for a person and shown verbatim. The
   *  add form's is under `""`. */
  fault = $state<Record<string, string>>({});

  checkFor(name: string): Check {
    return this.check[name] ?? UNASKED;
  }

  async read(): Promise<void> {
    try {
      this.rows = readSources(await invoke<unknown>("sources_list"));
      this.missing = false;
    } catch {
      this.missing = true;
    }
  }

  /** Read now and on every change until the returned function is called. */
  watch(): () => void {
    let gone = false;
    let stop: (() => void) | null = null;
    void listen("sources:changed", () => void this.read()).then((un) => {
      if (gone) un();
      else stop = un;
    });
    void this.read();
    return () => {
      gone = true;
      stop?.();
    };
  }

  /** Add a source, or change one. `connection` null keeps the stored secret —
   *  a consumer-group change alone. Resolves true when it landed. */
  async set(name: string, connection: string | null, consumerGroup: string | null, key = name): Promise<boolean> {
    if (this.busy[key]) return false;
    this.#begin(key);
    try {
      const row = readSource(
        await invoke<unknown>("set_source", { name, connection: connection?.trim() || null, consumerGroup }),
      );
      if (row) this.#upsert(row);
      else await this.read();
      this.note[name] = "stored";
      if (key !== name) this.note[key] = "";
      /* A connection string replaced is one worth checking, now, while the
         portal page it was copied from is still open — `creds.store`'s
         argument. Not after a consumer-group change alone: the namespace has
         not moved. */
      if (connection?.trim()) await this.verify(name);
      return true;
    } catch (err) {
      this.fault[key] = String(err);
      return false;
    } finally {
      this.busy[key] = false;
    }
  }

  async forget(name: string): Promise<void> {
    if (this.busy[name]) return;
    this.#begin(name);
    try {
      await invoke("forget_source", { name });
      this.rows = this.rows.filter((r) => r.name !== name);
      delete this.check[name];
      delete this.note[name];
    } catch (err) {
      /* Refused while cards are subscribed — the refusal says so. */
      this.fault[name] = String(err);
    } finally {
      this.busy[name] = false;
    }
  }

  /** One real round trip to the namespace, because you asked. Seconds. */
  async verify(name: string): Promise<void> {
    this.check[name] = { at: "asking" };
    try {
      const v = await invoke<{ ok: boolean; who: string; said: string }>("check_source", { name });
      const when = Date.now();
      this.check[name] = v.ok ? { at: "good", who: v.who, when } : { at: "bad", said: v.said, when };
    } catch (err) {
      this.check[name] = { at: "bad", said: String(err), when: Date.now() };
    }
  }

  #upsert(row: SourceRow) {
    const rest = this.rows.filter((r) => r.name !== row.name);
    this.rows = readSources([...rest, row]);
  }

  #begin(key: string) {
    this.busy[key] = true;
    this.note[key] = "";
    this.fault[key] = "";
  }
}
