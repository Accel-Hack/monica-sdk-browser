/**
 * browser SDK が実際に送る envelope が公開契約（spec/v1）に合っているか。
 *
 * vectors を schema で回すのは tooling/spec-bundle.test.ts に任せる。ここで
 * 見るのは「この SDK が組んだ request」そのもの。gzip した body を戻して
 * JSON Schema に通し、ヘッダと送信先が ingest.md の言うとおりかを見る。
 * 契約が締まる方向に変わったとき、このテストが落ちて実装を直す場所になる。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { FetchLike } from "@ah-monica/core";

import { createBrowserClient } from "../src/index.js";
import { createBrowserTransport } from "../src/transport.js";

const specRoot = join(import.meta.dir, "../../spec/v1");
const packageJson = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")) as {
  name: string;
  version: string;
};

async function spec<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(join(specRoot, path), "utf8")) as T;
  } catch (error) {
    // skip はしない。契約が見つからない状態で green にすると、契約が変わっても
    // browser だけ気付けない
    throw new Error(`spec/v1/${path} が読めない。bun run spec:sync で取り込む: ${(error as Error).message}`);
  }
}

type Limits = {
  envelope_gzip_bytes: number;
  envelope_decompressed_bytes: number;
  items_per_envelope: number;
  frames_per_stacktrace: number;
};

type Envelope = {
  sdk: { name: string; version: string };
  sent_at: string;
  discarded: number;
  items: Array<Record<string, unknown> & { exception?: { values: Array<{ stacktrace?: { frames: unknown[] } }> } }>;
};

const limits = await spec<Limits>("limits.json");
// format は検査しない（配信側の検査と同じ）。schema は形までで、暦の正しさは MONICA 側が弾く
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validateEnvelope: ValidateFunction = ajv.compile(await spec<object>("envelope.json"));

const DSN = "https://mpk_public_key@ingest.example.test/some/path/42?ignored=1#frag";

class FakeXmlHttpRequest extends EventTarget {
  status = 200;
  open(_method: string, _url: string | URL): void {}
  send(): void {
    this.dispatchEvent(new Event("loadend"));
  }
}

function createRuntime(fetchImplementation: FetchLike): Window & typeof globalThis {
  const runtime = new EventTarget() as EventTarget & Record<string, unknown>;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = "visible";
  runtime.location = { href: "https://app.example.test/orders/123?token=hidden" };
  runtime.document = document;
  runtime.XMLHttpRequest = FakeXmlHttpRequest;
  runtime.fetch = fetchImplementation;
  runtime.console = { error() {} };
  return runtime as unknown as Window & typeof globalThis;
}

function recorder(status = 202) {
  const sent: Request[] = [];
  const fetchImplementation: FetchLike = async (input, init) => {
    sent.push(new Request(input, init));
    return new Response(null, { status });
  };
  return { sent, fetchImplementation };
}

async function decodeEnvelope(request: Request): Promise<Envelope> {
  if (!request.body) throw new Error("request body missing");
  const decompressed = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).json() as Promise<Envelope>;
}

function expectValid(envelope: unknown): void {
  const ok = validateEnvelope(envelope);
  expect(ok, JSON.stringify(validateEnvelope.errors, null, 2)).toBe(true);
}

describe("browser SDK と公開契約", () => {
  test("送信先・ヘッダ・鍵の種別が ingest.md のとおり", async () => {
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
    });
    await client.captureMessage("contract");
    await client.flush();

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.method).toBe("POST");
    // DSN の origin に /v1/envelope を付けたもの。パス・クエリ・フラグメントは捨てる
    expect(request.url).toBe("https://ingest.example.test/v1/envelope");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("Content-Encoding")).toBe("gzip");
    // browser は public key。ヘッダは X-Monica-Key で、Authorization は使わない
    expect(request.headers.get("X-Monica-Key")).toBe("mpk_public_key");
    expect(request.headers.get("Authorization")).toBeNull();
    // 1 リクエスト = 1 envelope の JSON を gzip したもの
    const envelope = await decodeEnvelope(request);
    expect(envelope.items).toHaveLength(1);
    await client.close();
  });

  test("sdk.name は配布 registry の package 名、sdk.version は package.json と同じ", async () => {
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
    });
    await client.captureMessage("sdk identity");
    await client.flush();
    const envelope = await decodeEnvelope(sent[0]!);

    expect(envelope.sdk.name).toBe(packageJson.name);
    // client.ts に埋めた version が package.json と食い違うと、取り込み状況の
    // 集計単位（sdk.name / sdk.version）が嘘になる。version を上げたら両方直す
    expect(envelope.sdk.version).toBe(packageJson.version);
    expectValid(envelope);
    await client.close();
  });

  test("context をすべて載せた例外が envelope.json を通る", async () => {
    const { sent, fetchImplementation } = recorder();
    const runtime = createRuntime(fetchImplementation);
    const client = createBrowserClient({
      dsn: DSN,
      environment: "production",
      release: "2026.09.08+1",
      screenId: "orders",
      route: "/orders/{orderId}",
      window: runtime,
      maxRetries: 0,
    });
    client.setUser({ id: "u_1", email: "user@example.test" });
    client.addBreadcrumb({ category: "ui.click", message: "button#submit", level: "info", data: { x: 1 } });

    // 失敗した XHR は breadcrumb になる
    const xhr = new runtime.XMLHttpRequest();
    Object.assign(xhr, { status: 503 });
    xhr.open("GET", "https://api.example.test/orders?token=secret");
    xhr.send();

    const inner = new Error("inner failure");
    inner.stack = [
      "Error: inner failure",
      "    at load (https://app.example.test/assets/app.js:10:2)",
      "    at https://cdn.example.test/node_modules/lib/index.js:1:1",
    ].join("\n");
    const outer = new Error("outer failure", { cause: inner });
    outer.stack = ["Error: outer failure", "    at submit (https://app.example.test/assets/app.js:42:7)"].join("\n");

    await client.captureException(outer, {
      level: "fatal",
      tags: { feature: "checkout" },
      contexts: { browser: { name: "test" } },
      fingerprint: ["checkout", "submit"],
    });
    await client.flush();

    const envelope = await decodeEnvelope(sent[0]!);
    expectValid(envelope);
    const item = envelope.items[0]!;
    expect(item.type).toBe("error");
    expect(item.platform).toBe("javascript");
    expect(item.level).toBe("fatal");
    expect(item.release).toBe("2026.09.08+1");
    expect(item.tags).toEqual({ "screen.id": "orders", feature: "checkout" });
    expect(item.fingerprint).toEqual(["checkout", "submit"]);
    // payload.md: exception.values は外側から内側の順
    const values = item.exception!.values as Array<{ value: string; mechanism: unknown; stacktrace?: { frames: Array<{ in_app: boolean; filename: string }> } }>;
    expect(values.map((value) => value.value)).toEqual(["outer failure", "inner failure"]);
    expect(values[0]!.mechanism).toEqual({ type: "generic", handled: true });
    // payload.md: in_app は node_modules を false にし、filename は空にしない
    const innerFrames = values[1]!.stacktrace!.frames;
    expect(innerFrames.map((frame) => frame.in_app)).toEqual([false, true]);
    expect(innerFrames.every((frame) => frame.filename.length > 0)).toBe(true);
    // payload.md: 実 pathname は載せず、明示した route template だけ
    expect(item.request).toEqual({ url: "https://app.example.test/orders/{orderId}", method: "GET" });
    // page URL と XHR の URL に入っていた token が body のどこにも出ていない
    expect(JSON.stringify(envelope)).not.toContain("token=");
    await client.close();
  });

  test("空の fingerprint は載せない（schema は minItems: 1）", async () => {
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
    });
    await client.captureMessage("no fingerprint", "info", { fingerprint: [] });
    await client.flush();
    const envelope = await decodeEnvelope(sent[0]!);
    expect(envelope.items[0]!).not.toHaveProperty("fingerprint");
    expectValid(envelope);
    await client.close();
  });

  test("DSN の鍵の種別と scheme は ingest.md のとおり", async () => {
    const base = { environment: "test", window: createRuntime(recorder().fetchImplementation), maxRetries: 0 };
    // secret key は browser へ配布してはいけない
    expect(() => createBrowserClient({ ...base, dsn: "https://msk_secret@ingest.example.test/1" })).toThrow();
    // https 以外は localhost / 127.0.0.1 に限る
    expect(() => createBrowserClient({ ...base, dsn: "http://mpk_public@ingest.example.test/1" })).toThrow();
    expect(() => createBrowserClient({ ...base, dsn: "http://mpk_public@localhost:8787/1" })).not.toThrow();
    expect(() => createBrowserClient({ ...base, dsn: "http://mpk_public@127.0.0.1:8787/1" })).not.toThrow();

    // password 部分は使わない。鍵は user info の username だけ
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: "https://mpk_public:ignored-password@ingest.example.test/1",
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
    });
    await client.captureMessage("password ignored");
    await client.flush();
    expect(sent[0]!.headers.get("X-Monica-Key")).toBe("mpk_public");
    expect(sent[0]!.url).toBe("https://ingest.example.test/v1/envelope");
    await client.close();
  });

  test("global handler 経由の error / unhandledrejection も envelope.json を通る", async () => {
    const { sent, fetchImplementation } = recorder();
    const runtime = createRuntime(fetchImplementation);
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: runtime,
      maxRetries: 0,
      dedupeWindowMs: 0,
    });

    const errorEvent = new Event("error");
    Object.assign(errorEvent, {
      error: undefined,
      message: "Script error.",
      filename: "https://app.example.test/legacy.js?v=3",
      lineno: 12,
      colno: 5,
    });
    runtime.dispatchEvent(errorEvent);

    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: { code: "E_PLAIN_OBJECT" } });
    runtime.dispatchEvent(rejection);

    await client.flush();
    const envelope = await decodeEnvelope(sent[0]!);
    expectValid(envelope);
    const mechanisms = envelope.items.map(
      (item) => (item.exception!.values[0] as { mechanism: { type: string; handled: boolean } }).mechanism,
    );
    expect(mechanisms).toEqual([
      { type: "onerror", handled: false },
      { type: "onunhandledrejection", handled: false },
    ]);
    await client.close();
  });

  test.each([
    ["既定の設定", {}],
    ["batchSize を上限より大きくしても", { batchSize: limits.items_per_envelope + 50 }],
  ])("limits.json の上限を envelope 側で守る（%s）", async (_label, overrides) => {
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
      dedupeWindowMs: 0,
      maxQueueSize: limits.items_per_envelope * 2,
      flushIntervalMs: 60_000,
      ...overrides,
    });

    const deep = new Error("deep stack");
    deep.stack = [
      "Error: deep stack",
      ...Array.from({ length: limits.frames_per_stacktrace + 50 }, (_, i) => `    at f${i} (https://app.example.test/app.js:${i + 1}:1)`),
    ].join("\n");
    await client.captureException(deep);
    for (let i = 0; i < limits.items_per_envelope + 20; i += 1) {
      await client.captureMessage(`message ${i}`);
    }
    await client.flush();

    // 上限を超える分は envelope を分割する。件数の合計は core のキュー挙動で、
    // ここでは見ない。見るのは「1 envelope が上限を超えない」こと
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      const envelope = await decodeEnvelope(request);
      expectValid(envelope);
      expect(envelope.items.length).toBeLessThanOrEqual(limits.items_per_envelope);
      expect(Number.isSafeInteger(envelope.discarded) && envelope.discarded >= 0).toBe(true);
      for (const item of envelope.items) {
        for (const value of item.exception?.values ?? []) {
          expect(value.stacktrace?.frames.length ?? 0).toBeLessThanOrEqual(limits.frames_per_stacktrace);
        }
      }
    }
    await client.close();
  });

  test("timestamp は timezone 付きの RFC 3339", async () => {
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
      now: () => new Date("2026-09-08T09:00:00.000+09:00"),
    });
    client.addBreadcrumb({ category: "manual", message: "before" });
    await client.captureMessage("timestamps");
    await client.flush();
    const envelope = await decodeEnvelope(sent[0]!);
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    expect(envelope.sent_at).toMatch(rfc3339);
    expect(envelope.items[0]!.timestamp).toMatch(rfc3339);
    const breadcrumbs = envelope.items[0]!.breadcrumbs as Array<{ timestamp: string }>;
    expect(breadcrumbs[0]!.timestamp).toMatch(rfc3339);
    await client.close();
  });
});

describe("browser transport とレスポンスの契約", () => {
  const envelope = {
    sdk: { name: packageJson.name, version: packageJson.version },
    sent_at: "2026-09-08T00:00:00.000Z",
    discarded: 0,
    items: [],
  };

  function transportWith(responses: Array<() => Response | Error>, calls: number[] = []) {
    let attempt = 0;
    return createBrowserTransport({
      dsn: DSN,
      fetch: async () => {
        calls.push(Date.now());
        const next = responses[Math.min(attempt, responses.length - 1)]!;
        attempt += 1;
        const result = next();
        if (result instanceof Error) throw result;
        return result;
      },
      requestTimeoutMs: 2_000,
      maxRetries: 2,
      onSendingChange() {},
    });
  }

  test("202 は受理としてキューから除く", async () => {
    const calls: number[] = [];
    const result = await transportWith([() => new Response(null, { status: 202 })], calls).send(envelope);
    expect(result).toEqual({ accepted: true, status: 202 });
    expect(calls).toHaveLength(1);
  });

  test("400 / 422 は恒久的な失敗としてリトライしない", async () => {
    for (const status of [400, 422]) {
      const calls: number[] = [];
      const result = await transportWith([() => new Response(null, { status })], calls).send(envelope);
      expect(result).toEqual({ accepted: false, status });
      expect(calls, `status ${status}`).toHaveLength(1);
    }
  });

  test("401 は破棄し、以後の送信を止める", async () => {
    const calls: number[] = [];
    const transport = transportWith([() => new Response(null, { status: 401 })], calls);
    expect(await transport.send(envelope)).toEqual({ accepted: false, status: 401 });
    expect(await transport.send(envelope)).toEqual({ accepted: false, status: 401 });
    // 2 回目は request を出していない
    expect(calls).toHaveLength(1);
  });

  // 以下は実時間で待つ。jitter の上振れを見込んで timeout を広げてある
  const SLOW = { timeout: 20_000 };

  test("429 は Retry-After の整数秒だけ待ってから再送する", async () => {
    const calls: number[] = [];
    const result = await transportWith(
      [
        () => new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
        () => new Response(null, { status: 202 }),
      ],
      calls,
    ).send(envelope);
    expect(result).toEqual({ accepted: true, status: 202 });
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(950);
  }, SLOW);

  test("HTTP-date の Retry-After は解釈せず backoff に落とす", async () => {
    const calls: number[] = [];
    const result = await transportWith(
      [
        () => new Response(null, { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
        () => new Response(null, { status: 202 }),
      ],
      calls,
    ).send(envelope);
    expect(result).toEqual({ accepted: true, status: 202 });
    expect(calls).toHaveLength(2);
    // attempt 0 の backoff: 1000ms の 50〜100%
    const waited = calls[1]! - calls[0]!;
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(1_500);
  }, SLOW);

  test("5xx は backoff してリトライし、上限で捨てる", async () => {
    const calls: number[] = [];
    const result = await transportWith([() => new Response(null, { status: 503 })], calls).send(envelope);
    expect(result).toEqual({ accepted: false, status: 503 });
    // maxRetries: 2 なので 3 回で止まる。無限に溜めない
    expect(calls).toHaveLength(3);
    // backoff は 1000 * 2^attempt に 50〜100% の jitter
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(450);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(950);
  }, SLOW);

  test("ネットワーク障害はリトライする", async () => {
    const network: number[] = [];
    const failed = await transportWith(
      [() => new Error("network down"), () => new Response(null, { status: 202 })],
      network,
    ).send(envelope);
    expect(failed).toEqual({ accepted: true, status: 202 });
    expect(network).toHaveLength(2);
  }, SLOW);
});
