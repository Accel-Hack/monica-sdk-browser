import type {
  FetchLike,
  MonicaEnvelope,
  MonicaTransport,
} from "@ah-monica/core";
import type {
  BrowserDiagnosticHandler,
  BrowserTransportResult,
  MonicaIngestIssue,
} from "./types.js";

interface BrowserTransportOptions {
  dsn: string;
  fetch: FetchLike;
  requestTimeoutMs: number;
  maxRetries: number;
  onSendingChange(sending: boolean): void;
  onDiagnostic?: BrowserDiagnosticHandler | null | false;
}

export interface BrowserTransport extends MonicaTransport {
  send(envelope: MonicaEnvelope, signal?: AbortSignal): Promise<BrowserTransportResult>;
  /**
   * 前回の呼び出し以降に記録した拒否の診断を返し、内部の控えを空にする。
   * core の client は `transport.send` の戻り値を呼び出し側へ返さないので、
   * `flush()` から issues を見せるにはここを経由するしかない。
   */
  takeDiagnostics(): BrowserTransportResult[];
}

/** error body の読み込み上限。ingest の error body は小さく、これを超える body は診断に使わない */
const MAX_ERROR_BODY_BYTES = 64 * 1_024;
/** flush されないまま診断が溜まり続けないようにする */
const MAX_PENDING_DIAGNOSTICS = 20;

export function createBrowserTransport(options: BrowserTransportOptions): BrowserTransport {
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer");
  }
  const { endpoint, key } = parseDsn(options.dsn);
  // 401 は鍵の不正・失効。契約上は「破棄し、以後の送信を止める」なので、
  // 一度受けたら同じ鍵で送り続けない
  let unauthorized = false;
  const pending: BrowserTransportResult[] = [];

  /**
   * 拒否を控えに残し、警告経路へ渡す。控えは通知の有無と無関係に残す
   * （警告を切っていても `flush()` からは issues を読めるようにする）。
   * 1 envelope につき 1 回。4xx はリトライしないので retry ごとには出ない。
   */
  function report(diagnostic: BrowserTransportResult): void {
    pending.push(diagnostic);
    if (pending.length > MAX_PENDING_DIAGNOSTICS) pending.shift();
    const handler = options.onDiagnostic;
    if (handler === null || handler === false) return;
    try {
      if (handler) handler(diagnostic);
      // 既定は 422 だけ。422 は payload を直せる情報なので既定オフにしない
      else if (diagnostic.status === 422) warnRejection(diagnostic);
    } catch {
      // 利用者の handler が投げても送信経路は壊さない
    }
  }

  return {
    takeDiagnostics(): BrowserTransportResult[] {
      return pending.splice(0, pending.length);
    },

    async send(envelope, outerSignal): Promise<BrowserTransportResult> {
      if (outerSignal?.aborted) return { accepted: false };
      if (unauthorized) return { accepted: false, status: 401 };
      options.onSendingChange(true);
      try {
        const body = await gzipEnvelope(envelope);
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          const controller = new AbortController();
          const abort = () => controller.abort(outerSignal?.reason);
          outerSignal?.addEventListener("abort", abort, { once: true });
          // Close the race between send()'s initial check and listener install.
          if (outerSignal?.aborted) abort();
          const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
          try {
            const response = await options.fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Encoding": "gzip",
                "X-Monica-Key": key,
              },
              body,
              keepalive: true,
              signal: controller.signal,
            });
            if (response.ok) return { accepted: true, status: response.status };
            if (response.status === 401) unauthorized = true;
            if (response.status !== 429 && response.status < 500) {
              // 4xx は従来どおり破棄する。変わるのは「body を読み、警告し、
              // 結果に載せる」ところだけ。ingest は 422 の issues に
              // 直すべき path を入れて返しているので、それを捨てない
              const rejection = await describeRejection(response);
              report(rejection);
              return rejection;
            }
            if (attempt === options.maxRetries) {
              return { accepted: false, status: response.status };
            }
            const retryAfter = response.status === 429
              ? retryAfterMilliseconds(response.headers.get("Retry-After"))
              : undefined;
            await delay(retryAfter ?? backoff(attempt), outerSignal);
          } catch {
            if (outerSignal?.aborted || attempt === options.maxRetries) {
              return { accepted: false };
            }
            await delay(backoff(attempt), outerSignal).catch(() => undefined);
          } finally {
            clearTimeout(timeout);
            outerSignal?.removeEventListener("abort", abort);
          }
        }
        return { accepted: false };
      } catch {
        return { accepted: false };
      } finally {
        options.onSendingChange(false);
      }
    },
  };
}

