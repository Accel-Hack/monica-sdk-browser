# @ah-monica/react

`@ah-monica/browser` の React adapter。Error Boundary・Provider・hooks を足すだけで、
transport と queue は browser SDK のものをそのまま使う。

## 対応環境

React `^18.0.0 || ^19.0.0`（peer 依存）。`@ah-monica/browser` が動く browser 環境。

## インストール

```sh
npm install @ah-monica/browser @ah-monica/react
```

## 初期化

client は `@ah-monica/browser` の `createBrowserClient()` で作り、`MonicaProvider` に
渡す。client の options（`dsn` や `environment` など）は
[`@ah-monica/browser`](https://github.com/Accel-Hack/monica-sdk-browser/tree/main/browser) を参照。

```tsx
import { createBrowserClient } from "@ah-monica/browser";
import { MonicaErrorBoundary, MonicaProvider } from "@ah-monica/react";

const monica = createBrowserClient({
  dsn: import.meta.env.VITE_MONICA_DSN,
  environment: "production",
});

export function Root() {
  return (
    <MonicaProvider client={monica}>
      <MonicaErrorBoundary fallback={<p>画面を表示できません</p>}>
        <App />
      </MonicaErrorBoundary>
    </MonicaProvider>
  );
}
```

## 使い方

### MonicaErrorBoundary

render 中のエラーを捕まえて送り、`fallback` を描く。

| prop | 型 | 説明 |
| --- | --- | --- |
| `children` | `ReactNode` | 保護する subtree |
| `fallback` | `ReactNode \| (error: Error) => ReactNode` | エラー後に描くもの。省略時は何も描かない |
| `client` | `MonicaBrowserClient` | 使う client。省略すると `MonicaProvider` のものを使う |
| `onError` | `(error, info) => void` | 送信とは別に呼ばれる |

`client` も Provider も無い場合は送信しない（`fallback` と `onError` は動く）。

### captureReactException

既存の Error Boundary から呼ぶ。

```tsx
componentDidCatch(error: Error, info: ErrorInfo) {
  void captureReactException(this.props.client, error, info.componentStack ?? "");
}
```

component stack は `contexts.react.componentStack`、tag は `integration: "react"` で
送る。

### useMonica / useMonicaCapture

```tsx
const monica = useMonica(); // MonicaProvider の client。外で呼ぶと例外
const capture = useMonicaCapture({ tags: { feature: "bots" } });

capture(error, { tags: { action: "open" } });
```

`useMonicaCapture()` は既定の capture context と呼び出し時の context を合成して
`captureException()` を呼ぶ。`tags` と `contexts` は浅くマージし（呼び出し側が優先）、
`breadcrumbs` は既定のあとに呼び出し側を繋ぐ。`level` は呼び出し側が優先。
それ以外の field（`user` / `request` / `fingerprint`）は呼び出し側があればそちらで
置き換える。

## 送信結果と診断

拒否された送信の扱いは `@ah-monica/browser` と同じ。`onDiagnostic` と
`flush()` の戻り値の読み方は
[TROUBLESHOOTING.md](https://github.com/Accel-Hack/monica-sdk-browser/blob/main/TROUBLESHOOTING.md)。

## ライセンス

Apache-2.0
