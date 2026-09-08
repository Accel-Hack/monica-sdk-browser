# @ah-monica/react

`@ah-monica/browser` の薄い React adapter。transport と queue は再実装しない。

```tsx
import { MonicaErrorBoundary, MonicaProvider } from "@ah-monica/react";

<MonicaProvider client={monica}>
  <MonicaErrorBoundary fallback={<p>画面を表示できません</p>}>
    <App />
  </MonicaErrorBoundary>
</MonicaProvider>
```

既存 Error Boundary からは `captureReactException` を呼べる。component stack は
`contexts.react.componentStack` に置かれる。
