import { describe, expect, test } from "bun:test";
import type { FetchLike, MonicaItem } from "@ah-monica/core";
import { createBrowserClient } from "../src/index.js";
import { createBrowserTransport } from "../src/transport.js";

class FakeXmlHttpRequest extends EventTarget {
  status = 200;
  responseURL = "";

  open(_method: string, url: string | URL): void {
    this.responseURL = String(url);
  }

  send(): void {
    this.dispatchEvent(new Event("loadend"));
  }
}

function createRuntime(
  fetchImplementation: FetchLike = async () => new Response(null, { status: 202 }),
): Window & typeof globalThis {
  const runtime = new EventTarget() as EventTarget & Record<string, unknown>;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = "visible";
  runtime.location = { href: "https://app.example.test/form/follow/private-token?token=hidden" };
  runtime.document = document;
  runtime.XMLHttpRequest = FakeXmlHttpRequest;
  runtime.fetch = fetchImplementation;
  runtime.console = { error() {} };
  return runtime as unknown as Window & typeof globalThis;
}

describe("createBrowserClient", () => {
  test("captures page, screen and release without collecting a user implicitly", async () => {
    let captured: MonicaItem | undefined;
    const runtime = createRuntime();
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      release: "abc123",
      screenId: "checkout",
      window: runtime,
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
    });

    await client.captureException(new Error("boom"));
    await client.flush();

    expect(captured?.platform).toBe("javascript");
    expect(captured?.release).toBe("abc123");
    expect(captured?.tags).toEqual({ "screen.id": "checkout" });
    expect(captured?.request).toEqual({
      url: "https://app.example.test",
      method: "GET",
    });
    expect(captured?.user).toBeUndefined();
    await client.close();
  });

  test("adds only an explicitly configured safe route template", async () => {
    let captured: MonicaItem | undefined;
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      route: "/form/follow/{token}",
      window: createRuntime(),
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
    });

    await client.captureMessage("safe route");
    await client.flush();
    expect(captured?.request?.url).toBe("https://app.example.test/form/follow/{token}");
    await client.close();
  });

  test("removes credentials, query and fragment from stack frame URLs", async () => {
    let captured: MonicaItem | undefined;
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: createRuntime(),
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
    });
    const error = new Error("private stack URL");
    error.stack = [
      "Error: private stack URL",
      "    at submit (https://user:password@app.example.test/assets/app.js?token=hidden#part:10:2)",
    ].join("\n");

    await client.captureException(error);
    await client.flush();
    expect(captured?.exception?.values[0]?.stacktrace?.frames[0]?.filename).toBe(
      "https://app.example.test/assets/app.js",
    );
    await client.close();
  });

  test("sends a user only after explicit setUser", async () => {
    let captured: MonicaItem | undefined;
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: createRuntime(),
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
    });
    client.setUser({ id: "opaque-user" });
    client.addBreadcrumb({
      category: "manual",
      message: "explicit breadcrumb",
      timestamp: undefined,
    });
    await client.captureMessage("explicit user");
    await client.flush();
    expect(captured?.user).toEqual({ id: "opaque-user" });
    expect(captured?.breadcrumbs?.[0]?.timestamp).toBeString();
    await client.close();
  });

  test("captures window errors and deduplicates them inside the one-second window", async () => {
    const captured: MonicaItem[] = [];
    let currentTime = 100;
    const runtime = createRuntime();
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: runtime,
      now: () => new Date(currentTime),
      beforeSend(item) {
        captured.push(structuredClone(item));
        return item;
      },
      flushIntervalMs: 60_000,
    });
    const dispatch = () => {
      const event = new Event("error");
      Object.assign(event, {
        error: new Error("same failure"),
        message: "same failure",
        filename: "https://app.example.test/app.js",
        lineno: 10,
        colno: 2,
      });
      runtime.dispatchEvent(event);
    };
    dispatch();
    currentTime = 500;
    dispatch();
    await client.flush();

    expect(captured).toHaveLength(2);
    expect(captured[0]?.exception?.values[0]?.mechanism).toEqual({
      type: "onerror",
      handled: false,
    });
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: "promise failed" });
    runtime.dispatchEvent(rejection);
    await client.flush();
    expect(captured[2]?.exception?.values[0]?.mechanism).toEqual({
      type: "onunhandledrejection",
      handled: false,
    });
    runtime.console.error("console is off");
    await client.flush();
    expect(captured).toHaveLength(3);

    const sent: Request[] = [];
    const dedupedClient = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: createRuntime(async (input, init) => {
        sent.push(new Request(input, init));
        return new Response(null, { status: 202 });
      }),
      now: () => new Date(500),
      maxRetries: 0,
      flushIntervalMs: 60_000,
    });
    const error = new Error("dedupe");
    await dedupedClient.captureException(error);
    await dedupedClient.captureException(error);
    await dedupedClient.flush();
    const envelope = await decodeEnvelope(sent[0]);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].exception.values[0].mechanism).toEqual({
      type: "generic",
      handled: true,
    });
    await client.close();
    await dedupedClient.close();
  });

  test("records failed XMLHttpRequest calls as sanitized breadcrumbs", async () => {
    let captured: MonicaItem | undefined;
    const runtime = createRuntime();
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: runtime,
      beforeSend(item) {
        captured = structuredClone(item);
        return null;
      },
    });

    const request = new runtime.XMLHttpRequest();
    Object.assign(request, { status: 500 });
    request.open("POST", "https://api.example.test/accounts/private-id?access_token=secret");
    request.send();
    await client.captureMessage("after xhr");
    await client.flush();

    expect(captured?.breadcrumbs?.[0]).toMatchObject({
      type: "http",
      category: "xhr",
      level: "warning",
      message: "POST https://api.example.test",
      data: {
        method: "POST",
        url: "https://api.example.test",
        status: 500,
      },
    });
    await client.close();
  });

  test("contains transport failures and does not retry forever", async () => {
    let attempts = 0;
    const runtime = createRuntime(async () => {
      attempts += 1;
      throw new Error("network down");
    });
    const client = createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: runtime,
      maxRetries: 0,
      autoCapture: true,
    });
    await client.captureMessage("send once");
    expect((await client.flush()).accepted).toBeFalse();
    expect(attempts).toBe(1);
    await client.close();
  });

  test("rejects transport options that could disable timeout or retry bounds", () => {
    expect(() => createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: createRuntime(),
      requestTimeoutMs: 0,
    })).toThrow("requestTimeoutMs must be a positive integer");
    expect(() => createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: createRuntime(),
      maxRetries: -1,
    })).toThrow("maxRetries must be a non-negative integer");
    expect(() => createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      route: "/accounts/private?token=secret",
      window: createRuntime(),
    })).toThrow("route must be a path template");
  });

  test("rejects secret DSNs and missing fetch before capturing", () => {
    expect(() => createBrowserClient({
      dsn: "https://msk_secret@ingest.example.test/1",
      environment: "test",
      window: createRuntime(),
    })).toThrow("public mpk_ key");

    const runtime = createRuntime();
    Object.assign(runtime, { fetch: undefined });
    expect(() => createBrowserClient({
      dsn: "https://mpk_public@ingest.example.test/1",
      environment: "test",
      window: runtime,
    })).toThrow("A fetch implementation is required");

    expect(() => createBrowserClient({
      dsn: "ftp://mpk_public@localhost/1",
      environment: "test",
      window: createRuntime(),
    })).toThrow("dsn must use https except for localhost");
  });

  test("does not start transport work for an already-aborted operation", async () => {
    let attempts = 0;
    const transport = createBrowserTransport({
      dsn: "https://mpk_public@ingest.example.test/1",
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 202 });
      },
      requestTimeoutMs: 2_000,
      maxRetries: 0,
      onSendingChange() {},
    });
    const controller = new AbortController();
    controller.abort();
    const result = await transport.send({
      sdk: { name: "test", version: "1" },
      sent_at: "2026-08-30T00:00:00.000Z",
      discarded: 0,
      items: [],
    }, controller.signal);

    expect(result.accepted).toBeFalse();
    expect(attempts).toBe(0);
  });
});

async function decodeEnvelope(request: Request) {
  if (!request.body) throw new Error("request body missing");
  const body = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(body).json() as Promise<{
    items: Array<{
      exception: {
        values: Array<{ mechanism: { type: string; handled: boolean } }>;
      };
    }>;
  }>;
}
