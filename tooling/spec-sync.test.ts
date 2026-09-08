import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { indexProblems, parseIndex, readLocalBundle, revisionOf, sha256Hex } from "./spec";
import {
  describeDiff,
  diffBundles,
  fetchRemoteBundle,
  isEmpty,
  verifyLocalBundle,
  writeBundle,
} from "./spec-sync";

const BASE = "https://spec.example.test/v1/";
const encoder = new TextEncoder();

type Served = Record<string, string>;

/** 公開 URL の代わり。`served` に無いパスは 404 */
function fakeFetch(served: Served, seen: string[] = []) {
  return async (input: string): Promise<Response> => {
    seen.push(input);
    if (!input.startsWith(BASE)) return new Response("wrong host", { status: 500 });
    const path = input.slice(BASE.length);
    const body = served[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

function bundleWithIndex(files: Served): Served {
  const entries = Object.keys(files)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((path) => ({ path, sha256: sha256Hex(encoder.encode(files[path])) }));
  const index = { version: "v1", base: BASE, revision: revisionOf(entries), files: entries };
  return { ...files, "index.json": `${JSON.stringify(index, null, 2)}\n` };
}

const REQUIRED: Served = {
  "README.md": "# contract\n",
  "envelope.json": '{"type":"object"}\n',
  "limits.json": '{"items_per_envelope":100}\n',
  "ingest.md": "# ingest\n",
  "payload.md": "# payload\n",
};

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "monica-spec-"));
  temporary.push(path);
  return path;
}

describe("fetchRemoteBundle", () => {
  test("索引があれば索引に従って全ファイルを取り、ダイジェストと revision を検証する", async () => {
    const served = bundleWithIndex({ ...REQUIRED, "vectors/envelope/a.json": '{"valid":true}\n' });
    const seen: string[] = [];
    const remote = await fetchRemoteBundle(fakeFetch(served, seen), [], BASE);

    expect(remote.fallback).toBe(false);
    expect(remote.index?.files.map((entry) => entry.path)).toEqual([
      "README.md",
      "envelope.json",
      "ingest.md",
      "limits.json",
      "payload.md",
      "vectors/envelope/a.json",
    ]);
    expect([...remote.files.keys()]).toContain("index.json");
    expect(remote.files.size).toBe(7);
    // 手元の一覧は使わず、索引だけで列挙している
    expect(seen[0]).toBe(`${BASE}index.json`);
    expect(remote.notes).toEqual([]);
  });

  test("索引のダイジェストと実体が違えば取り込まない", async () => {
    const served = bundleWithIndex(REQUIRED);
    served["envelope.json"] = '{"type":"tampered"}\n';
    await expect(fetchRemoteBundle(fakeFetch(served), [], BASE)).rejects.toThrow("ダイジェストが索引と違う");
  });

  test("索引の path が spec/ の外を指していれば拒否する", async () => {
    const entries = [{ path: "../outside.json", sha256: sha256Hex(encoder.encode("x")) }];
    const index = { version: "v1", base: BASE, revision: revisionOf(entries), files: entries };
    const served: Served = { "index.json": JSON.stringify(index), "../outside.json": "x" };
    await expect(fetchRemoteBundle(fakeFetch(served), [], BASE)).rejects.toThrow("path が不正");
  });

  test("索引が 404 なら手元の一覧と必須ファイルを取りに行き、その旨を残す", async () => {
    const served: Served = { ...REQUIRED, "vectors/envelope/a.json": "{}\n" };
    const remote = await fetchRemoteBundle(
      fakeFetch(served),
      ["vectors/envelope/a.json", "vectors/envelope/gone.json"],
      BASE,
    );

    expect(remote.fallback).toBe(true);
    expect(remote.index).toBeUndefined();
    expect([...remote.files.keys()]).toEqual([
      "README.md",
      "envelope.json",
      "ingest.md",
      "limits.json",
      "payload.md",
      "vectors/envelope/a.json",
    ]);
    expect(remote.notes.join("\n")).toContain("index.json はまだ配信されていない");
    expect(remote.notes.join("\n")).toContain("vectors/envelope/gone.json");
  });

  test("索引が無く必須ファイルも無ければ、取得先の間違いとして止める", async () => {
    await expect(fetchRemoteBundle(fakeFetch({ "README.md": "x" }), [], BASE)).rejects.toThrow(
      "公開 URL に無い",
    );
  });

  test("索引が 404 以外の失敗なら黙って fallback しない", async () => {
    const failing = async () => new Response("boom", { status: 503 });
    await expect(fetchRemoteBundle(failing, [], BASE)).rejects.toThrow("HTTP 503");
  });
});

