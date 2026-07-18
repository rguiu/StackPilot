import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_AUTO_COMPACT_AT_TOKENS,
  loadAppConfig,
  saveConfigPatch,
} from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "sp-config-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Env with credentials + an isolated config path.
function env(configFile: string): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_API_KEY: "test-key",
    STACKPILOT_CONFIG: join(dir, configFile),
  };
}

describe("loadAppConfig", () => {
  it("applies defaults when the file is missing", () => {
    const cfg = loadAppConfig(env("missing.toml"));
    expect(cfg.pricing).toEqual({});
    expect(cfg.enabledTools).toBeNull();
    expect(cfg.autoCompactAtTokens).toBe(DEFAULT_AUTO_COMPACT_AT_TOKENS);
  });

  it("parses pricing, tools, and threshold", () => {
    writeFileSync(
      join(dir, "full.toml"),
      [
        "autoCompactAtTokens = 5000",
        "[tools]",
        'enabled = ["Read", "Grep"]',
        '[pricing."m-1"]',
        "inputPerMTok = 1.5",
        "outputPerMTok = 6.0",
        "cacheInputPerMTok = 0.15",
      ].join("\n"),
    );
    const cfg = loadAppConfig(env("full.toml"));
    expect(cfg.autoCompactAtTokens).toBe(5000);
    expect(cfg.enabledTools).toEqual(["Read", "Grep"]);
    expect(cfg.pricing["m-1"]).toEqual({
      inputPerMTok: 1.5,
      outputPerMTok: 6.0,
      cacheInputPerMTok: 0.15,
    });
  });

  it("fails fast on malformed pricing", () => {
    writeFileSync(
      join(dir, "bad.toml"),
      ['[pricing."m"]', 'inputPerMTok = "one"', "outputPerMTok = 2.0"].join(
        "\n",
      ),
    );
    expect(() => loadAppConfig(env("bad.toml"))).toThrow(ConfigError);
  });

  it("fails fast on invalid TOML", () => {
    writeFileSync(join(dir, "invalid.toml"), "not [ valid");
    expect(() => loadAppConfig(env("invalid.toml"))).toThrow(ConfigError);
  });

  it("rejects a negative threshold", () => {
    writeFileSync(join(dir, "neg.toml"), "autoCompactAtTokens = -1");
    expect(() => loadAppConfig(env("neg.toml"))).toThrow(ConfigError);
  });
});

describe("saveConfigPatch", () => {
  it("merges into an existing file without dropping other sections", () => {
    const file = join(dir, "merge.toml");
    writeFileSync(
      file,
      ['[pricing."m-1"]', "inputPerMTok = 1.0", "outputPerMTok = 5.0"].join(
        "\n",
      ),
    );
    const e = { ...env("merge.toml") };
    saveConfigPatch({ enabledTools: ["Read"] }, e);
    saveConfigPatch({ autoCompactAtTokens: 9000 }, e);

    const cfg = loadAppConfig(e);
    expect(cfg.enabledTools).toEqual(["Read"]);
    expect(cfg.autoCompactAtTokens).toBe(9000);
    expect(cfg.pricing["m-1"]?.inputPerMTok).toBe(1.0); // preserved
  });

  it("creates the file and parent directory when missing", () => {
    const e = {
      ANTHROPIC_API_KEY: "k",
      STACKPILOT_CONFIG: join(dir, "deep/new.toml"),
    };
    const path = saveConfigPatch({ enabledTools: [] }, e);
    expect(readFileSync(path, "utf8")).toContain("enabled");
    expect(loadAppConfig(e).enabledTools).toEqual([]);
  });
});
