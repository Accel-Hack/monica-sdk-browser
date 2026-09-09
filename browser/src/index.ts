import { createBrowserClient } from "./client.js";
import type {
  BrowserCaptureContext,
  BrowserClientOptions,
  BrowserScope,
  MonicaBrowserClient,
} from "./types.js";

let currentClient: MonicaBrowserClient | undefined;

export function init(options: BrowserClientOptions): MonicaBrowserClient {
  if (currentClient) void currentClient.close();
  currentClient = createBrowserClient(options);
  return currentClient;
}

export function captureException(
  error: unknown,
  context?: BrowserCaptureContext,
): Promise<string | null> {
  return client().captureException(error, context);
}

export function captureMessage(
  message: string,
  level?: BrowserCaptureContext["level"],
  context?: Omit<BrowserCaptureContext, "level">,
): Promise<string | null> {
  return client().captureMessage(message, level, context);
}

export function setUser(user: Parameters<MonicaBrowserClient["setUser"]>[0]): void {
  client().setUser(user);
}

export function addBreadcrumb(
  breadcrumb: Parameters<MonicaBrowserClient["addBreadcrumb"]>[0],
): void {
  client().addBreadcrumb(breadcrumb);
}

export function withScope<T>(callback: (scope: BrowserScope) => T): T {
  return client().withScope(callback);
}

export function flush(timeoutMs?: number) {
  return client().flush(timeoutMs);
}

export async function close(timeoutMs?: number) {
  const active = client();
  currentClient = undefined;
  return active.close(timeoutMs);
}

function client(): MonicaBrowserClient {
  if (!currentClient) throw new Error("Monica.init() must be called first");
  return currentClient;
}

export { createBrowserClient };
export type {
  BrowserCaptureContext,
  BrowserClientOptions,
  BrowserScope,
  MonicaBrowserClient,
} from "./types.js";
export type {
  BeforeSend,
  FlushResult,
  MonicaBreadcrumb,
  MonicaErrorItem,
  MonicaItem,
  MonicaLevel,
  MonicaRequest,
  MonicaUser,
} from "@ah-monica/core";
