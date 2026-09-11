import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
  TransportDiagnostic,
  TransportDiagnosticHandler,
} from "@ah-monica/core";

/**
 * core の `FlushResult` に、その flush で拒否された envelope の診断を足したもの。
 *
 * core も `status` / `issues` / `error` を持つが、載るのは直前の 1 件だけ。413 の
 * 分割再送や 1 MB 超の分割では 1 回の flush で複数の envelope を送るので、最後
 * 以外の指摘が落ちる。片方の item を直しても、もう片方が落ち続ける形になるため、
 * browser は全件を `diagnostics` で持つ。こちらが browser の正。
 */
export interface BrowserFlushResult extends FlushResult {
  diagnostics?: TransportDiagnostic[];
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
  onDiagnostic?: TransportDiagnosticHandler | null | false;
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
