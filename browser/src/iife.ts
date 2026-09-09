import * as Monica from "./index.js";

(globalThis as typeof globalThis & { Monica: typeof Monica }).Monica = Monica;
