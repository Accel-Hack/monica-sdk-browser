# monica-sdk-browser

browser 上で起きた JavaScript のエラーを MONICA の Ingest API（`POST /v1/envelope`）へ
送る SDK。npm に `@ah-monica/*` として公開している。

## パッケージ

| ディレクトリ | package | 用途・要求環境 |
| --- | --- | --- |
| [`browser/`](browser/) | `@ah-monica/browser` | 素の JavaScript を含む browser アプリ。ESM と `<script>` で読める IIFE を同じ package で配布する。`fetch` / `CompressionStream` / `AbortController` / `crypto.randomUUID` のある browser で動く。型は TypeScript 4.8 以降 |
| [`react/`](react/) | `@ah-monica/react` | React 18 / 19 向けの Error Boundary・Provider・hooks。`@ah-monica/browser` の上に載る |

`@ah-monica/browser` は `@ah-monica/core`（`^0.2.1`）を npm 依存として使う。
`@ah-monica/react` は `@ah-monica/browser` に依存し、`react` は peer 依存
（`^18.0.0 || ^19.0.0`）。

## インストール

```sh
npm install @ah-monica/browser
```

React 統合も使う場合。

```sh
npm install @ah-monica/browser @ah-monica/react
```

bundler を使わない場合は IIFE 版を `<script>` で読む。package 内の
`dist/monica.min.js` を配信するか、CDN から version を固定して読む。

```html
<script src="https://cdn.jsdelivr.net/npm/@ah-monica/browser@0.2.0/dist/monica.min.js"></script>
```

読み込むとグローバルに `Monica` が生える。

## 初期化

```js
import * as Monica from "@ah-monica/browser";

Monica.init({
  dsn: window.MONICA_DSN,
  environment: "production",
  release: window.APP_RELEASE,
});
```

DSN は `https://<key>@<host>/...` の形で、key には browser へ公開してよい public key
（`mpk_` 始まり）だけを入れる。secret key（`msk_` 始まり）や key の無い DSN、
`https` 以外の DSN（`localhost` と `127.0.0.1` の `http` だけ例外）は `init()` が
`TypeError` を投げる。

`<script>` で読んだ場合も同じ。

```html
<script>
  Monica.init({
    dsn: window.MONICA_DSN,
    environment: "production",
    screenId: "checkout",
  });
</script>
```

## 使い方

`init()` が作った client を module の関数が使う。`init()` を呼ぶ前に
`captureException()` などを呼ぶと例外になる。

```js
Monica.captureException(error);
Monica.captureMessage("checkout retried", "warning");

Monica.setUser({ id: "opaque-user-id" }); // null で解除
Monica.addBreadcrumb({ category: "ui", message: "submit clicked" });

Monica.withScope((scope) => {
  scope.setTag("feature", "checkout");
  scope.setContext("cart", { items: 3 });
  Monica.captureException(error);
});

await Monica.flush();  // 既定 2000 ms 待つ
await Monica.close();  // 自動収集を外して送り切る
```

queue は `flushIntervalMs` ごとに送るが、`level` が `fatal` の event と、queue が
`batchSize` に達したときはすぐ送る。tab が隠れたときも自動で flush する。

`captureException()` / `captureMessage()` は event id を Promise で返す（送らなかった
場合は `null`）。`captureException(error, context)` の第 2 引数と
`captureMessage(message, level, context)` の第 3 引数で `user` / `tags` / `contexts` /
`breadcrumbs` / `request` / `fingerprint` を 1 件だけ上書きできる（`captureException()`
は `level` も。`captureMessage()` の `level` は第 2 引数）。

client を明示的に持ちたい場合は `createBrowserClient()` を使う。`init()` と同じ
options を取り、グローバルの client は置き換えない。

```js
import { createBrowserClient } from "@ah-monica/browser";

const monica = createBrowserClient({ dsn: window.MONICA_DSN, environment: "production" });
```

### React

`createBrowserClient()` で作った client を `MonicaProvider` に渡し、
`MonicaErrorBoundary` で render 中のエラーを拾う。

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

component の中からは `useMonica()` で client を、`useMonicaCapture()` で既定の
capture context を合成した関数を取れる。既存の Error Boundary からは
`captureReactException(client, error, componentStack)` を呼ぶ。component stack は
`contexts.react.componentStack`、`tags.integration` は `react` になる。詳細は
[`react/README.md`](react/README.md)。

## オプション

