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
