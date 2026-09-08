/**
 * 公開契約バンドル（vendoring したコピー）の置き場所と、索引の読み方。
 *
 * MONICA 本体が生成して https://spec.monica.accelhack.net/v1/ で配信している
 * バンドルを、この repository は `spec/v1/` にそのままコピーして持つ。CI は
 * そのコピーに対してオフラインで契約テストを回す。コピーの更新は
 * `tooling/spec-sync.ts` が公開 URL から取りに行く。
 *
 * パスの `v1` は Ingest API の版（`POST /v1/envelope`）で、バンドル自身の
 * 版ではない。v1 API が育つあいだ中身は変わってよいので、「どの契約で
 * 作ったか」は git の履歴（と、配信されていれば `index.json` の
 * `revision`）が記録する。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const ORIGIN = "https://spec.monica.accelhack.net";
export const VERSION = "v1";
export const BASE_URL = `${ORIGIN}/${VERSION}/`;

/** vendoring したコピー。`BASE_URL` 配下と同じ相対パスで置く */
export const bundleRoot = join(import.meta.dir, "..", "spec", VERSION);

/**
 * 索引。バンドル内の全ファイルのパスとダイジェスト、全体の指紋（`revision`）
 * を持つ。配信側がこれを出すようになれば、ファイルの列挙も整合性の検査も
 * ここから始める。まだ配信されていない場合（404）は無くてよい。
 */
export const INDEX_FILE = "index.json";

/**
 * 索引が無くても必ずあるはずのファイル。索引が配信される前の取り込みで
 * 「何を取りに行くか」の最低限と、契約テストが前提にするものの一致を見る。
 */
export const REQUIRED_FILES = [
  "README.md",
  "envelope.json",
  "limits.json",
  "ingest.md",
  "payload.md",
] as const;

export type IndexEntry = { path: string; sha256: string };

export type BundleIndex = {
  version: string;
  base: string;
  revision: string;
  files: IndexEntry[];
};

export type BundleFiles = Map<string, Uint8Array>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `revision` の定義（配信側の README より）: `files` を path の byte 順に並べ、
 * 各要素を「ダイジェスト、空白 2 つ、path」の 1 行にして改行で繋いだ文字列
 * （末尾に改行なし）の sha256。
 */
export function revisionOf(entries: IndexEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => compareBytes(a.path, b.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`);
  return sha256Hex(new TextEncoder().encode(lines.join("\n")));
}

/** path の byte 順（UTF-8）。`localeCompare` は locale で順序が変わるので使わない */
export function compareBytes(a: string, b: string): number {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return Buffer.compare(x, y);
}

export function parseIndex(text: string): BundleIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${INDEX_FILE} が JSON として読めない: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${INDEX_FILE} が object ではない`);
  }
  const index = parsed as Record<string, unknown>;
  if (typeof index.version !== "string" || typeof index.base !== "string") {
    throw new Error(`${INDEX_FILE} に version / base が無い`);
  }
  if (typeof index.revision !== "string" || !/^[0-9a-f]{64}$/.test(index.revision)) {
    throw new Error(`${INDEX_FILE} の revision が sha256 hex ではない`);
  }
  if (!Array.isArray(index.files) || index.files.length === 0) {
    throw new Error(`${INDEX_FILE} の files が空`);
  }
  const files: IndexEntry[] = index.files.map((entry, position) => {
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.path !== "string" ||
      typeof candidate.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.sha256)
    ) {
      throw new Error(`${INDEX_FILE} の files[${position}] の形が違う`);
    }
    if (!isSafeBundlePath(candidate.path)) {
      throw new Error(`${INDEX_FILE} の files[${position}].path が不正: ${candidate.path}`);
    }
    return { path: candidate.path, sha256: candidate.sha256 };
  });
  return { version: index.version, base: index.base, revision: index.revision, files };
}

/**
 * バンドル内の相対パスとして書き込んでよい形か。索引は外部から取ってくる
 * ものなので、`..` や絶対パスで `spec/` の外へ書かされないようにする。
 */
export function isSafeBundlePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 索引と実体の整合。索引に無いファイルが混ざっている、索引にあるのに無い、
 * ダイジェストが違う、`files` の並びが byte 順でない、`revision` が再計算と
 * 合わない、のどれかがあれば人が読める文で返す。
 */
export function indexProblems(index: BundleIndex, files: BundleFiles): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const entry of index.files) {
    listed.add(entry.path);
    const bytes = files.get(entry.path);
    if (bytes === undefined) {
      problems.push(`${entry.path}: 索引にあるが実体が無い`);
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      problems.push(`${entry.path}: ダイジェストが索引と違う（索引 ${entry.sha256} / 実体 ${actual}）`);
    }
  }
  for (const path of files.keys()) {
    if (path !== INDEX_FILE && !listed.has(path)) {
      problems.push(`${path}: 索引に無いファイル`);
    }
  }
  const sorted = [...index.files].sort((a, b) => compareBytes(a.path, b.path));
  if (sorted.some((entry, position) => entry.path !== index.files[position]?.path)) {
    problems.push(`${INDEX_FILE} の files が path の byte 順に並んでいない`);
  }
  const revision = revisionOf(index.files);
  if (revision !== index.revision) {
    problems.push(`${INDEX_FILE} の revision が再計算と合わない（索引 ${index.revision} / 再計算 ${revision}）`);
  }
  return problems;
}

/** ディスク上のコピー。キーは `BASE_URL` からの相対パス（常に `/` 区切り） */
export async function readLocalBundle(root: string = bundleRoot): Promise<BundleFiles> {
  const files: BundleFiles = new Map();
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(root, path).split(sep).join("/"), new Uint8Array(await readFile(path)));
    }
  }
  await walk(root);
  return new Map([...files].sort(([a], [b]) => compareBytes(a, b)));
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
