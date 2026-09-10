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

MONICAがenvelopeのschema違反で`422`を返すと、SDKはそのenvelopeを破棄します。
その際に返ってくるerror bodyには、直すべきfieldのpath（`$.items[0].request.method`
など）が入っています。SDKはこれを**既定で`console.warn`へ出します**。

```text
monica: ingest rejected the envelope with 422 (invalid_envelope): 1 issue(s)
 - $.items[0].request.method: Invalid type: Expected string
```

`beforeSend`でeventをallowlist方式に組み替える場合、必須のkeyを落とすと
この状態になります（`request`は任意ですが、載せるなら`method`は必須）。
1件も送信できていないことに気付けるよう、警告は既定で出します。

警告経路は`onDiagnostic`で差し替えられます。`null`または`false`で無効化します。
差し替えた場合は`429`以外の4xxすべてが届きます（既定の`console.warn`は`422`だけ）。

```js
Monica.init({
  dsn: window.MONICA_DSN,
  environment: 'production',
  onDiagnostic(diagnostic) {
    // diagnostic: { accepted, status, error?: { code, message }, issues?: [{ path, message }] }
    myLogger.warn('monica rejected', diagnostic.status, diagnostic.issues)
  },
})
```

`flush()` / `close()`の戻り値からも読めます。既存のfieldはそのままで、
拒否があったときだけ`diagnostics`が増えます（取り出すと控えは空になります）。

```js
const result = await Monica.flush()
for (const diagnostic of result.diagnostics ?? []) {
  console.log(diagnostic.status, diagnostic.issues)
}
```

`422`以外のstatusの扱いは変わりません。`400`は破棄してリトライせず、`401`は破棄して
以後の送信を止め、`429`と`5xx`はリトライします。error bodyは`429`以外の4xxでだけ
読み、上限（64 KiB）を超える場合や形が違う場合は`issues`無しの破棄として扱います。
