/**
 * この repository は丸ごと公開される。読めない場所への参照を公開物に入れない。
 *
 * MONICA 本体の設計サイトと決定ログは Cloudflare Access の内側にあり、公開 SDK
 * の読者には辿れない。決定は番号ではなく理由を書く。管理画面も同じ。
 */
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm)$/i;

async function trackedFiles(): Promise<string[]> {
  const git = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
  if (code !== 0) throw new Error(`git ls-files が失敗した: ${code}`);
  return out
    .split("\0")
    .filter((path) => path !== "" && !BINARY.test(path) && path !== "bun.lock")
    .sort();
}

describe("published surface", () => {
  test("読めない決定ログを番号で引いていない", async () => {
    const hits: string[] = [];
    for (const path of await trackedFiles()) {
      const found = (await Bun.file(resolve(root, path)).text()).match(/\bDEC\d+\b/);
      if (found) hits.push(`${path}: ${found[0]}`);
    }
    expect(hits).toEqual([]);
  });

  test("Access の内側にある設計サイト・管理画面へリンクしていない", async () => {
    const hits: string[] = [];
    for (const path of await trackedFiles()) {
      const contents = await Bun.file(resolve(root, path)).text();
      // このファイル自身が検出されないよう、hostname は組み立てる
      for (const host of ["doc", "admin"].map((sub) => `${sub}.monica.accelhack.net`)) {
        if (contents.includes(host)) hits.push(`${path}: ${host}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
