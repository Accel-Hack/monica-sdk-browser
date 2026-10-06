# @ah-monica/browser

素の JavaScript を含む browser アプリ向けの MONICA SDK。npm 向けの ESM と、
`<script>` で読める IIFE 版を同じ package で配布する。

## 対応環境

`fetch` / `CompressionStream` / `AbortController` / `crypto.randomUUID` のある
browser。型定義は TypeScript 4.8 以降で解決できる。

ESM も IIFE（`monica.min.js`）も ES2022 を target に出力し、古い構文へ transpile しない。
`??` / `?.` を含むので、読み込めるのは Chrome 80 / Android System WebView 80 以上。
error の送信には `crypto.randomUUID` と `Array.prototype.at` も使うので、全機能が動くのは
Chrome 92 / Android System WebView 92 以上。

## インストール

```sh
npm install @ah-monica/browser
```

bundler を使わない場合は package 内の `dist/monica.min.js` を配信するか、CDN から
version を固定して読む。読み込むとグローバルに `Monica` が生える。

```html
<script src="https://cdn.jsdelivr.net/npm/@ah-monica/browser@0.2.0/dist/monica.min.js"></script>
```

## 初期化

```js
import * as Monica from "@ah-monica/browser";

Monica.init({
  dsn: window.MONICA_DSN,
  environment: "production",
  release: window.APP_RELEASE,
  screenId: "admin-users",
  route: "/admin/users/{id}", // 実 pathname ではなく、安全な template だけを明示
  beforeSend(event) {
    delete event.user;
    if (event.request) delete event.request.headers;
    return event;
  },
});
```

DSN の key には browser へ公開してよい public key（`mpk_` 始まり）だけを指定する。
secret key（`msk_` 始まり）、key の無い DSN、`https` 以外の DSN（`localhost` と
`127.0.0.1` の `http` だけ例外）は `init()` が `TypeError` を投げる。

`dsn` が未指定・`null`・空文字（空白だけも含む）なら、例外を出さずに何も送らない
client を返す。自動収集も仕掛けず、`captureException()` などは `null` を返す。

`<script>` 版も同じ options を取る。

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

`captureException()` / `captureMessage()` は event id を Promise で返す（送らなかった
場合は `null`）。`captureException(error, context)` の第 2 引数と
`captureMessage(message, level, context)` の第 3 引数で `user` / `tags` / `contexts` /
`breadcrumbs` / `request` / `fingerprint` を 1 件だけ上書きできる（`captureException()`
は `level` も。`captureMessage()` の `level` は第 2 引数）。

