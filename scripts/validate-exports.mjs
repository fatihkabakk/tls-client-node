import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const require = createRequire(import.meta.url);
const scriptFilePath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptFilePath), "..");
const cjsModule = require(path.join(rootDir, "dist", "index.js"));
const esmModule = await import(pathToFileURL(path.join(rootDir, "index.mjs")).href);

const requiredExports = [
    "ClientIdentifier",
    "CookieJar",
    "TLSClient",
    "Session",
    "fetch",
    "TLSClientError",
    "TLSResponse",
];

for (const exportName of requiredExports) {
    if (!(exportName in cjsModule)) {
        throw new Error(`Missing CommonJS export: ${exportName}`);
    }

    if (!(exportName in esmModule)) {
        throw new Error(`Missing ESM export: ${exportName}`);
    }
}

if (typeof cjsModule.TLSClient !== "function" || typeof esmModule.TLSClient !== "function") {
    throw new Error("TLSClient export is not a constructor.");
}

console.log(JSON.stringify({ ok: true, exportsChecked: requiredExports.length }));