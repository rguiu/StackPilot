import { describe, expect, it } from "vitest";
import { isBlockedAddress, webFetchTool } from "./webfetch.js";

describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["::1", true],
    ["fe80::1", true],
    ["fd00::1", true],
    ["::ffff:127.0.0.1", true],
    ["2606:4700:4700::1111", false],
  ])("%s → blocked=%s", (ip, expected) => {
    expect(isBlockedAddress(ip)).toBe(expected);
  });
});

describe("webFetchTool guard", () => {
  it("rejects non-http(s) schemes", async () => {
    const res = await webFetchTool.execute({ url: "file:///etc/passwd" }, "/");
    expect(res.isError).toBe(true);
    expect(res.output).toContain("http");
  });

  it("refuses localhost", async () => {
    const res = await webFetchTool.execute(
      { url: "http://localhost:8080/admin" },
      "/",
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("internal");
  });

  it("refuses the cloud metadata address", async () => {
    const res = await webFetchTool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      "/",
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("internal");
  });

  it("refuses a literal private IP", async () => {
    const res = await webFetchTool.execute({ url: "http://192.168.0.1/" }, "/");
    expect(res.isError).toBe(true);
  });
});
