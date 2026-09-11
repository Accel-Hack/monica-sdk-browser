/**
 * 422 の error body（spec/v1/error.json）を読んで警告し、結果に載せるところ。
 *
 * ingest は直すべき field の path を返しているのに、SDK が body を読まないと
 * 「1 件も送れていない」ことに誰も気付けない。ここで見るのは「届く」ことと、
 * 「読めない body でも従来どおり破棄で終わる」ことの両方。
 */
import { describe, expect, test } from "bun:test";
import type { FetchLike, MonicaEnvelope } from "@ah-monica/core";
import { createBrowserClient } from "../src/index.js";
import { createBrowserTransport, type BrowserTransport } from "../src/transport.js";
import type {
  BrowserClientOptions,
  BrowserDiagnosticHandler,
  BrowserTransportResult,
  MonicaIngestIssue,
} from "../src/types.js";

const DSN = "https://mpk_public@ingest.example.test/1";

const envelope: MonicaEnvelope = {
  sdk: { name: "@ah-monica/browser", version: "0.1.2" },
  sent_at: "2026-09-10T00:00:00.000Z",
  discarded: 0,
  items: [],
};

const INVALID_ENVELOPE = JSON.stringify({
  error: {
    code: "invalid_envelope",
    message: "envelope failed validation",
    issues: [
      { path: "$.items[0].request.method", message: "Invalid type: Expected string" },
      { path: "$.items[0].level", message: "Invalid enum value" },
    ],
  },
});

interface Options {
  status?: number;
  body?: string | null;
  responses?: Array<{ status: number; body?: string | null; headers?: Record<string, string> }>;
  maxRetries?: number;
  onDiagnostic?: BrowserDiagnosticHandler | null | false;
}

function createTransport(options: Options = {}): {
  transport: BrowserTransport;
  responses: Response[];
} {
  const plan = options.responses
    ?? [{
      status: options.status ?? 422,
      body: "body" in options ? options.body : INVALID_ENVELOPE,
    }];
  const responses: Response[] = [];
  let attempt = 0;
  const transport = createBrowserTransport({
    dsn: DSN,
    fetch: async () => {
      const next = plan[Math.min(attempt, plan.length - 1)]!;
      attempt += 1;
      const response = new Response(next.body ?? null, {
        status: next.status,
        headers: next.headers,
      });
      responses.push(response);
      return response;
    },
    requestTimeoutMs: 2_000,
    maxRetries: options.maxRetries ?? 0,
    onSendingChange() {},
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
  return { transport, responses };
}

/** 既定の警告経路は global の console.warn。差し替えて中身を見る */
async function captureWarnings<T>(body: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map((value) => String(value)).join(" "));
  };
  try {
    return { result: await body(), warnings };
  } finally {
    console.warn = original;
  }
}

function createRuntime(fetchImplementation: FetchLike): Window & typeof globalThis {
  const runtime = new EventTarget() as EventTarget & Record<string, unknown>;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = "visible";
  runtime.location = { href: "https://app.example.test/orders/1" };
  runtime.document = document;
  runtime.XMLHttpRequest = undefined;
  runtime.fetch = fetchImplementation;
  runtime.console = { error() {} };
  return runtime as unknown as Window & typeof globalThis;
}

function createClient(status: number, body: string | null, overrides: Partial<BrowserClientOptions> = {}) {
  const fetchImplementation: FetchLike = async () => new Response(body, { status });
  return createBrowserClient({
    dsn: DSN,
    environment: "test",
    window: createRuntime(fetchImplementation),
    maxRetries: 0,
    flushIntervalMs: 60_000,
    autoCapture: false,
    ...overrides,
  });
}

