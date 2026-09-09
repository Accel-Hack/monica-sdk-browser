import type {
  BeforeSend,
  FetchLike,
  FlushResult,
  MonicaBreadcrumb,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
} from "@ah-monica/core";

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
  flush(timeoutMs?: number): Promise<FlushResult>;
  close(timeoutMs?: number): Promise<FlushResult>;
}
