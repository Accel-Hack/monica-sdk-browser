import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserCaptureContext, MonicaBrowserClient } from "@ah-monica/browser";
import {
  captureReactException,
  MonicaProvider,
  useMonicaCapture,
  useMonica,
} from "../src/index.js";

describe("MONICA React adapter", () => {
  test("provides the existing browser client without recreating transport", () => {
    const client = fakeClient();
    function Consumer() {
      return <span>{useMonica() === client ? "same client" : "wrong client"}</span>;
    }
    expect(renderToStaticMarkup(
      <MonicaProvider client={client}><Consumer /></MonicaProvider>,
    )).toContain("same client");
  });

  test("adds the component stack to contexts.react", async () => {
    let captured: BrowserCaptureContext | undefined;
    const client = fakeClient((context) => { captured = context; });
    await captureReactException(client, new Error("render failed"), "at BotList");
    expect(captured?.tags).toEqual({ integration: "react" });
    expect(captured?.contexts).toEqual({ react: { componentStack: "at BotList" } });
  });

  test("preserves browser capture context while merging hook defaults", () => {
    let captured: BrowserCaptureContext | undefined;
    const client = fakeClient((context) => { captured = context; });
    function Consumer() {
      const capture = useMonicaCapture({
        user: { id: "opaque-user" },
        tags: { feature: "bots" },
        breadcrumbs: [{ category: "route", message: "bots" }],
        fingerprint: ["render", "bots"],
      });
      void capture(new Error("render failed"), {
        tags: { action: "open" },
        request: { method: "GET", url: "https://app.example.test" },
      });
      return <span>captured</span>;
    }

    renderToStaticMarkup(<MonicaProvider client={client}><Consumer /></MonicaProvider>);
    expect(captured).toMatchObject({
      user: { id: "opaque-user" },
      tags: { feature: "bots", action: "open" },
      fingerprint: ["render", "bots"],
      request: { method: "GET", url: "https://app.example.test" },
    });
    expect(captured?.breadcrumbs).toHaveLength(1);
  });
});

function fakeClient(observe?: (context: BrowserCaptureContext) => void): MonicaBrowserClient {
  return {
    async captureException(_error, context = {}) { observe?.(context); return "event-id"; },
    async captureMessage() { return "event-id"; },
    setUser() {},
    addBreadcrumb() {},
    withScope(callback) {
      return callback({ setTag() {}, setUser() {}, setContext() {}, addBreadcrumb() {} });
    },
    async flush() { return { accepted: true, discarded: 0, remaining: 0 }; },
    async close() { return { accepted: true, discarded: 0, remaining: 0 }; },
  };
}