describe("422 の診断", () => {
  test("issues の path が警告に出て、結果からも取れる", async () => {
    const { transport } = createTransport();
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    expect(result.accepted).toBeFalse();
    expect(result.status).toBe(422);
    expect(result.error).toEqual({
      code: "invalid_envelope",
      message: "envelope failed validation",
    });
    expect(result.issues).toEqual([
      { path: "$.items[0].request.method", message: "Invalid type: Expected string" },
      { path: "$.items[0].level", message: "Invalid enum value" },
    ]);

    // 1 envelope につき 1 回。書式は SDK 横断で 1 行に揃えている（文面で検索できるように）
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 422 (invalid_envelope): 2 issue(s)"
      + "; $.items[0].request.method: Invalid type: Expected string"
      + "; $.items[0].level: Invalid enum value",
    ]);
    // 鍵は出さない
    expect(warnings[0]).not.toContain("mpk_public");
  });

  test("issues の無い 422 でも破棄した旨を 1 行出す", async () => {
    const body = JSON.stringify({ error: { code: "invalid_envelope", message: "bad" } });
    const { transport } = createTransport({ body });
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    expect(result.issues).toBeUndefined();
    expect(result.error?.code).toBe("invalid_envelope");
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 422 (invalid_envelope): 0 issue(s)",
    ]);
  });

  test("path / message が string でない issue は捨てる", async () => {
    const body = JSON.stringify({
      error: {
        code: "invalid_envelope",
        message: "bad",
        issues: [
          { path: 1, message: "not a path" },
          { path: "$.items[0].level", message: null },
          "not an object",
          { path: "$.discarded", message: "Invalid type" },
        ],
      },
    });
    const { transport } = createTransport({ body });
    const { result } = await captureWarnings(() => transport.send(envelope));
    expect(result.issues).toEqual([{ path: "$.discarded", message: "Invalid type" }]);
  });

  test.each([
    ["空 body", null],
    ["JSON でない", "not json at all"],
    ["JSON だが object でない", "[1,2,3]"],
    ["error が object でない", JSON.stringify({ error: "nope" })],
    ["code / message が string でない", JSON.stringify({ error: { code: 1, message: 2 } })],
    ["error が無い", JSON.stringify({ detail: "nope" })],
    ["上限を超える body", JSON.stringify({ error: { code: "x", message: "y".repeat(70 * 1024) } })],
  ])("適合しない body（%s）でも例外を投げず破棄で終わる", async (_label, body) => {
    const { transport } = createTransport({ body });
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    // 形が違えば error も issues も採らない。上限判定や型ガードを外すと
    // ここが落ちる（`(unknown)` のまま出ることまで固定する）
    expect(result).toEqual({ accepted: false, status: 422 });
    expect(result.error).toBeUndefined();
    expect(result.issues).toBeUndefined();
    // 読めなくても「422 で破棄した」ことは伝える
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 422 (unknown): 0 issue(s)",
    ]);
  });

  test("凍結してあるので handler が書き換えても flush() で読む値は変わらない", async () => {
    // handler の中で assert すると report の catch に飲まれるので、外で見る
    const received: BrowserTransportResult[] = [];
    const client = createClient(422, INVALID_ENVELOPE, {
      onDiagnostic: (diagnostic) => received.push(diagnostic),
    });
    await client.captureMessage("frozen");
    const result = await client.flush();

    expect(received).toHaveLength(1);
    const diagnostic = received[0]!;
    // handler へ渡すものと控え・戻り値は同じ実体。利用者が触っても壊せない
    expect(diagnostic).toBe(result.diagnostics?.[0]!);
    expect(() => {
      (diagnostic as { status?: number }).status = 999;
    }).toThrow();
    expect(() => (diagnostic.issues as MonicaIngestIssue[]).pop()).toThrow();
    expect(diagnostic.status).toBe(422);
    expect(diagnostic.issues).toHaveLength(2);
    await client.close();
  });

  test("控えは 20 件で打ち切り、古い方から捨てる", async () => {
    let attempt = 0;
    const transport = createBrowserTransport({
      dsn: DSN,
      fetch: async () => {
        attempt += 1;
        return new Response(
          JSON.stringify({ error: { code: `rejected_${attempt}`, message: "bad" } }),
          { status: 422 },
        );
      },
      requestTimeoutMs: 2_000,
      maxRetries: 0,
      onSendingChange() {},
      onDiagnostic: null,
    });

    for (let i = 0; i < 23; i += 1) await transport.send(envelope);
    const diagnostics = transport.takeDiagnostics();

    // flush() を呼ばない利用者でも溜め続けない
    expect(diagnostics).toHaveLength(20);
    // 残っているのは新しい 20 件（1〜3 件目は捨てている）
    expect(diagnostics.map((diagnostic) => diagnostic.error?.code)).toEqual(
      Array.from({ length: 20 }, (_, index) => `rejected_${index + 4}`),
    );
    expect(transport.takeDiagnostics()).toEqual([]);
  });

  test("onDiagnostic で差し替えでき、null / false で止まる", async () => {
    const received: unknown[] = [];
    const replaced = createTransport({ onDiagnostic: (diagnostic) => received.push(diagnostic) });
    const first = await captureWarnings(() => replaced.transport.send(envelope));
    expect(first.warnings).toEqual([]);
    expect(received).toHaveLength(1);

    for (const off of [null, false] as const) {
      const silent = createTransport({ onDiagnostic: off });
      const { result, warnings } = await captureWarnings(() => silent.transport.send(envelope));
      expect(warnings).toEqual([]);
      // 警告を切っても結果からは読める
      expect(result.issues).toHaveLength(2);
    }
  });

  test("onDiagnostic が投げても送信結果は壊れない", async () => {
    const { transport } = createTransport({
      onDiagnostic: () => {
        throw new Error("handler exploded");
      },
    });
    const { result } = await captureWarnings(() => transport.send(envelope));
    expect(result).toMatchObject({ accepted: false, status: 422 });
  });

  test("flush() の戻り値から issues が取れ、既定では警告も出る", async () => {
    const client = createClient(422, INVALID_ENVELOPE);
    const { result, warnings } = await captureWarnings(async () => {
      await client.captureMessage("diagnostics through the client");
      return client.flush();
    });

    expect(result.accepted).toBeFalse();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics?.[0]?.status).toBe(422);
    expect(result.diagnostics?.[0]?.issues?.[0]?.path).toBe("$.items[0].request.method");
    expect(warnings[0]).toContain("$.items[0].request.method");

    // 取り出した診断は残らない。次の flush には持ち越さない
    const again = await captureWarnings(() => client.flush());
    expect(again.result.diagnostics).toBeUndefined();
    await client.close();
  });

  test("client の onDiagnostic も transport まで届く", async () => {
    const received: Array<number | undefined> = [];
    const client = createClient(422, INVALID_ENVELOPE, {
      onDiagnostic: (diagnostic) => received.push(diagnostic.status),
    });
    const { warnings } = await captureWarnings(async () => {
      await client.captureMessage("replaced handler");
      await client.flush();
    });
    expect(received).toEqual([422]);
    expect(warnings).toEqual([]);
    await client.close();
  });

  test("受理された送信は診断を残さない", async () => {
    const client = createClient(202, null);
    const { result, warnings } = await captureWarnings(async () => {
      await client.captureMessage("accepted");
      return client.flush();
    });
    expect(result.accepted).toBeTrue();
    expect(result.diagnostics).toBeUndefined();
    expect(warnings).toEqual([]);
    await client.close();
  });
});

