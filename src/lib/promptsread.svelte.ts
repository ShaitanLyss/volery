/* The prompt trace's one reader: the commands, normalized.
 *
 * `AnalyticsPrompts.svelte` takes a `PromptReader` rather than importing
 * `invoke`, so the same component is driven by the preview's fixture in a
 * browser. This is the real one, and its whole job is arity.
 *
 * Every answer is normalized in `analyticstrace.ts` before the component sees
 * it, the bargain an opaque answer strikes everywhere here: a row that will not
 * parse is dropped and a field that will not parse becomes the shape's zero,
 * so no NaN reaches a template.
 *
 * **Nothing here logs, stores or caches a body.** `prompt_body` is called by
 * the detail pane, on selection, and its text is handed straight to the
 * component's own state. A fault carries the command's sentence only, never the
 * request's text, which is why the rejections below re-throw the string rather
 * than wrapping it with arguments.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  asFavouriteRow,
  asFavouriteRows,
  asForgetReport,
  asPromptBody,
  asPromptRows,
  asResetReport,
  asSealReport,
  asVaultState,
  type FavouriteRow,
  type ForgetReport,
  type PromptBody,
  type PromptReader,
  type PromptRow,
  type ResetReport,
  type SealReport,
  type VaultState,
} from "./analyticstrace";

function fault(e: unknown): never {
  throw new Error(e instanceof Error ? e.message : String(e));
}

export const prompts: PromptReader = {
  async facts(from: number, to: number): Promise<PromptRow[]> {
    try {
      return asPromptRows(await invoke<unknown>("prompt_facts", { from, to }));
    } catch (e) {
      fault(e);
    }
  },

  async body(host: string, promptId: string): Promise<PromptBody> {
    try {
      return asPromptBody(await invoke<unknown>("prompt_body", { host, promptId }));
    } catch (e) {
      fault(e);
    }
  },

  async vault(): Promise<VaultState> {
    try {
      return asVaultState(await invoke<unknown>("vault_state"));
    } catch (e) {
      fault(e);
    }
  },

  async createVault(passphrase: string): Promise<VaultState> {
    try {
      return asVaultState(await invoke<unknown>("create_vault", { passphrase }));
    } catch (e) {
      fault(e);
    }
  },

  async unlockVault(passphrase: string): Promise<VaultState> {
    try {
      return asVaultState(await invoke<unknown>("unlock_vault", { passphrase }));
    } catch (e) {
      fault(e);
    }
  },

  async lockVault(): Promise<VaultState> {
    try {
      return asVaultState(await invoke<unknown>("lock_vault"));
    } catch (e) {
      fault(e);
    }
  },

  async sealPending(): Promise<SealReport> {
    try {
      return asSealReport(await invoke<unknown>("seal_pending"));
    } catch (e) {
      fault(e);
    }
  },

  async forget(): Promise<ForgetReport> {
    try {
      return asForgetReport(await invoke<unknown>("forget_prompts"));
    } catch (e) {
      fault(e);
    }
  },

  async resetVault(confirm: boolean): Promise<ResetReport> {
    try {
      return asResetReport(await invoke<unknown>("reset_vault", { confirm }));
    } catch (e) {
      fault(e);
    }
  },

  async overrideKind(host: string, promptId: string, kind: string): Promise<void> {
    try {
      await invoke("override_prompt_kind", { host, promptId, kind });
    } catch (e) {
      fault(e);
    }
  },

  async favourites(): Promise<FavouriteRow[]> {
    try {
      return asFavouriteRows(await invoke<unknown>("prompt_favourites"));
    } catch (e) {
      fault(e);
    }
  },

  async keepFavourite(input): Promise<FavouriteRow> {
    try {
      const row = asFavouriteRow(
        await invoke<unknown>("keep_prompt_favourite", {
          host: input.host,
          promptId: input.promptId,
          title: input.title,
          tags: input.tags,
          note: input.note,
        }),
      );
      if (!row) throw new Error("the hall entry was written and could not be read back");
      return row;
    } catch (e) {
      fault(e);
    }
  },

  async removeFavourite(host: string, promptId: string): Promise<boolean> {
    try {
      return Boolean(await invoke<boolean>("remove_prompt_favourite", { host, promptId }));
    } catch (e) {
      fault(e);
    }
  },
};
