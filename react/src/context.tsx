import { createContext, createElement, useContext, type ReactNode } from "react";
import type { MonicaBrowserClient } from "@ah-monica/browser";

export const MonicaContext = createContext<MonicaBrowserClient | null>(null);

export interface MonicaProviderProps {
  client: MonicaBrowserClient;
  children?: ReactNode;
}

export function MonicaProvider({ client, children }: MonicaProviderProps) {
  return createElement(MonicaContext.Provider, { value: client }, children);
}

export function useMonica(): MonicaBrowserClient {
  const client = useContext(MonicaContext);
  if (!client) throw new Error("useMonica must be used inside MonicaProvider");
  return client;
}