describe("422 以外の status の挙動は変えない", () => {
  test("400 は破棄・リトライなし。既定では警告を出さないが結果には載る", async () => {
    const body = JSON.stringify({ error: { code: "bad_request", message: "malformed gzip" } });
    const { transport, responses } = createTransport({ status: 400, body, maxRetries: 2 });
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    expect(result.accepted).toBeFalse();
    expect(result.status).toBe(400);
    expect(result.error).toEqual({ code: "bad_request", message: "malformed gzip" });
    expect(responses).toHaveLength(1);
    // 既定の警告は 422 だけ。400 は payload の path が返らないので出さない
    expect(warnings).toEqual([]);
  });

  test("400 でも onDiagnostic には届く", async () => {
    const received: Array<number | undefined> = [];
    const { transport } = createTransport({
      status: 400,
      body: null,
      onDiagnostic: (diagnostic) => received.push(diagnostic.status),
    });
    await transport.send(envelope);
    expect(received).toEqual([400]);
  });

  test("401 は破棄し、以後の送信をしない。止めたことを 1 回だけ警告する", async () => {
    const body = JSON.stringify({ error: { code: "unauthorized", message: "bad key" } });
    const { transport, responses } = createTransport({ status: 401, body, maxRetries: 2 });
    const { warnings } = await captureWarnings(async () => {
      const first = await transport.send(envelope);
      expect(first.status).toBe(401);
      expect(first.error).toEqual({ code: "unauthorized", message: "bad key" });
      expect(await transport.send(envelope)).toEqual({ accepted: false, status: 401 });
    });
    // 2 回目は request を出していない
    expect(responses).toHaveLength(1);
    // 黙って止まると気付けないので既定で 1 行出す。2 回目の send では繰り返さない
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 401 (unauthorized); no further envelopes will be sent",
    ]);
  });

  test("error body の読めない 401 でも停止を伝える", async () => {
    const { transport } = createTransport({ status: 401, body: null });
    const { warnings } = await captureWarnings(() => transport.send(envelope));
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 401 (unknown); no further envelopes will be sent",
    ]);
  });

  test("同時に走った 2 本が両方 401 を受けても警告は 1 回", async () => {
    const body = JSON.stringify({ error: { code: "unauthorized", message: "bad key" } });
    const { transport, responses } = createTransport({ status: 401, body });
    const { result, warnings } = await captureWarnings(() =>
      // 2 本目の send は 1 本目の応答より先に始まるので、停止 flag では止まらない
      Promise.all([transport.send(envelope), transport.send(envelope)]),
    );

    expect(responses).toHaveLength(2);
    expect(result.map((entry) => entry.status)).toEqual([401, 401]);
    expect(warnings).toEqual([
      "monica: ingest rejected the envelope with 401 (unauthorized); no further envelopes will be sent",
    ]);
  });

  test("401 も onDiagnostic に差し替えられる", async () => {
    const received: Array<number | undefined> = [];
    const { transport } = createTransport({
      status: 401,
      body: null,
      onDiagnostic: (diagnostic) => received.push(diagnostic.status),
    });
    const { warnings } = await captureWarnings(() => transport.send(envelope));
    expect(received).toEqual([401]);
    expect(warnings).toEqual([]);
  });

  test("429 は Retry-After を待って再送し、body を読まない", async () => {
    const { transport, responses } = createTransport({
      responses: [
        { status: 429, body: INVALID_ENVELOPE, headers: { "Retry-After": "0" } },
        { status: 202 },
      ],
      maxRetries: 2,
    });
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    expect(result).toEqual({ accepted: true, status: 202 });
    expect(responses).toHaveLength(2);
    // 429 の body には触らない（読むのは 429 以外の 4xx だけ）
    expect(responses[0]!.bodyUsed).toBeFalse();
    expect(warnings).toEqual([]);
    expect(transport.takeDiagnostics()).toEqual([]);
  });

  test("5xx は backoff して諦め、body を読まない", async () => {
    const { transport, responses } = createTransport({
      status: 503,
      body: INVALID_ENVELOPE,
      maxRetries: 0,
    });
    const { result, warnings } = await captureWarnings(() => transport.send(envelope));

    expect(result).toEqual({ accepted: false, status: 503 });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.bodyUsed).toBeFalse();
    expect(warnings).toEqual([]);
    expect(transport.takeDiagnostics()).toEqual([]);
  });
});
