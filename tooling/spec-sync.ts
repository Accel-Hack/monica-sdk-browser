/**
 * 公開契約バンドルの取り込み。
 *
 *     bun run spec:sync            公開 URL から取得し、spec/v1/ を作り直す
 *     bun run spec:check-remote    取得して比べるだけ。差分があれば exit 1
 *     bun run check:spec           オフライン。手元のコピーの整合だけを見る
 *
 * 向きは「SDK repository 側から取りに行く」。MONICA 本体は private で、
 * そこから public repository へ push するには書き込み資格情報が要る。取りに
 * 行く側なら repository 自身の GITHUB_TOKEN だけで済む。
 *
 * 差分検査（--check）は pull_request には付けない。fork からの PR には外部
 * 通信の前提が揃わず、付けると外部 PR が全部落ちる。契約テストは手元の
 * コピーだけで完結させ、差分検査は schedule の job（spec-sync.yml）が回す。
 *
 * 取り込みは索引（index.json）から始める。索引が配信されていない（404）
 * うちは、手元のコピーにあるファイルと REQUIRED_FILES を取りに行く。この
 * モードでは上流にファイルが増えたことは検知できないので、その旨を出す。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  BASE_URL,
  type BundleFiles,
  type BundleIndex,
  bundleRoot,
  compareBytes,
  decode,
  INDEX_FILE,
  indexProblems,
  parseIndex,
  readLocalBundle,
  REQUIRED_FILES,
  sha256Hex,
} from "./spec";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RemoteBundle = {
  files: BundleFiles;
  /** 索引が配信されていれば入る */
  index?: BundleIndex;
  /** 索引が無かったので、手元のファイル一覧から取りに行った */
  fallback: boolean;
  notes: string[];
};

export type Diff = {
  added: string[];
  removed: string[];
  changed: string[];
};

async function get(fetchImpl: FetchLike, base: string, path: string): Promise<Response> {
  const url = new URL(path, base).toString();
  const response = await fetchImpl(url, {
    headers: { Accept: "*/*" },
    // 配信側は短い max-age で再検証させる方針。ここは常に最新が欲しい
    cache: "no-store",
  });
  return response;
}

/**
 * 公開 URL からバンドル 1 つ分を取る。索引があれば索引に従い、各ファイルの
 * ダイジェストと revision を検証する。索引が無ければ `localPaths` を取りに行く。
 */
