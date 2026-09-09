import { useCallback } from "react";
import type { BrowserCaptureContext } from "@ah-monica/browser";
import { useMonica } from "./context.js";

const EMPTY_CONTEXT: BrowserCaptureContext = {};

export function useMonicaCapture(defaultContext: BrowserCaptureContext = EMPTY_CONTEXT) {
  const client = useMonica();
  return useCallback(
    (error: unknown, context: BrowserCaptureContext = {}) =>
      client.captureException(error, {
        ...defaultContext,
        ...context,
        level: context.level ?? defaultContext.level,
        tags: { ...defaultContext.tags, ...context.tags },
        contexts: { ...defaultContext.contexts, ...context.contexts },
        breadcrumbs: [...(defaultContext.breadcrumbs ?? []), ...(context.breadcrumbs ?? [])],
      }),
    [client, defaultContext],
  );
}
