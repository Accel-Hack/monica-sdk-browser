# トラブルシューティング

`@ah-monica/browser` と `@ah-monica/react` で、送ったはずの event が MONICA に
届かないときに読む。

## 警告の見方

ingest が envelope を拒否すると、既定では browser の `console.warn` に 1 行出る。
`onDiagnostic` を指定した場合はそちらへ渡り、`console.warn` には出ない。

```text
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
monica: ingest rejected the envelope with 401 (unauthorized); no further envelopes will be sent
monica: ingest rejected the envelope with 413 (unknown); splitting and resending. A size limit on the path may be below the 1 MiB (gzip) contract
```

- `422` は envelope 1 通につき 1 回。`401` と `413` は client（transport）につき 1 回だけ
- 括弧の中は ingest が返した `error.code`。読めなかった場合は `unknown`
- `422` は `issues` の件数に続けて `<path>: <message>` を `; ` で繋ぐ
- 文面は SDK 横断で同じなので、そのまま検索できる
- API key と envelope 本体は出さない。出るのは status / code / message / issue の path

既定で警告を出すのは `422` / `401` / `413` の 3 つだけ。`onDiagnostic` を渡した場合は
リトライしない 4xx（`429` を除く）すべてが handler に届く。リトライのたびには呼ばない。

## ingest が envelope を拒否したとき

### 422 — envelope の形が契約と違う

その envelope を捨てる。リトライしない。`issues` の `path` は直すべき field を指す。
`$.items[0].request.method` なら `beforeSend` が `request.method` を落としている。

### 401 — key が不正・失効

その envelope を捨て、以後その client からは送らない。client は閉じ、
`captureException()` / `captureMessage()` は `null` を返す。queue に残っていた分は
`discarded` に勘定する。止まったことは `flush()` の戻り値の `stopped` で分かる。
送信を再開するには正しい key で client を作り直す。

### 413 — 経路上のサイズ上限

item を半分に割って送り直す。1 件でも `413` なら捨てる。SDK は送信前に envelope の
JSON を 1,000,000 byte 未満に抑えており、契約上の上限は gzip 後 1 MiB なので、
spec どおりの ingest から `413` は返らない。返った場合は経路上の何か（proxy /
gateway / WAF）が契約より低い body 上限を持っている。割った先がすべて受理されても
`flush()` の `status` は `413` のまま残る。

### status ごとの扱い

| status | 扱い |
| --- | --- |
| `202` | 受理 |
| `400` / `422` | 破棄。リトライしない |
| `401` | 破棄し、以後そのクライアントからは送らない |
| `413` | item を半分に割って送り直す |
| `429` | `Retry-After`（整数秒、最大 60 秒）だけ待ってリトライ |
| `5xx` | backoff してリトライ |

error body を読むのは `429` 以外の 4xx だけ。上限は 64 KiB で、超える場合・空・
JSON でない場合・形が違う場合は `issues` 無しの破棄として扱う。

## 送信結果の受け取り

### onDiagnostic

```js
Monica.init({
  dsn: window.MONICA_DSN,
  environment: "production",
  onDiagnostic(diagnostic) {
    // { status: number, issues: { path, message }[], error?: { code, message }, message: string }
    myLogger.warn(diagnostic.message, diagnostic.status, diagnostic.issues);
  },
});
```

`null` または `false` を渡すと通知を切る（既定の `console.warn` も出なくなる）。
省略すると `console.warn`。handler が例外を投げても送信経路は壊さない。

### flush() / close() の戻り値

```js
const result = await Monica.flush();
for (const diagnostic of result.diagnostics ?? []) {
  console.log(diagnostic.status, diagnostic.issues);
}
```