describe("diffBundles / writeBundle / verifyLocalBundle", () => {
  test("追加・変更・削除を path で報告し、書き込みは消えたファイルを残さない", async () => {
    const root = await scratch();
    const before = new Map<string, Uint8Array>([
      ["README.md", encoder.encode("old")],
      ["stale.json", encoder.encode("{}")],
    ]);
    await writeBundle(before, root);

    const served = bundleWithIndex(REQUIRED);
    const remote = await fetchRemoteBundle(fakeFetch(served), before.keys(), BASE);
    const diff = diffBundles(await readLocalBundle(root), remote.files);

    expect(diff.changed).toEqual(["README.md"]);
    expect(diff.removed).toEqual(["stale.json"]);
    expect(diff.added).toContain("envelope.json");
    expect(isEmpty(diff)).toBe(false);
    expect(describeDiff(diff)).toContain("- stale.json");

    await writeBundle(remote.files, root);
    const after = await readLocalBundle(root);
    expect(after.has("stale.json")).toBe(false);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# contract\n");
    expect(await verifyLocalBundle(root)).toEqual([]);
    expect(isEmpty(diffBundles(after, remote.files))).toBe(true);
  });

  test("手元の索引と実体が食い違えば verify が落ちる", async () => {
    const root = await scratch();
    const served = bundleWithIndex(REQUIRED);
    const remote = await fetchRemoteBundle(fakeFetch(served), [], BASE);
    const files = new Map(remote.files);
    files.set("payload.md", encoder.encode("edited by hand\n"));
    files.set("extra.md", encoder.encode("not listed\n"));
    await writeBundle(files, root);

    const problems = await verifyLocalBundle(root);
    expect(problems.join("\n")).toContain("payload.md: ダイジェストが索引と違う");
    expect(problems.join("\n")).toContain("extra.md: 索引に無いファイル");
  });

  test("空のディレクトリは取り込み方を案内して落ちる", async () => {
    const root = await scratch();
    expect(await verifyLocalBundle(root)).toEqual([`${root} が空。bun run spec:sync で取り込む`]);
  });
});

describe("index", () => {
  test("revision は byte 順の「ダイジェスト  path」を改行で繋いだものの sha256", () => {
    const a = { path: "b.json", sha256: "1".repeat(64) };
    const b = { path: "a.json", sha256: "2".repeat(64) };
    const expected = sha256Hex(encoder.encode(`${b.sha256}  a.json\n${a.sha256}  b.json`));
    expect(revisionOf([a, b])).toBe(expected);
    expect(revisionOf([b, a])).toBe(expected);
  });

  test("files の並びが byte 順でなければ問題として報告する", () => {
    const files = new Map<string, Uint8Array>([
      ["a.json", encoder.encode("a")],
      ["b.json", encoder.encode("b")],
    ]);
    const entries = [
      { path: "b.json", sha256: sha256Hex(encoder.encode("b")) },
      { path: "a.json", sha256: sha256Hex(encoder.encode("a")) },
    ];
    const index = parseIndex(
      JSON.stringify({ version: "v1", base: BASE, revision: revisionOf(entries), files: entries }),
    );
    expect(indexProblems(index, files)).toEqual(["index.json の files が path の byte 順に並んでいない"]);
  });

  test("形が違う索引は読まない", () => {
    expect(() => parseIndex("[]")).toThrow("object ではない");
    expect(() => parseIndex(JSON.stringify({ version: "v1", base: BASE, revision: "x", files: [] }))).toThrow(
      "sha256 hex ではない",
    );
    expect(() =>
      parseIndex(JSON.stringify({ version: "v1", base: BASE, revision: "0".repeat(64), files: [] })),
    ).toThrow("files が空");
  });
});
