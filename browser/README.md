# @ah-monica/browser

素のJavaScriptを含むbrowser application向けのMONICA SDKです。npm向けESMと、
`<script>`で読めるIIFE版を同じpackageから配布します。

DSNにはbrowserへ公開してよい`mpk_...` keyだけを指定してください。secretの
`msk_...` keyは初期化時に拒否します。

## install

```sh
npm install @ah-monica/browser
```

## ESM

```js
import * as Monica from '@ah-monica/browser'

Monica.init({
  dsn: window.MONICA_DSN,
  environment: 'production',
  release: window.APP_RELEASE,
  screenId: 'admin-users',
  route: '/admin/users/{id}', // 実pathnameではなく、安全なtemplateだけを明示
  beforeSend(event) {
    delete event.user
    if (event.request) delete event.request.headers
    return event
  },
})

Monica.captureException(error)
```

## script tag

```html
<script src="/vendor/monica.min.js"></script>
<script>
  Monica.init({
    dsn: window.MONICA_DSN,
    environment: 'production',
    release: window.APP_RELEASE,
    screenId: 'checkout'
  })
</script>
```

IIFEはpackage内の`dist/monica.min.js`です。CDNから使う場合もversionを固定してください。

## 収集範囲

- `window.onerror`と`unhandledrejection`を自動収集
- 手動の`captureException()` / `captureMessage()`
- status 0または400以上のXMLHttpRequestをbreadcrumbへ記録（既定はoriginのみ）
- originだけのpage URL、`screen.id` tag、release
- 同じerrorを既定1秒の窓で重複排除
- 送信中のerrorと送信失敗を自動収集へ戻さない

`console.error`収集は既定OFFです。有効化する場合だけ
`captureConsoleErrors: true`を指定します。userは自動検出せず、
`setUser()`を明示的に呼んだ場合だけeventへ含めます。request body、Cookie、
Authorizationは自動収集しません。アプリケーション固有のPIIは`beforeSend`で
allowlist方式により除去してください。

現在のpathnameはtokenや個人識別子を含み得るため自動収集しません。診断にrouteが必要な場合は、
`route: '/form/follow/{token}'`のように実値を含まないtemplateを明示してください。

## 送信が拒否されたとき

`422`（envelope schema 不正）と`401`（keyの不正・失効）は既定で`console.warn`に出ます。
`422`はそのenvelopeを破棄し、`401`は破棄して以後の送信を止めます（警告は1回だけ）。

```text
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s); $.items[0].request.method: Invalid type: Expected string
monica: ingest rejected the envelope with 401 (unauthorized); no further envelopes will be sent
```

`422`の`issues`のpathは修正すべきfieldを指します。上の例なら`beforeSend`が
`request.method`を落としているので、`beforeSend`を直します。

警告経路は`onDiagnostic`で差し替え、`null`または`false`で無効化します（既定は未指定＝
`console.warn`）。差し替えた場合は`429`以外の4xxすべてが届きます。

```js
Monica.init({
  dsn: window.MONICA_DSN,
  environment: 'production',
  onDiagnostic(diagnostic) {
    // diagnostic: { status, issues, error?: { code, message }, message }
    // message は既定の警告と同じ1行。core と同じ文面なのでSDK横断で検索できる
    myLogger.warn(diagnostic.message, diagnostic.status, diagnostic.issues)
  },
})
```

`flush()` / `close()`の戻り値の`diagnostics`からも読めます。既存のfieldはそのままで、
拒否があったときだけ増えます。入るのは前回取り出して以降の未報告分（tabが隠れたときの
自動flushで拒否されたぶんも含む）で、取り出すと空になります。控えは20件を超えると
古い方から捨てます。

coreも`status` / `issues` / `error`を戻り値に載せますが、載るのは直前の1件だけです。
`413`の分割再送や1MB超の分割では1回のflushで複数envelopeを送るため、最後以外の指摘は
そちらからは読めません。全件を見るには`diagnostics`を使ってください。

```js
const result = await Monica.flush()
for (const diagnostic of result.diagnostics ?? []) {
  console.log(diagnostic.status, diagnostic.issues)
}
```

statusごとの扱い:

- `400` / `422`: 破棄。リトライしない
- `401`: 破棄。以後そのclientからは送らない。clientは閉じ、以後の
  `captureException()` / `captureMessage()`は`null`を返す。queueに残っていた分は
  `discarded`に勘定する。止まったことは`flush()`の`stopped`で分かる。送信を再開するには
  正しいkeyでclientを組み直す
- `429` / `5xx`: リトライする
- error bodyを読むのは`429`以外の4xxだけ。上限は64 KiBで、超える場合や形が違う場合は
  `issues`無しの破棄として扱う
