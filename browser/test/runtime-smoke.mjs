import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../dist/monica.min.js", import.meta.url), "utf8");
assert.ok(source.length > 0);
const context = vm.createContext({
  AbortController,
  Blob,
  CompressionStream,
  Date,
  Error,
  EventTarget,
  Map,
  Promise,
  Response,
  Set,
  TextEncoder,
  URL,
  WeakMap,
  clearTimeout,
  crypto,
  setTimeout,
});
new vm.Script(source).runInContext(context);
assert.equal(typeof context.Monica.init, "function");
assert.equal(typeof context.Monica.captureException, "function");
