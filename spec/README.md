# spec/

MONICA の公開契約バンドルを **vendoring したコピー**。正本は MONICA 本体が生成し、
`https://spec.monica.accelhack.net/v1/` で配信している。ここにあるのはその
そのままのコピーで、**手で編集しない**。編集しても次の取り込みで消える。

```
spec/
  README.md   この説明（コピーの一部ではない）
  v1/         https://spec.monica.accelhack.net/v1/ と同じ相対パスで置く
```

パスの `v1` は Ingest API の版（`POST /v1/envelope`）で、バンドル自身の版では
ない。v1 API が育つあいだ中身は変わる。**どの契約で作ったかは git の履歴と
`spec/v1/index.json` の `revision` が記録する**。`revision` はバンドル全体の指紋で、
版番号ではない。

## 取り込み

```bash
bun run spec:sync           # 公開 URL から取得して spec/v1/ を作り直す
bun run spec:check-remote   # 取得して比べるだけ。差分があれば exit 1
bun run check:spec          # オフライン。手元のコピーの整合だけを見る（CI はこれ）
```

契約テスト（`browser/test/contract.test.ts`、`tooling/spec-bundle.test.ts`）は
このコピーに対して**オフライン**で走る。だから fork からの PR も手元の clone も
そのまま通る。

公開 URL との差分検査は `pull_request` に付けない。`.github/workflows/spec-sync.yml`
を手で起動して取りに行き、違えば取り込んだ状態で `bun run check` を回し、結果を
本文に書いた PR を出す。`GITHUB_TOKEN` が作った PR では CI が起動しないので、
検査結果は PR 本文で読む。

## 取り込みは index.json から始める

`index.json` が全ファイルのパスと sha256、全体の `revision` を持つ。取り込みは
そこから列挙し、各ファイルの sha256 が一致することを確かめてから書く。
`revision` は「sha256、空白 2 つ、path」を byte 順に改行で繋いだ文字列の sha256 で、
再計算と合わないときは警告だけ出す（各ファイルの一致が取れていれば中身は正しい）。

索引が 404 のときだけ、手元にあるファイルの一覧を取りに行く。このモードでは
**上流にファイルが増えたことは検知できない**。取り込みの出力にその旨が出る。
