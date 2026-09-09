# monica-sdk-browser

MONICA の browser 向け SDK。npm の `@ah-monica/*` として公開する。

| ディレクトリ | package | 依存 |
| --- | --- | --- |
| [`browser/`](browser/) | `@ah-monica/browser` | `@ah-monica/core`（npm 公開版） |
| [`react/`](react/) | `@ah-monica/react` | `@ah-monica/browser`（同じ repository） |
| [`spec/`](spec/) | — | 公開契約バンドルの vendoring したコピー |

`@ah-monica/core` はこの repository には無い（`monica-sdk-js` が正本）。`browser` は
npm 公開版の `core` を参照する。**`core` を直して `browser` で確かめるには、先に
`core` を publish する必要がある**。これは受け入れたトレードオフ。

## 開発

```bash
bun install
bun run check            # 下の全部
bun run check:tooling    # 取り込みスクリプトと公開面の検査
bun run check:spec       # 公開契約のコピーの整合（オフライン）
bun run check:browser    # typecheck / test / pack / webpack bundle / IIFE smoke / TypeScript 4.8
bun run check:react      # typecheck / test / pack
```

`check:react` の typecheck は `browser/dist` を要るので、先に browser を build する
（script が面倒を見る）。CI は React 18.3.1 と 19.1.1 の両方で test を回す。

## 公開契約

MONICA へ送る envelope の形、上限、Ingest API の叩き方は
`https://spec.monica.accelhack.net/v1/` で配信されている公開契約バンドルが決める。
この repository は [`spec/v1/`](spec/v1/) にそのコピーを持ち、契約テストは
そのコピーに対してオフラインで走る。

- `browser/test/contract.test.ts` — browser SDK が実際に送る request（gzip した
  envelope、ヘッダ、送信先、リトライ）が契約のとおりか。定数は `transport.json` から
  読み、テストに写さない
- `tooling/spec-bundle.test.ts` — コピー自体の整合。test vectors を公開 JSON Schema
  で回す

公開契約が変わったら `bun run spec:sync` で取り込み、差分を PR にする。詳細は
[`spec/README.md`](spec/README.md)。

## release

1. `browser/package.json` と `react/package.json` の `version`、`react` の
   `@ah-monica/browser` 依存、`browser/src/client.ts` の `sdk.version` を同じ値に上げて
   main へ merge する（`sdk.version` が package.json と食い違うと契約テストが落ちる）
2. その commit へ `vX.Y.Z` tag を付けて push する

`.github/workflows/npm-release.yml` が tag と version の一致を検査し、
`bun run check` を通してから `browser` → `react` の順に npm へ公開する。
npm の Trusted Publisher（OIDC）で公開するので長期 token は持たない。
Trusted Publisher の登録は npm 側の package Settings で、Organization `Accel-Hack`、
Repository `monica-sdk-browser`、Workflow `npm-release.yml` を指す必要がある。

## License

Apache-2.0
