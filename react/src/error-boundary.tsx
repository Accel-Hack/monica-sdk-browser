import { Component, type ErrorInfo, type ReactNode } from "react";
import type { MonicaBrowserClient } from "@ah-monica/browser";
import { MonicaContext } from "./context.js";

export interface MonicaErrorBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
  client?: MonicaBrowserClient;
  onError?: (error: Error, info: ErrorInfo) => void;
}

type State = { error: Error | null };

export class MonicaErrorBoundary extends Component<MonicaErrorBoundaryProps, State> {
  static contextType = MonicaContext;
  declare context: MonicaBrowserClient | null;
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const client = this.props.client ?? this.context;
    if (client) void captureReactException(client, error, info.componentStack ?? "");
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return typeof this.props.fallback === "function"
      ? this.props.fallback(this.state.error)
      : this.props.fallback ?? null;
  }
}

export function captureReactException(
  client: MonicaBrowserClient,
  error: unknown,
  componentStack: string,
): Promise<string | null> {
  return client.captureException(error, {
    contexts: { react: { componentStack } },
    tags: { integration: "react" },
  });
}