export async function fetchRemoteBundle(
  fetchImpl: FetchLike,
  localPaths: Iterable<string>,
  base: string = BASE_URL,
): Promise<RemoteBundle> {
  const notes: string[] = [];
  const files: BundleFiles = new Map();

  const indexResponse = await get(fetchImpl, base, INDEX_FILE);
  if (indexResponse.status === 200) {
    const indexBytes = new Uint8Array(await indexResponse.arrayBuffer());
    const index = parseIndex(decode(indexBytes));
    if (index.base !== base) {
      // README の言うとおり、信じるのは自分の設定した取得先。複製を読んで
      // いるかもしれないので出しておくが、止めはしない
      notes.push(`${INDEX_FILE} の base (${index.base}) が取得先 (${base}) と違う`);
    }
    for (const entry of index.files) {
      const response = await get(fetchImpl, base, entry.path);
      if (response.status !== 200) {
        throw new Error(`${entry.path}: 索引にあるのに HTTP ${response.status}`);
      }
      files.set(entry.path, new Uint8Array(await response.arrayBuffer()));
    }
    files.set(INDEX_FILE, indexBytes);
    const problems = indexProblems(index, files);
    if (problems.length > 0) {
      throw new Error(`取得したバンドルが索引と食い違う:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    }
    return { files: sortFiles(files), index, fallback: false, notes };
  }
  if (indexResponse.status !== 404) {
    throw new Error(`${INDEX_FILE}: HTTP ${indexResponse.status}`);
  }

  notes.push(
    `${INDEX_FILE} はまだ配信されていない（404）。手元のファイル一覧を取りに行った。` +
      "上流にファイルが増えてもこのモードでは検知できない",
  );
  const paths = new Set<string>([...localPaths].filter((path) => path !== INDEX_FILE));
  for (const required of REQUIRED_FILES) paths.add(required);
  const missing: string[] = [];
  for (const path of [...paths].sort(compareBytes)) {
    const response = await get(fetchImpl, base, path);
    if (response.status === 404) {
      missing.push(path);
      continue;
    }
    if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
    files.set(path, new Uint8Array(await response.arrayBuffer()));
  }
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) throw new Error(`${required}: 公開 URL に無い（HTTP 404）。取得先が正しいか確かめる`);
  }
  if (missing.length > 0) {
    notes.push(`公開 URL から消えていたので取り込みからも外す: ${missing.join(", ")}`);
  }
  return { files: sortFiles(files), fallback: true, notes };
}

function sortFiles(files: BundleFiles): BundleFiles {
  return new Map([...files].sort(([a], [b]) => compareBytes(a, b)));
}

export function diffBundles(local: BundleFiles, remote: BundleFiles): Diff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, bytes] of remote) {
    const current = local.get(path);
    if (current === undefined) added.push(path);
    else if (sha256Hex(current) !== sha256Hex(bytes)) changed.push(path);
  }
  for (const path of local.keys()) {
    if (!remote.has(path)) removed.push(path);
  }
  return { added, removed, changed };
}

export function isEmpty(diff: Diff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

export function describeDiff(diff: Diff): string {
  const lines: string[] = [];
  for (const path of diff.added) lines.push(`+ ${path}`);
  for (const path of diff.changed) lines.push(`~ ${path}`);
  for (const path of diff.removed) lines.push(`- ${path}`);
  return lines.join("\n");
}

/** ディスク上のコピーを作り直す。消えたファイルが残らないよう、一度空にする */
export async function writeBundle(files: BundleFiles, root: string = bundleRoot): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

/**
 * オフラインの整合検査。手元のコピーが契約テストの前提を満たしているか。
 * 索引があれば索引との一致も見る。ネットワークには出ない。
 */
export async function verifyLocalBundle(root: string = bundleRoot): Promise<string[]> {
  const files = await readLocalBundle(root);
  const problems: string[] = [];
  if (files.size === 0) {
    return [`${root} が空。bun run spec:sync で取り込む`];
  }
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) problems.push(`${required} が無い`);
  }
  for (const [path, bytes] of files) {
    if (path.endsWith(".json")) {
      try {
        JSON.parse(decode(bytes));
      } catch (error) {
        problems.push(`${path}: JSON として読めない（${(error as Error).message}）`);
      }
    }
  }
  const indexBytes = files.get(INDEX_FILE);
  if (indexBytes !== undefined) {
    try {
      problems.push(...indexProblems(parseIndex(decode(indexBytes)), files));
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}

async function main(argv: string[]): Promise<number> {
  const mode = argv.includes("--verify") ? "verify" : argv.includes("--check") ? "check" : "sync";

  if (mode === "verify") {
    const problems = await verifyLocalBundle();
    if (problems.length > 0) {
      console.error(problems.map((problem) => `- ${problem}`).join("\n"));
      return 1;
    }
    const files = await readLocalBundle();
    const indexBytes = files.get(INDEX_FILE);
    const revision = indexBytes ? parseIndex(decode(indexBytes)).revision : "（索引なし）";
    console.log(`公開契約のコピー OK — ${files.size} ファイル / revision ${revision}`);
    return 0;
  }

  const local = await readLocalBundle();
  const remote = await fetchRemoteBundle(fetch, local.keys());
  for (const note of remote.notes) console.log(`note: ${note}`);
  const diff = diffBundles(local, remote.files);

  if (isEmpty(diff)) {
    console.log(`公開契約のコピーは最新 — ${remote.files.size} ファイル`);
    return 0;
  }

  console.log(describeDiff(diff));
  if (mode === "check") {
    console.error(`公開契約が手元のコピーと違う（${diff.added.length} 追加 / ${diff.changed.length} 変更 / ${diff.removed.length} 削除）。bun run spec:sync で取り込む`);
    return 1;
  }

  await writeBundle(remote.files);
  const problems = await verifyLocalBundle();
  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    return 1;
  }
  console.log(`公開契約を取り込んだ — ${remote.files.size} ファイル → ${bundleRoot}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
