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

/** transport.json。HTTP 契約の機械可読な形。定数はここから読み、テストに写さない */
type Transport = {
  endpoint: { method: string; path: string; content_type: string; content_encoding: string };
  dsn: { insecure_hosts: string[] };
  auth: Array<{ kind: "secret" | "public"; key_prefix: string; header: string; value: string }>;
  status: Record<string, string>;
  retry: {
    retryable_statuses: string[];
    retry_on_network_error: boolean;
    retry_after: { integer_seconds_only: boolean; max_seconds: number };
    backoff: { base_ms: number; factor: number; max_ms: number; jitter_min: number; jitter_max: number };
  };
};

type Envelope = {
  sdk: { name: string; version: string };
  sent_at: string;
  discarded: number;
  items: Array<Record<string, unknown> & { exception?: { values: Array<{ stacktrace?: { frames: unknown[] } }> } }>;
};

const limits = await spec<Limits>("limits.json");
const transport = await spec<Transport>("transport.json");
const publicAuth = transport.auth.find((entry) => entry.kind === "public");
if (!publicAuth) throw new Error("transport.json に public key の行が無い");

/**
 * status → SDK の挙動。個別のコードが無ければ `5xx` のような範囲を引く
 * （ingest.md の読み方のとおり）
 */
function actionFor(status: number): string {
  const exact = transport.status[String(status)];
  if (exact !== undefined) return exact;
  const range = transport.status[`${Math.floor(status / 100)}xx`];
  if (range === undefined) throw new Error(`transport.json に ${status} の挙動が無い`);
  return range;
}

/** backoff の下限。jitter_min を掛けた値より短く待ってはいけない */
function minimumBackoff(attempt: number): number {
  const { base_ms, factor, max_ms, jitter_min } = transport.retry.backoff;
  return Math.min(base_ms * factor ** attempt, max_ms) * jitter_min;
}

// format は検査しない（配信側の検査と同じ）。schema は形までで、暦の正しさは MONICA 側が弾く
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validateEnvelope: ValidateFunction = ajv.compile(await spec<object>("envelope.json"));

