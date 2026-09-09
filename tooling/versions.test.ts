/**
 * version が root の package.json と揃っているか。
 *
 * 配る先を 1 つでも忘れると、react が registry の古い browser をリンクして
 * テストが古い browser に対して通る、または envelope の sdk.version が嘘になる。
 * release workflow も同じ検査をするが、tag を打つ前の PR で止める。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { CLIENT_VERSION, root, rootVersion } from "./set-version";

async function manifest(name: string): Promise<{ version: string; dependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(resolve(root, name, "package.json"), "utf8"));
}

describe("version は root の package.json が正本", () => {
  test("browser / react の version と react の browser 依存が root と一致する", async () => {
    const version = await rootVersion();
    const browser = await manifest("browser");
    const react = await manifest("react");
    expect(browser.version).toBe(version);
    expect(react.version).toBe(version);
    expect(react.dependencies?.["@ah-monica/browser"]).toBe(version);
  });

  test("browser/src/client.ts の sdk.version が root と一致する", async () => {
    const version = await rootVersion();
    const client = await readFile(resolve(root, "browser/src/client.ts"), "utf8");
    const found = CLIENT_VERSION.exec(client);
    expect(found?.[2]).toBe(version);
  });

  test("bun.lock が @ah-monica/browser を registry ではなく workspace で解決している", async () => {
    const lock = await readFile(resolve(root, "bun.lock"), "utf8");
    // workspace 解決は "@ah-monica/browser@workspace:browser"。registry から取ると
    // "@ah-monica/browser@0.1.x" になる
    expect(lock).toMatch(/"@ah-monica\/browser": \["@ah-monica\/browser@workspace:browser"/);
  });
});
