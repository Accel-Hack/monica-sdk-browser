# @ah-monica/react

`@ah-monica/browser` の薄い React adapter。transport と queue は再実装しない。
React 18 と 19 で動く。

```sh
npm install @ah-monica/browser @ah-monica/react
```

client は `@ah-monica/browser` の `createBrowserClient()` で作り、`MonicaProvider` に渡す。

```tsx
import { MonicaErrorBoundary, MonicaProvider } from "@ah-monica/react";

<MonicaProvider client={monica}>
  <MonicaErrorBoundary fallback={<p>画面を表示できません</p>}>
    <App />
  </MonicaErrorBoundary>
</MonicaProvider>
```

既存 Error Boundary からは `captureReactException` を呼べる。component stack は
`contexts.react.componentStack` に置かれる。component の中からは `useMonica()` で
client を、`useMonicaCapture()` で既定の context を合成した capture 関数を取れる。