const KEY = `${publicAuth.key_prefix}public_key`;
const DSN = `https://${KEY}@ingest.example.test/some/path/42?ignored=1#frag`;

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
  test("送信先・ヘッダ・鍵の種別が transport.json のとおり", async () => {
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
    expect(request.method).toBe(transport.endpoint.method);
    // DSN の origin に endpoint.path を付けたもの。パス・クエリ・フラグメントは捨てる
    expect(request.url).toBe(`https://ingest.example.test${transport.endpoint.path}`);
    expect(request.headers.get("Content-Type")).toBe(transport.endpoint.content_type);
    expect(request.headers.get("Content-Encoding")).toBe(transport.endpoint.content_encoding);
    // browser は public key。ヘッダは transport.json の public の行。secret の行は使わない
    expect(request.headers.get(publicAuth.header)).toBe(publicAuth.value.replace("<key>", KEY));
    for (const entry of transport.auth) {
      if (entry.kind !== "public") expect(request.headers.get(entry.header)).toBeNull();
    }
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

  test("DSN の鍵の種別と scheme は transport.json のとおり", async () => {
    const base = { environment: "test", window: createRuntime(recorder().fetchImplementation), maxRetries: 0 };
    // secret key は browser へ配布してはいけない
    for (const entry of transport.auth) {
      if (entry.kind === "secret") {
        expect(() => createBrowserClient({ ...base, dsn: `https://${entry.key_prefix}secret@ingest.example.test/1` })).toThrow();
      }
    }
    // https 以外は insecure_hosts に限る
    expect(() => createBrowserClient({ ...base, dsn: `http://${KEY}@ingest.example.test/1` })).toThrow();
    for (const host of transport.dsn.insecure_hosts) {
      expect(() => createBrowserClient({ ...base, dsn: `http://${KEY}@${host}:8787/1` }), host).not.toThrow();
    }

    // password 部分は使わない。鍵は user info の username だけ
    const { sent, fetchImplementation } = recorder();
    const client = createBrowserClient({
      dsn: `https://${KEY}:ignored-password@ingest.example.test/1`,
      environment: "test",
      window: createRuntime(fetchImplementation),
      maxRetries: 0,
    });
    await client.captureMessage("password ignored");
    await client.flush();
    expect(sent[0]!.headers.get(publicAuth.header)).toBe(KEY);
    expect(sent[0]!.url).toBe(`https://ingest.example.test${transport.endpoint.path}`);
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

  test("transport.json の status ごとの挙動を browser が分岐できる語彙で持っている", () => {
    // 語彙が増えるのは互換。消える・変わるのは破壊的変更で、ここで気付く
    const known = new Set(["accept", "drop", "drop_and_stop", "split_and_retry", "wait_retry_after", "backoff"]);
    for (const [status, action] of Object.entries(transport.status)) {
      expect(known.has(action), `${status}: ${action}`).toBe(true);
    }
    expect(actionFor(202)).toBe("accept");
    expect(actionFor(503)).toBe("backoff");
  });

  test("accept は受理としてキューから除く", async () => {
    const accepted = Object.entries(transport.status)
      .filter(([, action]) => action === "accept")
      .map(([status]) => Number(status));
    expect(accepted.length).toBeGreaterThan(0);
    for (const status of accepted) {
      const calls: number[] = [];
      const result = await transportWith([() => new Response(null, { status })], calls).send(envelope);
      expect(result).toEqual({ accepted: true, status });
      expect(calls).toHaveLength(1);
    }
  });

  test("drop は恒久的な失敗としてリトライしない", async () => {
    const dropped = Object.entries(transport.status)
      .filter(([, action]) => action === "drop")
      .map(([status]) => Number(status));
    expect(dropped.length).toBeGreaterThan(0);
    for (const status of dropped) {
      const calls: number[] = [];
      const result = await transportWith([() => new Response(null, { status })], calls).send(envelope);
      expect(result).toEqual({ accepted: false, status });
      expect(calls, `status ${status}`).toHaveLength(1);
    }
  });

  test("drop_and_stop は破棄し、以後の送信を止める", async () => {
    const stopping = Object.entries(transport.status)
      .filter(([, action]) => action === "drop_and_stop")
      .map(([status]) => Number(status));
    expect(stopping.length).toBeGreaterThan(0);
    for (const status of stopping) {
      const calls: number[] = [];
      const client = transportWith([() => new Response(null, { status })], calls);
      expect(await client.send(envelope)).toEqual({ accepted: false, status });
      expect(await client.send(envelope)).toEqual({ accepted: false, status });
      // 2 回目は request を出していない
      expect(calls, `status ${status}`).toHaveLength(1);
    }
  });

  // 以下は実時間で待つ。jitter の上振れを見込んで timeout を広げてある
  const SLOW = { timeout: 20_000 };

  test("wait_retry_after は Retry-After の整数秒だけ待ってから再送する", async () => {
    expect(actionFor(429)).toBe("wait_retry_after");
    expect(transport.retry.retryable_statuses).toContain("429");
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

  test("HTTP-date の Retry-After は解釈せず backoff に落とす（integer_seconds_only）", async () => {
    expect(transport.retry.retry_after.integer_seconds_only).toBe(true);
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
    // attempt 0 の backoff の範囲に収まる（HTTP-date を秒として読んでいない）
    const waited = calls[1]! - calls[0]!;
    expect(waited).toBeGreaterThanOrEqual(minimumBackoff(0) - 50);
    expect(waited).toBeLessThan(transport.retry.backoff.base_ms * transport.retry.backoff.jitter_max + 500);
  }, SLOW);

  test("backoff は base_ms * factor^attempt に jitter を掛けて待ち、上限で捨てる", async () => {
    expect(actionFor(503)).toBe("backoff");
    expect(transport.retry.retryable_statuses).toContain("5xx");
    const calls: number[] = [];
    const result = await transportWith([() => new Response(null, { status: 503 })], calls).send(envelope);
    expect(result).toEqual({ accepted: false, status: 503 });
    // maxRetries: 2 なので 3 回で止まる。無限に溜めない
    expect(calls).toHaveLength(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(minimumBackoff(0) - 50);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(minimumBackoff(1) - 50);
  }, SLOW);

  test("ネットワーク障害はリトライする（retry_on_network_error）", async () => {
    expect(transport.retry.retry_on_network_error).toBe(true);
    const network: number[] = [];
    const failed = await transportWith(
      [() => new Error("network down"), () => new Response(null, { status: 202 })],
      network,
    ).send(envelope);
    expect(failed).toEqual({ accepted: true, status: 202 });
    expect(network).toHaveLength(2);
  }, SLOW);
});