| field | 型 | 内容 |
| --- | --- | --- |
| `accepted` | `boolean` | その flush で送るべきものをすべて送り切れたか |
| `discarded` | `number` | 捨てた item 数 |
| `remaining` | `number` | queue に残っている item 数 |
| `status` | `number?` | 直前に受理されなかった送信の HTTP status。無ければ欄ごと無い |
| `issues` | `{ path, message }[]?` | その送信で読めた `error.issues`（実質 `422` のみ） |
| `error` | `{ code, message }?` | その送信で読めた `error.code` / `error.message` |
| `stopped` | `boolean?` | `401` で client が閉じたあとは `true`。一度立つと戻らない |
| `diagnostics` | `TransportDiagnostic[]?` | その flush までに拒否された全件（browser SDK の追加） |

`status` / `issues` / `error` に載るのは直前の 1 件だけ。`413` の分割再送や
1 MB 超の分割では 1 回の flush で複数の envelope を送るので、全件を見るには
`diagnostics` を使う。

`diagnostics` に入るのは前回取り出して以降の未報告分（tab が隠れたときの自動 flush で
拒否されたぶんも含む）で、取り出すと空になる。控えは 20 件を超えると古い方から捨てる。
拒否が無ければ欄ごと無い。`onDiagnostic` で通知を切っていても控えは残る。

## 再送・queue の挙動

- リトライするのは `429` / `5xx` と通信エラーだけ。回数は `maxRetries`（既定 2）
- backoff は `min(1000 * 2^attempt, 30000)` ms に 50〜100 % の jitter。`429` は
  `Retry-After`（整数秒のみ、60 秒で頭打ち）を優先する
- 1 リクエストの timeout は `requestTimeoutMs`（既定 2000 ms）
- queue は `flushIntervalMs`（既定 5000 ms）ごとに送る。`level: "fatal"` の event と、
  queue が `batchSize`（既定 30）に達したときはすぐ送る
- queue が `maxQueueSize`（既定 100）を超えると古い方から捨て、`discarded` に勘定して
  次の envelope で報告する
- `document.visibilityState` が `hidden` になると自動で flush する
- 1 件だけで JSON 1,000,000 byte を超える item は送れないので捨てる

## よくある原因と対処

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `init()` が `TypeError: browser dsn must contain a public mpk_ key` | DSN の key が `mpk_` 始まりでない | public key を使う。`msk_` は browser に置かない |
| `init()` が `TypeError: dsn must use https except for localhost` | DSN が `http`（`localhost` / `127.0.0.1` 以外） | https の DSN を使う |
| `init()` が `TypeError: dsn must include an API key as the username` | DSN の user info が空 | `https://<key>@<host>/` の形にする |
| `init()` が `TypeError: route must be a path template…` | `route` が `/` 始まりでない、`//` 始まり、`?` / `#` を含む | `/form/follow/{token}` のような template にする |
| `init()` が `TypeError: environment must not be empty` / `RangeError: environment must not exceed 128 characters` | `environment` が空か長すぎる | 128 文字以内の非空文字列にする |
| `init()` が `RangeError: sampleRate must be between 0 and 1` | `sampleRate` が範囲外 | 0〜1 にする |
| `Error: Monica.init() must be called first` | `init()` の前に capture した | `init()` を先に呼ぶか、`createBrowserClient()` の client を直接使う |
| `Error: A browser window is required` / `A fetch implementation is required` | SSR など window / fetch の無い環境で生成した | browser でだけ初期化する |
| 422 の path が `$.items[0].request.…` | `beforeSend` が契約上必須の field を落としている | その field を消さない |
| 401 のあと何も届かない | key の失効・取り違え | 正しい key で client を作り直す |
| 413 が出る | 経路上の proxy / gateway / WAF の body 上限が契約より低い | 経路側の上限を 1 MiB 以上にする |
| 何も送られない | `sampleRate` が小さい、`beforeSend` が `null` を返している、`autoCapture: false` | それぞれの設定を見直す |
| 自動収集が動かない | `autoCapture: false`、または `console.error` は既定 OFF | `captureConsoleErrors: true` を指定する |
