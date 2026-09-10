import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
  TransportResult,
} from "@ah-monica/core";

/** 422 の body に載る field 単位の指摘。`path` は `$.items[0].request.method` の形 */
export interface MonicaIngestIssue {
  path: string;
  message: string;
}

/**
 * core の `TransportResult`（`accepted` / `status`）に、ingest が返した
 * error body の内容を足したもの。`error` / `issues` は 429 以外の 4xx で
 * body が spec/v1/error.json に適合したときだけ入る。
 */
export interface BrowserTransportResult extends TransportResult {
  error?: { code: string; message: string };
  issues?: MonicaIngestIssue[];
}

/**
 * 送信が拒否されたときに呼ばれる。既定は 422 を `console.warn` へ出す挙動で、
 * この handler を渡すと差し替えになる（429 以外の 4xx すべてが届く）。
 * `null` / `false` で無効化。
 */
export type BrowserDiagnosticHandler = (diagnostic: BrowserTransportResult) => void;

/** core の `FlushResult` に、その flush までに拒否された envelope の診断を足したもの */
export interface BrowserFlushResult extends FlushResult {
  diagnostics?: BrowserTransportResult[];
}

export interface BrowserClientOptions {
  dsn: string;
  environment: string;
  release?: string;
  screenId?: string;
  /** Safe route template such as /form/follow/{token}. The live pathname is never inferred. */
  route?: string;
  sampleRate?: number;
  maxBreadcrumbs?: number;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  dedupeWindowMs?: number;
  autoCapture?: boolean;
  captureConsoleErrors?: boolean;
  beforeSend?: BeforeSend;
  /**
   * 拒否された送信の診断の受け取り先。既定（省略時）は 422 を `console.warn`
   * へ出す。`null` / `false` で無効化する。
   */
  onDiagnostic?: BrowserDiagnosticHandler | null | false;
  fetch?: FetchLike;
  window?: Window & typeof globalThis;
  now?: () => Date;
}

export interface BrowserCaptureContext {
  level?: MonicaLevel;
  user?: MonicaUser;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: MonicaBreadcrumb[];
  request?: MonicaRequest;
  fingerprint?: string[];
}

export interface BrowserScope {
  setUser(user: MonicaUser | null): void;
  setTag(key: string, value: string): void;
  setContext(key: string, value: unknown): void;
  addBreadcrumb(breadcrumb: MonicaBreadcrumb): void;
}

export interface MonicaBrowserClient {
  captureException(error: unknown, context?: BrowserCaptureContext): Promise<string | null>;
  captureMessage(
    message: string,
    level?: MonicaLevel,
    context?: Omit<BrowserCaptureContext, "level">,
  ): Promise<string | null>;
  setUser(user: MonicaUser | null): void;
  addBreadcrumb(breadcrumb: MonicaBreadcrumb): void;
  withScope<T>(callback: (scope: BrowserScope) => T): T;
  flush(timeoutMs?: number): Promise<BrowserFlushResult>;
  close(timeoutMs?: number): Promise<BrowserFlushResult>;
}
