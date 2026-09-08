import type {
  FetchLike,
  MonicaEnvelope,
  MonicaTransport,
  TransportResult,
} from "@ah-monica/core";

interface BrowserTransportOptions {
  dsn: string;
  fetch: FetchLike;
  requestTimeoutMs: number;
  maxRetries: number;
  onSendingChange(sending: boolean): void;
}

export function createBrowserTransport(options: BrowserTransportOptions): MonicaTransport {
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

  return {
    async send(envelope, outerSignal): Promise<TransportResult> {
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
              return { accepted: false, status: response.status };
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
