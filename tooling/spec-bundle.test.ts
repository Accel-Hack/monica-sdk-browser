/**
 * vendoring した公開契約が、契約テストの前提として使える形か。
 *
 * ここで見るのはバンドルそのものの整合で、browser SDK の挙動は見ない
 * （それは browser/test/contract.test.ts）。envelope の test vectors を公開
 * JSON Schema で回すのは、配信側が生成時に確かめていることの再現で、
 * 「schema と vectors が同じ版のコピーか」を手元で保証するのが目的。
 */
import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { decode, readLocalBundle, REQUIRED_FILES } from "./spec";

type EnvelopeVector = {
  description: string;
  valid: boolean;
  schema_rejects?: boolean;
  envelope: unknown;
};

const files = await readLocalBundle();
const json = (path: string): unknown => JSON.parse(decode(required(path)));

function required(path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`spec/v1/${path} が無い。bun run spec:sync で取り込む`);
  return bytes;
}

describe("vendoring した公開契約", () => {
  test("契約テストが前提にするファイルがそろっている", () => {
    for (const path of REQUIRED_FILES) expect(files.has(path), path).toBe(true);
    expect([...files.keys()].filter((path) => path.startsWith("vectors/envelope/")).length).toBeGreaterThan(0);
  });

  test("envelope.json は draft 2020-12 の JSON Schema で、error item の形を持つ", () => {
    const schema = json("envelope.json") as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.required).toEqual(["sdk", "sent_at", "discarded", "items"]);
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs).toHaveProperty("errorItem");
    // browser SDK が出す値が enum に残っていること。消えたら契約が締まっている
    const errorItem = defs.errorItem as { properties: Record<string, { enum?: string[] }> };
    expect(errorItem.properties.platform?.enum).toContain("javascript");
    const mechanism = defs.mechanism as { properties: Record<string, { enum?: string[] }> };
    expect(mechanism.properties.type?.enum).toEqual(
      expect.arrayContaining(["onerror", "onunhandledrejection", "generic"]),
    );
  });

  test("index.json が手元の全ファイルを列挙している", () => {
    const index = json("index.json") as { files: Array<{ path: string }> };
    const listed = index.files.map((entry) => entry.path).sort();
    const actual = [...files.keys()].filter((path) => path !== "index.json").sort();
    expect(listed).toEqual(actual);
  });

  test("transport.json は browser SDK が分岐する status と定数を持つ", () => {
    const transport = json("transport.json") as {
      endpoint: { method: string; path: string; content_type: string; content_encoding: string };
      auth: Array<{ kind: string; key_prefix: string; header: string; value: string }>;
      status: Record<string, string>;
      retry: { retry_after: { max_seconds: number }; backoff: { base_ms: number; factor: number; max_ms: number } };
    };
    expect(transport.endpoint).toEqual({
      method: "POST",
      path: "/v1/envelope",
      content_type: "application/json",
      content_encoding: "gzip",
    });
    // browser が使う public key の行があること
    expect(transport.auth.find((entry) => entry.kind === "public")).toEqual({
      kind: "public",
      key_prefix: "mpk_",
      header: "X-Monica-Key",
      value: "<key>",
    });
    for (const status of ["202", "400", "401", "422", "429", "5xx"]) {
      expect(typeof transport.status[status], status).toBe("string");
    }
    expect(transport.retry.retry_after.max_seconds).toBeGreaterThan(0);
    expect(transport.retry.backoff.max_ms).toBeGreaterThanOrEqual(transport.retry.backoff.base_ms);
  });

  test("error.json は 422 の issues を持つ error body の JSON Schema", () => {
    const schema = json("error.json") as { $schema: string; required: string[]; $defs: Record<string, unknown> };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.required).toEqual(["error"]);
    expect(schema.$defs).toHaveProperty("validationIssue");
  });

  test("limits.json は正の整数の上限だけを持つ", () => {
    const limits = json("limits.json") as Record<string, unknown>;
    for (const key of [
      "envelope_gzip_bytes",
      "envelope_decompressed_bytes",
      "items_per_envelope",
      "frames_per_stacktrace",
    ]) {
      const value = limits[key];
      expect(Number.isSafeInteger(value) && (value as number) > 0, key).toBe(true);
    }
  });

  test("test vectors の判定が公開 JSON Schema と一致する", () => {
    // format は検査しない。schema は形の検査で、暦として正しいかまでは表せない。
    // その差は vector 側が schema_rejects: false で宣言している
    const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
    const validate = ajv.compile(json("envelope.json") as object);
    let checked = 0;
    for (const [path, bytes] of files) {
      if (!path.startsWith("vectors/envelope/") || !path.endsWith(".json")) continue;
      const vector = JSON.parse(decode(bytes)) as EnvelopeVector;
      const accepts = validate(vector.envelope) === true;
      const shouldAccept = vector.valid ? true : vector.schema_rejects === false;
      expect(accepts, `${path}: ${vector.description}`).toBe(shouldAccept);
      if (vector.valid) expect(vector.schema_rejects, `${path}: valid: true に schema_rejects は書かない`).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
