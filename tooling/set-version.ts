/**
 * version の正本は root の package.json。ここから 4 か所へ配る。
 *
 *     bun run version:set 0.1.2
 *
 *   - browser/package.json  version
 *   - react/package.json    version と dependencies["@ah-monica/browser"]
 *   - browser/src/client.ts sdk.version（envelope の sdk.version に載る）
 *
 * react の browser 依存を workspace:* にしないのは、npm publish が
 * workspace:* を書き換えないため。人が 4 か所を手で揃えるのは無理なので、
 * 正本を 1 つにして機械で配り、tooling/versions.test.ts が揃っているかを見る。
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "..");

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** client.ts の中で sdk.version を書いている 1 行 */
export const CLIENT_VERSION = /(sdk: \{ name: "@ah-monica\/browser", version: ")([^"]+)(" \})/;

export async function rootVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version || !SEMVER.test(pkg.version)) {
    throw new Error("root package.json の version が semver ではない");
  }
  return pkg.version;
}

async function rewriteJson(path: string, mutate: (pkg: Record<string, unknown>) => void): Promise<void> {
  const pkg = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(pkg);
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** root の version を 4 か所へ書く */
export async function distribute(version: string): Promise<void> {
  await rewriteJson(resolve(root, "package.json"), (pkg) => {
    pkg.version = version;
  });
  await rewriteJson(resolve(root, "browser/package.json"), (pkg) => {
    pkg.version = version;
  });
  await rewriteJson(resolve(root, "react/package.json"), (pkg) => {
    pkg.version = version;
    (pkg.dependencies as Record<string, string>)["@ah-monica/browser"] = version;
  });
  const clientPath = resolve(root, "browser/src/client.ts");
  const client = await readFile(clientPath, "utf8");
  if (!CLIENT_VERSION.test(client)) {
    throw new Error("browser/src/client.ts に sdk.version の行が見つからない。CLIENT_VERSION を直す");
  }
  await writeFile(clientPath, client.replace(CLIENT_VERSION, `$1${version}$3`));
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version || !SEMVER.test(version)) {
    console.error("使い方: bun run version:set X.Y.Z");
    process.exit(1);
  }
  await distribute(version);
  console.log(`version ${version} を root / browser / react / client.ts に書いた。bun install で lockfile を更新する`);
}
