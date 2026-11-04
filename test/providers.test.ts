import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEEPSEEK,
  PROVIDERS,
  PROVIDER_PRESETS,
  onProvider,
  providerCliModel,
  providerModel,
  providerName,
  providerOf,
} from "../src/lib/providers";
import { PRESETS, presetById, presetForSpawn } from "../src/lib/presets";

const rust = readFileSync(new URL("../src-tauri/src/provider.rs", import.meta.url), "utf8");

describe("a provider is one word agreed on by both sides", () => {
  test("the sentinel is the one the Rust module writes", () => {
    expect(rust).toContain(`pub const DEEPSEEK: &str = "${DEEPSEEK}";`);
    expect(DEEPSEEK).toBe("@deepseek");
    /* The `@` is load-bearing: `accounts::is_label` refuses it, so no registered
       Claude account can ever collide with a provider sentinel — the same
       bargain `@credits` strikes. */
    expect(DEEPSEEK.startsWith("@")).toBe(true);
  });

  test("the key, endpoint and wire alias match what `provider::apply` sets", () => {
    const ds = providerOf(DEEPSEEK)!;
    expect(ds).not.toBeNull();
    expect(rust).toContain(`key: "deepseek"`);
    expect(rust).toContain(`base_url: "https://api.deepseek.com/anthropic"`);
    /* The provider's own names never reach `--model`: the CLI refuses an id it
       does not know, so the wire gets a Claude family alias and DeepSeek maps
       it server-side. */
    expect(rust).toContain(`model: "sonnet"`);
    expect(rust).toContain("pub fn cli_model");
    expect(providerCliModel(ds, "deepseek-v4-pro")).toBe("opus");
    expect(providerCliModel(ds, "deepseek-flash")).toBe("sonnet");
    expect(providerCliModel(ds, "opus[1m]")).toBe("opus");
    /* The env names are Claude Code's, and a typo is silently ignored — the
       failure mode that reads as the provider having no effect at all. The
       three DEFAULT_* names remain because `withhold` must take an older
       environment's copies off an ordinary card. */
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      /* Thinking off, because DeepSeek cannot round-trip the blocks. The CLI's
         own refusal text names this variable; a typo would bring the 400 back
         and read as a DeepSeek fault. */
      "MAX_THINKING_TOKENS",
    ]) {
      expect(rust).toContain(name);
    }
  });

  test("an ordinary account, credits and no label are not providers", () => {
    expect(onProvider(DEEPSEEK)).toBe(true);
    expect(onProvider(" @deepseek ")).toBe(true);
    expect(onProvider("@credits")).toBe(false);
    expect(onProvider("claude")).toBe(false);
    expect(onProvider(null)).toBe(false);
    expect(providerName(DEEPSEEK)).toBe("deepseek");
    expect(providerName("claude")).toBeNull();
  });
});

describe("a provider's models are its own", () => {
  test("every provider row names the provider and one of its models", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
    for (const p of PROVIDER_PRESETS) {
      expect(p.provider).toBe("deepseek");
      const provider = PROVIDERS.find((x) => x.id === p.provider)!;
      expect(Object.values(provider.models)).toContain(p.model);
    }
    /* Two models, two rows: choosing a provider and a model is one gesture. */
    expect(PROVIDER_PRESETS.map((p) => p.model)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    for (const p of PROVIDER_PRESETS) expect(presetById(p.id)).toEqual(p);
    /* And they are not in the Claude menu's own table. */
    expect(PRESETS.some((p) => p.provider)).toBe(false);
  });

  test("a Claude alias resolves to the provider's model, and its own id is left alone", () => {
    const ds = providerOf(DEEPSEEK)!;
    expect(providerModel(ds, "opus[1m]")).toBe("deepseek-v4-pro");
    expect(providerModel(ds, "claude-sonnet-5")).toBe("deepseek-flash");
    expect(providerModel(ds, "haiku")).toBe("deepseek-flash");
    expect(providerModel(ds, "deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(providerModel(ds, null)).toBeNull();
  });

  test("a spawned card resolves its provider's names, and refuses the other's", () => {
    expect(presetForSpawn("flash", null, "deepseek")?.model).toBe("deepseek-flash");
    expect(presetForSpawn("pro", null, "deepseek")?.model).toBe("deepseek-v4-pro");
    /* Named without a provider, `pro` can only mean one thing. */
    expect(presetForSpawn("pro", null)?.provider).toBe("deepseek");
    /* A Claude family on deepseek is not silently mapped. */
    expect(presetForSpawn("opus", null, "deepseek")).toBeUndefined();
    /* And an effort rides a provider model as it does a Claude one. */
    expect(presetForSpawn("flash", "low", "deepseek")?.effort).toBe("low");
  });
});
