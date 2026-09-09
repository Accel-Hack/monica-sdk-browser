import {
  createCoreClient,
  type MonicaBreadcrumb,
  type MonicaErrorItem,
  type MonicaExceptionValue,
  type MonicaFrame,
  type MonicaUser,
} from "@ah-monica/core";
import { createBrowserTransport } from "./transport.js";
import type {
  BrowserCaptureContext,
  BrowserClientOptions,
  BrowserScope,
  MonicaBrowserClient,
} from "./types.js";

interface ScopeState {
  user?: MonicaUser;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  breadcrumbs: MonicaBreadcrumb[];
}

interface XhrMetadata {
  method: string;
  url: string;
  startedAt: number;
}

export function createBrowserClient(options: BrowserClientOptions): MonicaBrowserClient {
  const candidate = options.window ?? (typeof window === "undefined" ? undefined : window);
  if (!candidate) throw new Error("A browser window is required");
  const runtime: Window & typeof globalThis = candidate;
  const fetchImplementation = options.fetch
    ?? (typeof runtime.fetch === "function" ? runtime.fetch.bind(runtime) : undefined);
  if (!fetchImplementation) throw new Error("A fetch implementation is required");
  const maxBreadcrumbs = positiveInteger(options.maxBreadcrumbs) ? options.maxBreadcrumbs : 50;
  const dedupeWindowMs = options.dedupeWindowMs ?? 1_000;
  if (!Number.isFinite(dedupeWindowMs) || dedupeWindowMs < 0) {
    throw new RangeError("dedupeWindowMs must be a non-negative number");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const maxRetries = options.maxRetries ?? 2;
  const route = normalizeRoute(options.route);
  const now = options.now ?? (() => new Date());
  const recent = new Map<string, number>();
  let sending = false;
  let scope = emptyScope();
  let closed = false;
  const uninstallers: Array<() => void> = [];

  const core = createCoreClient({
    transport: createBrowserTransport({
      dsn: options.dsn,
      fetch: fetchImplementation,
      requestTimeoutMs,
      maxRetries,
      onSendingChange(value) {
        sending = value;
      },
    }),
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    maxQueueSize: options.maxQueueSize,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushIntervalMs,
    now,
    sdk: { name: "@ah-monica/browser", version: "0.1.1" },
    async beforeSend(item, hint) {
      const processed = options.beforeSend ? await options.beforeSend(item, hint) : item;
      if (processed === null) return null;
      if (dedupeWindowMs === 0) return processed;
      const time = now().getTime();
      const key = dedupeKey(processed);
      const previous = recent.get(key);
      if (previous !== undefined && time - previous < dedupeWindowMs) return null;
      recent.set(key, time);
      for (const [recentKey, seenAt] of recent) {
        if (time - seenAt >= dedupeWindowMs) recent.delete(recentKey);
      }
      return processed;
    },
  });

  function setUser(user: MonicaUser | null): void {
    if (user === null) delete scope.user;
    else scope.user = { ...user };
  }

  function addBreadcrumb(breadcrumb: MonicaBreadcrumb): void {
    scope.breadcrumbs.push({
      ...breadcrumb,
      timestamp: breadcrumb.timestamp ?? now().toISOString(),
    });
    trimBreadcrumbs(scope.breadcrumbs, maxBreadcrumbs);
  }

  function withScope<T>(callback: (controller: BrowserScope) => T): T {
    const parent = scope;
    scope = cloneScope(parent);
    const controller = scopeController(scope, addBreadcrumb);
    try {
      return callback(controller);
    } finally {
      scope = parent;
    }
  }

  function captureException(
    error: unknown,
    context: BrowserCaptureContext = {},
  ): Promise<string | null> {
    return captureExceptionWithMechanism(error, context, {
      type: "generic",
      handled: true,
    });
  }

  function captureExceptionWithMechanism(
    error: unknown,
    context: BrowserCaptureContext,
    mechanism: MonicaExceptionValue["mechanism"],
    location?: { filename?: string; lineno?: number; colno?: number },
  ): Promise<string | null> {
    if (closed || sending) return Promise.resolve(null);
    const exception = normalizeException(error, mechanism, location);
    return core.capture(
      {
        type: "error",
        platform: "javascript",
        level: context.level ?? "error",
        message: exception.values[0]?.value,
        exception,
        ...contextValues(context),
      },
      { originalException: error },
    );
  }

  function captureMessage(
    message: string,
    level: BrowserCaptureContext["level"] = "info",
    context: Omit<BrowserCaptureContext, "level"> = {},
  ): Promise<string | null> {
    if (closed || sending) return Promise.resolve(null);
    return core.capture({
      type: "error",
      platform: "javascript",
      level,
      message,
      ...contextValues(context),
    });
  }

  function contextValues(context: BrowserCaptureContext) {
    const user = context.user ?? scope.user;
    const tags = {
      ...(options.screenId ? { "screen.id": options.screenId } : {}),
      ...scope.tags,
      ...context.tags,
    };
    const contexts = { ...scope.contexts, ...context.contexts };
    const breadcrumbs = [...scope.breadcrumbs, ...(context.breadcrumbs ?? [])].slice(
      -maxBreadcrumbs,
    );
    const request = context.request ?? {
      // Live paths, query strings and fragments may contain tokens or user
      // identifiers. Only an explicitly configured route template may add a path.
      url: pageUrl(runtime.location.href, route),
      method: "GET",
    };

    return {
      ...(user ? { user: { ...user } } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      ...(Object.keys(contexts).length ? { contexts } : {}),
      ...(breadcrumbs.length ? { breadcrumbs } : {}),
      request,
      // The contract requires a non-empty array; an empty one would be rejected.
      ...(context.fingerprint?.length ? { fingerprint: context.fingerprint } : {}),
    };
  }

  function installGlobalHandlers(): void {
    const onError = (event: Event) => {
      if (sending) return;
      const errorEvent = event as ErrorEvent;
      const error = errorEvent.error ?? new Error(errorEvent.message || "Script error");
      void captureExceptionWithMechanism(
        error,
        { level: "error" },
        { type: "onerror", handled: false },
        {
          filename: errorEvent.filename,
          lineno: errorEvent.lineno,
          colno: errorEvent.colno,
        },
      );
    };
    const onUnhandledRejection = (event: Event) => {
      if (sending) return;
      const reason = (event as PromiseRejectionEvent).reason;
      void captureExceptionWithMechanism(
        reason,
        { level: "error" },
        { type: "onunhandledrejection", handled: false },
      );
    };
    const onVisibilityChange = () => {
      if (runtime.document.visibilityState === "hidden") void core.flush(requestTimeoutMs);
    };
    runtime.addEventListener("error", onError);
    runtime.addEventListener("unhandledrejection", onUnhandledRejection);
    runtime.document.addEventListener("visibilitychange", onVisibilityChange);
    uninstallers.push(() => {
      runtime.removeEventListener("error", onError);
      runtime.removeEventListener("unhandledrejection", onUnhandledRejection);
      runtime.document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  }

  function installXhrBreadcrumbs(): void {
    const constructor = runtime.XMLHttpRequest;
    if (!constructor?.prototype) return;
    const prototype = constructor.prototype as XMLHttpRequest;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const metadata = new WeakMap<XMLHttpRequest, XhrMetadata>();
    const mutable = prototype as unknown as {
      open: (...args: unknown[]) => void;
      send: (...args: unknown[]) => void;
    };

    mutable.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
      const method = typeof args[0] === "string" ? args[0].toUpperCase() : "GET";
      const url = originOnlyUrl(String(args[1] ?? ""), runtime.location.href);
      metadata.set(this, { method, url, startedAt: now().getTime() });
      (originalOpen as unknown as (...parameters: unknown[]) => void).apply(this, args);
    };
    mutable.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
      const onLoadEnd = () => {
        const details = metadata.get(this);
        if (!details || (this.status > 0 && this.status < 400)) return;
        addBreadcrumb({
          type: "http",
          category: "xhr",
          level: "warning",
          message: `${details.method} ${details.url}`,
          data: {
            method: details.method,
            url: details.url,
            status: this.status,
            duration_ms: Math.max(0, now().getTime() - details.startedAt),
          },
        });
      };
      this.addEventListener("loadend", onLoadEnd, { once: true });
      (originalSend as unknown as (...parameters: unknown[]) => void).apply(this, args);
    };
    uninstallers.push(() => {
      prototype.open = originalOpen;
      prototype.send = originalSend;
    });
  }

  function installConsoleCapture(): void {
    const original = runtime.console.error;
    runtime.console.error = (...values: unknown[]) => {
      original.apply(runtime.console, values);
      if (!sending) void captureMessage(values.map(safeString).join(" "), "error");
    };
    uninstallers.push(() => {
      runtime.console.error = original;
    });
  }

  async function close(timeoutMs?: number) {
    closed = true;
    while (uninstallers.length > 0) uninstallers.pop()?.();
    return core.close(timeoutMs);
  }

  if (options.autoCapture ?? true) {
    installGlobalHandlers();
    installXhrBreadcrumbs();
    if (options.captureConsoleErrors ?? false) installConsoleCapture();
  }

  return {
    captureException,
    captureMessage,
    setUser,
    addBreadcrumb,
    withScope,
    flush: core.flush,
    close,
  };
}

function normalizeException(
  error: unknown,
  mechanism: MonicaExceptionValue["mechanism"],
  location?: { filename?: string; lineno?: number; colno?: number },
): { values: MonicaExceptionValue[] } {
  const values: MonicaExceptionValue[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && values.length < 10 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      let frames = parseStack(current.stack);
      if (frames.length === 0 && location?.filename) {
        const filename = sanitizeStackFilename(location.filename);
        frames = [{
          filename,
          ...(location.lineno ? { lineno: location.lineno } : {}),
          ...(location.colno ? { colno: location.colno } : {}),
          in_app: isInApp(filename),
        }];
      }
      values.push({
        type: current.name || "Error",
        value: current.message,
        ...(frames.length ? { stacktrace: { frames } } : {}),
        mechanism,
      });
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      values.push({
        type: typeof current,
        value: safeString(current),
        mechanism,
      });
      current = undefined;
    }
  }
  if (values.length === 0) {
    values.push({ type: "Error", value: "Unknown error", mechanism });
  }
  return { values };
}

function parseStack(stack: string | undefined): MonicaFrame[] {
  if (!stack) return [];
  const frames: MonicaFrame[] = [];
  for (const line of stack.split("\n").slice(1, 201)) {
    const chrome = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const firefox = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
    const match = chrome ?? firefox;
    if (!match) continue;
    const filename = sanitizeStackFilename(match[2] ?? "[unknown]");
    frames.push({
      filename,
      ...(match[1] ? { function: match[1] } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: isInApp(filename),
    });
  }
  return frames.reverse();
}

function isInApp(filename: string): boolean {
  return !/[\\/]node_modules[\\/]/.test(filename)
    && !/^chrome-extension:|^moz-extension:|^safari-extension:/.test(filename);
}

function dedupeKey(item: MonicaErrorItem): string {
  if (item.fingerprint?.length) return `fingerprint:${item.fingerprint.join("|")}`;
  const value = item.exception?.values[0];
  const frame = value?.stacktrace?.frames.at(-1);
  return JSON.stringify([
    value?.type ?? "",
    value?.value ?? item.message ?? "",
    frame?.filename ?? "",
    frame?.lineno ?? 0,
    frame?.colno ?? 0,
  ]);
}

function originOnlyUrl(value: string, base: string): string {
  try {
    const url = new URL(value, base);
    return url.origin;
  } catch {
    return "[invalid-url]";
  }
}

function pageUrl(value: string, route: string | undefined): string {
  const origin = originOnlyUrl(value, value);
  return route ? `${origin}${route}` : origin;
}

function normalizeRoute(route: string | undefined): string | undefined {
  if (route === undefined) return undefined;
  const normalized = route.trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//") || /[?#]/.test(normalized)) {
    throw new TypeError("route must be a path template starting with / without query or fragment");
  }
  return normalized;
}

function sanitizeStackFilename(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "[unknown]";
  }
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function emptyScope(): ScopeState {
  return { tags: {}, contexts: {}, breadcrumbs: [] };
}

function cloneScope(value: ScopeState): ScopeState {
  return {
    ...(value.user ? { user: { ...value.user } } : {}),
    tags: { ...value.tags },
    contexts: { ...value.contexts },
    breadcrumbs: value.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
  };
}

function scopeController(
  state: ScopeState,
  addBreadcrumb: (breadcrumb: MonicaBreadcrumb) => void,
): BrowserScope {
  return {
    setUser(user) {
      if (user === null) delete state.user;
      else state.user = { ...user };
    },
    setTag(key, value) {
      state.tags[key] = value;
    },
    setContext(key, value) {
      state.contexts[key] = value;
    },
    addBreadcrumb,
  };
}

function trimBreadcrumbs(breadcrumbs: MonicaBreadcrumb[], max: number): void {
  if (breadcrumbs.length > max) breadcrumbs.splice(0, breadcrumbs.length - max);
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