`init()` / `createBrowserClient()` に渡す `BrowserClientOptions`。

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string` | （必須） | `https://<mpk_ key>@<host>/...`。送信先は origin + `/v1/envelope` |
| `environment` | `string` | （必須） | 空文字不可、128 文字以内 |
| `release` | `string` | なし | event の release |
| `screenId` | `string` | なし | 全 event に `screen.id` tag として付く |
| `route` | `string` | なし | `/form/follow/{token}` のような path template。`/` 始まりで `//` 始まりや `?` `#` を含まないこと。`request.url` が origin + この値になる |
| `sampleRate` | `number` | `1` | 0〜1。event 単位のサンプリング |
| `maxBreadcrumbs` | `number` | `50` | 保持する breadcrumb の上限 |
| `maxQueueSize` | `number` | `100` | 送信待ち queue の上限。溢れると古い方から捨てて discarded に勘定する |
| `batchSize` | `number` | `30` | 1 envelope に載せる item 数。`maxQueueSize` と 100 のうち小さい方に丸める |
| `flushIntervalMs` | `number` | `5000` | queue を自動で送る間隔 |
| `requestTimeoutMs` | `number` | `2000` | 1 リクエストの timeout。tab が隠れたときの自動 flush の待ち時間にも使う |
| `maxRetries` | `number` | `2` | 429 / 5xx / 通信エラーの再試行回数 |
| `dedupeWindowMs` | `number` | `1000` | 同じエラーを捨てる窓。`0` で無効 |
| `autoCapture` | `boolean` | `true` | `window.onerror` / `unhandledrejection` / XHR breadcrumb / 自動 flush を仕掛けるか |
| `captureConsoleErrors` | `boolean` | `false` | `console.error` を event にするか |
| `beforeSend` | `(item, hint) => item \| null \| Promise<…>` | なし | capture のたびに、queue へ積む前に item を書き換える。`null` を返すと捨てる |
| `onDiagnostic` | `(diagnostic) => void \| null \| false` | なし（= `console.warn`） | 拒否された送信の通知先。`null` / `false` で無効化 |
| `fetch` | `FetchLike` | `window.fetch` | 送信に使う fetch |
| `window` | `Window` | グローバルの `window` | 自動収集を仕掛ける window |
| `now` | `() => Date` | `() => new Date()` | 時刻の取得 |

`init()` は前の client があれば閉じてから作り直す。

## 自動で収集するもの

- `window.onerror` と `unhandledrejection`（`autoCapture: true` のとき）
- 手動の `captureException()` / `captureMessage()`
- status が 0 または 400 以上の `XMLHttpRequest` を breadcrumb に記録する。URL は
  origin だけ、あわせて method・status・所要時間を残す
- page URL は origin のみ（`route` を指定したときだけ template を足す）、`screen.id`
  tag、`release`、stack frame（`node_modules` と拡張機能由来は `in_app: false`）
- 同じエラーは `dedupeWindowMs` の窓で 1 回だけ送る
- 送信中に起きたエラーと、送信そのものの失敗は自動収集へ戻さない

`console.error` の収集は既定 OFF で、`captureConsoleErrors: true` のときだけ拾う。
user は自動検出せず、`setUser()` を呼んだ場合だけ event に入る。request body、
Cookie、`Authorization` は収集しない。stack frame の URL からは user info・query・
fragment を落とす。現在の pathname は token や個人識別子を含み得るので収集しない。
アプリ固有の個人情報は `beforeSend` で allowlist 方式に落とす。

## 送信結果と診断

ingest が envelope を拒否すると、既定では `422`（envelope の形が契約と違う）、
`401`（key が不正・失効。以後の送信を止める）、`413`（経路上のサイズ上限）を
`console.warn` に 1 行で出す。`onDiagnostic` を渡すと警告の代わりにその関数へ渡り、
`null` / `false` で無効になる。

`flush()` / `close()` の戻り値には `accepted` / `discarded` / `remaining` に加えて、
拒否があったときだけ `status` / `issues` / `error` / `stopped` と、その flush で
拒否された全件の `diagnostics` が載る。

警告の読み方、status ごとの扱い、`onDiagnostic` と結果の field の詳細は
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 制約

- DSN に public key（`mpk_`）以外を渡すと `init()` が失敗する。secret key（`msk_`）は
  browser に置かない
- client の生成には `window` と `fetch` が要る。SSR では初期化しない
- breadcrumb を取るのは `XMLHttpRequest` だけ。`fetch()` は hook しない
- envelope は gzip 後 1 MiB、展開後 8 MiB、item 100 件、stack frame 200 件が上限。
  SDK は送信前に JSON を 1,000,000 byte 未満に抑えて分割する
- 例外の `cause` chain は 10 件までたどる
- `@ah-monica/react` の peer 依存は React `^18.0.0 || ^19.0.0`

## ライセンス

Apache-2.0（[LICENSE](LICENSE)）

## 開発者向け

### ビルドとテスト

```bash
bun install
bun run check            # 下の全部
bun run check:tooling    # 取り込みスクリプトと公開面の検査
bun run check:spec       # 公開契約のコピーの整合（オフライン）
bun run check:browser    # typecheck / test / pack / webpack bundle / IIFE smoke / TypeScript 4.8
bun run check:react      # typecheck / test / pack
```

CI（`.github/workflows/ci.yml`）は React 18.3.1 と 19.1.1 の両方で `check:react` を回す。

### 公開契約（spec/）

```bash
bun run spec:sync           # 公開 URL から取り込んで spec/v1/ を作り直す
bun run spec:check-remote   # 取得して比べるだけ。差分があれば exit 1
bun run check:spec          # 手元のコピーの整合だけを見る
```

契約テストは `browser/test/contract.test.ts` と `tooling/spec-bundle.test.ts`。
取り込みの詳細は [`spec/README.md`](spec/README.md)。

### リリース

1. `bun run version:set X.Y.Z` で version を上げ、`bun install` で lockfile を
   更新して main へ merge する（root の `package.json` から `browser` / `react` の
   package.json と `browser/src/client.ts` の `sdk.version` へ配る）
2. その commit に `vX.Y.Z` tag を付けて push する

`.github/workflows/npm-release.yml` が tag と version の一致を確かめ、`bun run check`
を通してから `browser` → `react` の順に npm へ公開する（Trusted Publisher / OIDC）。
