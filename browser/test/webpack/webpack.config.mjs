import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  target: ["web", "es2020"],
  entry: path.join(root, "entry.mjs"),
  output: {
    path: path.join(root, "dist"),
    filename: "bundle.js",
    library: { type: "module" },
  },
  experiments: { outputModule: true },
};