module の関数は `init()` が作った client を使う。`init()` を呼ぶ前に呼ぶと例外になり、
`init()` を呼び直すと前の client は閉じる。client を自分で持つ場合は
`createBrowserClient()` を使う（`init()` と同じ options を取り、グローバルの client は
置き換えない）。React 統合はこの client を [`@ah-monica/react`](https://github.com/Accel-Hack/monica-sdk-browser/tree/main/react) に渡す。

```js
import { createBrowserClient } from "@ah-monica/browser";

const monica = createBrowserClient({ dsn: window.MONICA_DSN, environment: "production" });
```

queue は `flushIntervalMs` ごとに送るが、`level` が `fatal` の event と、queue が
`batchSize` に達したときはすぐ送る。tab が隠れたときも自動で flush する。

## オプション

`init()` / `createBrowserClient()` に渡す `BrowserClientOptions`。

| option | 型 | default | 説明 |
| --- | --- | --- | --- |
| `dsn` | `string \| null` | なし | `https://<mpk_ key>@<host>/...`。送信先は origin + `/v1/envelope`。未指定・空なら何も送らない |
| `environment` | `string` | （必須） | 空文字不可、128 文字以内 |
| `release` | `string` | なし | event の release。build 時に git の commit SHA を埋め込み（Vite の `define` や env など）、server 側 SDK と同じ値にすると両方の event が揃う |
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

## 自動で収集するもの

- `window.onerror` と `unhandledrejection`（`autoCapture: true` のとき）
- 手動の `captureException()` / `captureMessage()`
- status が 0 または 400 以上の `XMLHttpRequest` を breadcrumb に記録する。URL は
  origin だけ、あわせて method・status・所要時間を残す
- page URL は origin のみ（`route` を指定したときだけ template を足す）、`screen.id`
  tag、`release`、stack frame（`node_modules` と拡張機能由来は `in_app: false`）
- 同じエラーは `dedupeWindowMs` の窓で 1 回だけ送る
- error の送信中に起きたエラーと、送信そのものの失敗は自動収集へ戻さない

`console.error` の収集は既定 OFF で、`captureConsoleErrors: true` のときだけ拾う。
user は自動検出せず、`setUser()` を呼んだ場合だけ event に入る。request body、
Cookie、`Authorization` は収集しない。stack frame の URL からは user info・query・
fragment を落とす。現在の pathname は token や個人識別子を含み得るので収集しない。
診断に route が必要なら、`route: '/form/follow/{token}'` のように実値を含まない
template を明示する。アプリ固有の個人情報は `beforeSend` で allowlist 方式に落とす。

## Issue のまとめ方

どのエラーを同じ Issue にまとめるかは MONICA 側で決まり、SDK は決めない。規則は
[`spec/v1/grouping.md`](https://github.com/Accel-Hack/monica-sdk-browser/blob/main/spec/v1/grouping.md) にある。分かれ方が意外なときは、管理画面の
Issue 詳細の「まとめ方」で、その Issue がどの値でまとめられたかを確かめる。

この SDK に固有の点は次のとおり。

- event は `platform: "javascript"` で送るので、MONICA は frame の関数名を見ずにファイルだけを
  見る。同じ bundle の中で起きた同じ型のエラーは 1 つの Issue になりやすい
- bundle のファイル名のハッシュと配信元のホスト名は MONICA が無視するので、deploy や配信元を
  変えても同じエラーは同じ Issue のまま
- `node_modules` の下と拡張機能（`chrome-extension:` / `moz-extension:` / `safari-extension:`）の
  frame は `in_app: false` になる
- 分けたいときは、発生した場所で専用の Error のサブクラスを投げるか、`fingerprint` を渡す。
  `fingerprint` は既定の分け方を置き換えるので、どこで起きたかの区別も値に含める

## 稼働確認

error が無い期間も MONICA が「この環境の SDK は動いている」と分かるように、稼働確認を送る。

- 送るもの: `client_report` item 1 件だけの envelope（`trigger: "start"`）。endpoint・
  認証・再試行（`maxRetries`）は error と同じ
- 送る時: `createBrowserClient()` / `init()` を呼んだとき（= ページ読み込み時）と、tab や
  WebView が再び可視になったとき（`visibilitychange` で `visible`）に判定する。タイマーは
  持たず、SPA の画面遷移では判定しない。`autoCapture: false` でも送る。`dsn` が無い client は
  送らない
- 送らない時: 直近 1 日に `202` を受けた envelope があるとき。error の envelope の `202`
  でも期限が伸びる。判定した時点から次の 1 日を数えるので、送信に失敗しても次の判定まで
  送り直さない
- 状態の置き場所: `localStorage` のキー `monica.presence.<DSN の API key>` に JSON
  （`intervalStartedAt` と、MONICA から届いた `intervalMs` / `sampleRate`）で持つ。
  同じ origin の tab 同士は状態を共有し、DSN の API key が違う client 同士は共有しない
- `localStorage` が使えない環境（private mode、site data のブロックなど）では
  `sessionStorage`、それも使えなければメモリに持つ。`sessionStorage` なら tab ごと、
  メモリならページ読み込みのたびに送る
- WebView に埋め込む場合: 読み込みが 1 回きりの SPA でも、アプリが前面に戻って WebView が
  可視になるたびに判定する。DOM storage が無効（Android の `setDomStorageEnabled(false)` など）
  だとメモリに持つので、読み込みのたびに送る
- 端末の WebView が 80 未満だと `monica.min.js` は構文エラーで読み込まれず、`Monica` が
  未定義になる。ページの他の script は動くが、`Monica` を呼ぶ script はそこで止まる
- MONICA 側の設定: `202` の応答 header `X-Monica-Presence-Interval-Ms`（間隔）と
  `X-Monica-Presence-Sample-Rate`（送る端末の割合）を保存し、次の判定から使う。既定は
  1 日、間引かない。SDK に設定項目は無く、MONICA の project 設定で変わる

## 送信結果と診断

ingest が envelope を拒否すると、既定では `422`（envelope の形が契約と違う）、
`401`（key が不正・失効。以後の送信を止める）、`413`（経路上のサイズ上限）を
`console.warn` に 1 行で出す。`onDiagnostic` を渡すと警告の代わりにその関数へ渡り、
`null` / `false` で無効になる。

`flush()` / `close()` の戻り値には `accepted` / `discarded` / `remaining` に加えて、
拒否があったときだけ `status` / `issues` / `error` / `stopped` と、その flush で
拒否された全件の `diagnostics` が載る。

警告の読み方、status ごとの扱い、field の詳細は
[TROUBLESHOOTING.md](https://github.com/Accel-Hack/monica-sdk-browser/blob/main/TROUBLESHOOTING.md)。

## 制約

- DSN に public key（`mpk_`）以外を渡すと `init()` が失敗する
- client の生成には `window` と `fetch` が要る。SSR では初期化しない
- breadcrumb を取るのは `XMLHttpRequest` だけ。`fetch()` は hook しない
- envelope は gzip 後 1 MiB、展開後 8 MiB、item 100 件、stack frame 200 件が上限。
  SDK は送信前に JSON を 1,000,000 byte 未満に抑えて分割する
- 例外の `cause` chain は 10 件までたどる

## ライセンス

Apache-2.0
