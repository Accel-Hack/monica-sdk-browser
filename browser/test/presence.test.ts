import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { FetchLike } from "@ah-monica/core";
import { createBrowserClient } from "../src/index.js";
import { memoryStorage } from "./storage.js";

const DSN = "https://mpk_public@ingest.example.test/1";
const KEY = "monica.presence.mpk_public";
const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

type Sent = { items: Array<Record<string, unknown>> };

function createRuntime(fetchImplementation: FetchLike, storage: Partial<Record<"localStorage" | "sessionStorage", Storage>>) {
  const runtime = new EventTarget() as EventTarget & Record<string, unknown>;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = "visible";
  runtime.location = { href: "https://app.example.test/" };
  runtime.document = document;
  runtime.fetch = fetchImplementation;
  runtime.console = { error() {} };
  Object.assign(runtime, storage);
  return runtime as unknown as Window & typeof globalThis;
}

/** 応答の header を差し替えられる ingest。受けた envelope を戻して控える */
function ingest() {
  const sent: Sent[] = [];
  let headers: Record<string, string> = {};
  const fetchImplementation: FetchLike = async (_input, init) => {
    const body = new Blob([init?.body as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    sent.push(await new Response(body).json() as Sent);
    return new Response(null, { status: 202, headers });
  };
  return {
    sent,
    fetchImplementation,
    respondWith(next: Record<string, string>) {
      headers = next;
    },
  };
}

/** ページ読み込み 1 回ぶん。client を作り、稼働確認の判定と送信が済むまで待つ */
async function pageLoad(
  fetchImplementation: FetchLike,
  storage: Partial<Record<"localStorage" | "sessionStorage", Storage>>,
  at: number,
) {
  const client = createBrowserClient({
    dsn: DSN,
    environment: "production",
    window: createRuntime(fetchImplementation, storage),
    now: () => new Date(at),
    maxRetries: 0,
  });
  await client.flush();
  return client;
}

const saved = (storage: Storage) => JSON.parse(storage.getItem(KEY) ?? "null");

afterEach(() => {
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("稼働確認（client_report）", () => {
  test("ページ読み込みで start を単独の envelope で送り、202 の時刻を localStorage に残す", async () => {
    const { sent, fetchImplementation } = ingest();
    const localStorage = memoryStorage();
    await pageLoad(fetchImplementation, { localStorage }, T0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.items).toHaveLength(1);
    expect(sent[0]!.items[0]).toMatchObject({ type: "client_report", trigger: "start", platform: "javascript" });
    expect(saved(localStorage)).toEqual({ intervalStartedAt: T0 });
  });

  test("storage に interval 内の時刻があれば再読み込みしても送らず、過ぎたら 1 通送る", async () => {
    const { sent, fetchImplementation } = ingest();
    const localStorage = memoryStorage({ [KEY]: JSON.stringify({ intervalStartedAt: T0 }) });

    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY - 1);
    expect(sent).toHaveLength(0);

    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY);
    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY + 1);
    expect(sent).toHaveLength(1);
  });

  test("error の envelope が 202 を受けると期限が伸びる", async () => {
    const { sent, fetchImplementation } = ingest();
    const localStorage = memoryStorage({ [KEY]: JSON.stringify({ intervalStartedAt: T0 }) });
    const client = await pageLoad(fetchImplementation, { localStorage }, T0 + 1_000);
    await client.captureMessage("boom");
    await client.flush();
    expect(sent.map((envelope) => envelope.items[0]!.type)).toEqual(["error"]);

    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY);
    expect(sent).toHaveLength(1);
  });

  test("202 の header が保存されて次の判定に効き、壊れた header と header 無しの応答では保存値が残る", async () => {
    const { sent, fetchImplementation, respondWith } = ingest();
    const localStorage = memoryStorage();
    respondWith({ "X-Monica-Presence-Interval-Ms": "120000", "X-Monica-Presence-Sample-Rate": "0.5" });
    await pageLoad(fetchImplementation, { localStorage }, T0);
    expect(saved(localStorage)).toEqual({ intervalStartedAt: T0, intervalMs: 120_000, sampleRate: 0.5 });

    // 既定の 1 日ではなく保存した 120000ms で due になる。壊れた値はその header だけ無視する
    respondWith({ "X-Monica-Presence-Interval-Ms": "1e5", "X-Monica-Presence-Sample-Rate": "2" });
    spyOn(Math, "random").mockReturnValue(0);
    await pageLoad(fetchImplementation, { localStorage }, T0 + 119_999);
    expect(sent).toHaveLength(1);
    await pageLoad(fetchImplementation, { localStorage }, T0 + 120_000);
    expect(sent).toHaveLength(2);
    expect(saved(localStorage)).toEqual({ intervalStartedAt: T0 + 120_000, intervalMs: 120_000, sampleRate: 0.5 });

    respondWith({});
    await pageLoad(fetchImplementation, { localStorage }, T0 + 240_000);
    expect(sent).toHaveLength(3);
    expect(saved(localStorage)).toEqual({ intervalStartedAt: T0 + 240_000, intervalMs: 120_000, sampleRate: 0.5 });
  });

  test("sample rate が 1 未満なら乱数で間引き、見送った端末も interval が過ぎるまで抽選し直さない", async () => {
    const { sent, fetchImplementation } = ingest();
    const localStorage = memoryStorage({ [KEY]: JSON.stringify({ sampleRate: 0.5 }) });
    const random = spyOn(Math, "random").mockReturnValue(0.5);

    await pageLoad(fetchImplementation, { localStorage }, T0);
    expect(sent).toHaveLength(0);
    random.mockReturnValue(0.49);
    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY - 1);
    expect(sent).toHaveLength(0);
    await pageLoad(fetchImplementation, { localStorage }, T0 + DAY);
    expect(sent).toHaveLength(1);
  });

  test("localStorage が throw する環境では sessionStorage に持つ", async () => {
    const { sent, fetchImplementation } = ingest();
    const sessionStorage = memoryStorage();
    const localStorage = {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;

    await pageLoad(fetchImplementation, { localStorage, sessionStorage }, T0);
    expect(saved(sessionStorage)).toEqual({ intervalStartedAt: T0 });
    await pageLoad(fetchImplementation, { localStorage, sessionStorage }, T0 + 1);
    expect(sent).toHaveLength(1);
  });

  test("稼働確認の送信中に起きた error も落とさない", async () => {
    const { sent, fetchImplementation } = ingest();
    const client = createBrowserClient({
      dsn: DSN,
      environment: "production",
      window: createRuntime(fetchImplementation, {}),
      maxRetries: 0,
    });
    // client_report の送信は作った直後に始まっている
    expect(await client.captureMessage("during page load")).toBeString();
    await client.flush();
    expect(sent.map((envelope) => envelope.items.map((item) => item.type))).toEqual([["client_report"], ["error"]]);
  });

  test("storage のキーは DSN の API key ごとで、別 project の client と状態を共有しない", async () => {
    const { sent, fetchImplementation } = ingest();
    const localStorage = memoryStorage({ [KEY]: JSON.stringify({ intervalStartedAt: T0 }) });
    const client = createBrowserClient({
      dsn: "https://mpk_other@ingest.example.test/2",
      environment: "production",
      window: createRuntime(fetchImplementation, { localStorage }),
      now: () => new Date(T0 + 1),
      maxRetries: 0,
    });
    await client.flush();
    expect(sent).toHaveLength(1);
    expect(saved(localStorage)).toEqual({ intervalStartedAt: T0 });
    expect(JSON.parse(localStorage.getItem("monica.presence.mpk_other")!)).toEqual({ intervalStartedAt: T0 + 1 });
  });

  test("error の envelope の送信中に起きた error は送らない", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    const client = createBrowserClient({
      dsn: DSN,
      environment: "production",
      window: createRuntime(async () => {
        fetched();
        await held;
        return new Response(null, { status: 202 });
      }, { localStorage: memoryStorage({ [KEY]: JSON.stringify({ intervalStartedAt: T0 }) }) }),
      now: () => new Date(T0 + 1),
      maxRetries: 0,
    });
    await client.captureMessage("first");
    const flushing = client.flush();
    await started;
    expect(await client.captureMessage("during error send")).toBeNull();
    release();
    await flushing;
  });
});