function parseDsn(dsn: string): { endpoint: string; key: string } {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new TypeError("dsn must be a valid URL");
  }
  const key = decodeURIComponent(url.username);
  if (!key) throw new TypeError("dsn must include an API key as the username");
  if (!key.startsWith("mpk_")) {
    throw new TypeError("browser dsn must contain a public mpk_ key; never expose an msk_ key");
  }
  const localHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("dsn must use https except for localhost");
  }
  url.username = "";
  url.password = "";
  url.pathname = "/v1/envelope";
  url.search = "";
  url.hash = "";

  return { endpoint: url.toString(), key };
}

async function gzipEnvelope(envelope: MonicaEnvelope): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(envelope)]).stream();
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/**
 * 拒否レスポンスを結果へ写す。body は spec/v1/error.json の形として読むが、
 * 読めない・空・JSON でない・形が違う・大きすぎるときは issues 無しの
 * 従来どおりの結果を返す。ここから例外は出さない。
 */
async function describeRejection(response: Response): Promise<BrowserTransportResult> {
  const result: BrowserTransportResult = { accepted: false, status: response.status };
  try {
    const text = await readLimitedText(response);
    if (text === undefined || text === "") return result;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return result;
    const error = parsed.error;
    if (!isRecord(error)) return result;
    if (typeof error.code === "string" && typeof error.message === "string") {
      result.error = { code: error.code, message: error.message };
    }
    const issues = Array.isArray(error.issues) ? collectIssues(error.issues) : [];
    if (issues.length > 0) result.issues = issues;
  } catch {
    // body が途中で切れても、JSON でなくても、破棄という結論は変わらない
  }
  return result;
}

/** path / message が string でない要素は捨てる */
function collectIssues(values: unknown[]): MonicaIngestIssue[] {
  const issues: MonicaIngestIssue[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const { path, message } = value;
    if (typeof path !== "string" || typeof message !== "string") continue;
    issues.push({ path, message });
  }
  return issues;
}

/** 上限を超えたら読むのをやめて undefined。診断のために巨大な body を溜めない */
async function readLimitedText(response: Response): Promise<string | undefined> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return byteLength(text) > MAX_ERROR_BODY_BYTES ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_ERROR_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 既定の警告。browser では開発者がコンソールを見ているので、これが一番届く。
 * API key と envelope 本体は出さない（出すのは status / code / message / path）。
 */
function warnRejection(diagnostic: BrowserTransportResult): void {
  if (typeof console === "undefined" || typeof console.warn !== "function") return;
  const issues = diagnostic.issues ?? [];
  const code = diagnostic.error?.code ?? "unknown";
  const head =
    `monica: ingest rejected the envelope with ${diagnostic.status} (${code}): ${issues.length} issue(s)`;
  console.warn(head + issues.map((issue) => `\n - ${issue.path}: ${issue.message}`).join(""));
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Math.min(Number(value) * 1_000, 60_000);
}

function backoff(attempt: number): number {
  // 契約: min(1000 * 2^attempt, 30000) ms に 50〜100% の jitter
  return Math.floor(Math.min(1_000 * 2 ** attempt, 30_000) * (0.5 + Math.random() * 0.5));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the first aborted check and listener install.
    if (signal?.aborted) onAbort();
  });
}
