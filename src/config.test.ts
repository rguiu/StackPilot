import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_AUTO_COMPACT_AT_TOKENS,
  loadAppConfig,
  resolveBedrockModel,
  resolveConfig,
  saveConfigPatch,
  useBedrock,
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
    expect(cfg.confineToWorkspace).toBe(false);
  });

  it("parses confineToWorkspace and rejects non-booleans", () => {
    writeFileSync(join(dir, "confine.toml"), "confineToWorkspace = true\n");
    expect(loadAppConfig(env("confine.toml")).confineToWorkspace).toBe(true);

    writeFileSync(join(dir, "bad.toml"), 'confineToWorkspace = "yes"\n');
    expect(() => loadAppConfig(env("bad.toml"))).toThrow(
      /confineToWorkspace must be a boolean/,
    );
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

describe("Bedrock config", () => {
  it("useBedrock reads the CLAUDE_CODE_USE_BEDROCK switch", () => {
    expect(useBedrock({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(useBedrock({ CLAUDE_CODE_USE_BEDROCK: "true" })).toBe(true);
    expect(useBedrock({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
    expect(useBedrock({ CLAUDE_CODE_USE_BEDROCK: "false" })).toBe(false);
    expect(useBedrock({ CLAUDE_CODE_USE_BEDROCK: "" })).toBe(false);
    expect(useBedrock({})).toBe(false);
  });

  it("resolveBedrockModel maps aliases to inference-profile ids", () => {
    const env = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "eu.anthropic.claude-opus-4-1-v1:0",
    };
    expect(resolveBedrockModel("haiku", env)).toBe(
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(resolveBedrockModel("opus", env)).toBe(
      "eu.anthropic.claude-opus-4-1-v1:0",
    );
    // A full id passes through unchanged.
    expect(resolveBedrockModel("eu.anthropic.claude-x-v1:0", env)).toBe(
      "eu.anthropic.claude-x-v1:0",
    );
  });

  it("resolveConfig uses the Bedrock base URL, no API key required", () => {
    const cfg = resolveConfig({
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:8080",
      AWS_REGION: "eu-west-1",
      ANTHROPIC_MODEL: "haiku",
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(cfg.provider).toBe("bedrock");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8080");
    expect(cfg.model).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(cfg.region).toBe("eu-west-1");
    expect(cfg.apiKey).toBe("");
  });

  it("resolveConfig falls back to the AWS host when no proxy URL is set", () => {
    const cfg = resolveConfig({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    });
    expect(cfg.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("still requires an API key in direct-Anthropic mode", () => {
    expect(() => resolveConfig({}, {}, "/nonexistent-home")).toThrow(
      ConfigError,
    );
  });

  it("direct-Anthropic mode sets provider anthropic", () => {
    const cfg = resolveConfig({ ANTHROPIC_API_KEY: "k" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.baseUrl).toBe("https://api.anthropic.com");
  });
});
