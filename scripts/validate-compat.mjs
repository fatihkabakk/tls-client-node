import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptFilePath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptFilePath), "..");

const {
    ClientIdentifier,
    TLSClient,
    TLSResponse,
} = require(path.join(rootDir, "dist", "index.js"));

function createResponse(target = "https://api.pinterest.com/resource") {
    return new TLSResponse({
        id: "compat-smoke",
        status: 200,
        target,
        body: "{}",
        headers: {},
        cookies: {},
        sessionId: "compat-session",
        usedProtocol: "h2",
    });
}

const aliasClient = new TLSClient();
let aliasPayload;
aliasClient.forward = async (payload) => {
    aliasPayload = payload;
    return createResponse(payload.requestUrl);
};

const aliasSession = aliasClient.session({
    ja3string: "771,4865-4866-4867,0-11-10,29-23-24,0",
    timeout: 15000,
    hostOverride: "api.pinterest.com",
    randomTlsExtensionOrder: true,
});

await aliasSession.get("https://api.pinterest.com/v3/test", {
    headers: {
        accept: "application/json",
    },
});

assert.equal(aliasPayload.customTlsClient?.ja3String, "771,4865-4866-4867,0-11-10,29-23-24,0");
assert.equal(aliasPayload.timeoutSeconds, 0);
assert.equal(aliasPayload.timeoutMilliseconds, 15000);
assert.equal(aliasPayload.requestHostOverride, "api.pinterest.com");
assert.equal(aliasPayload.withRandomTLSExtensionOrder, true);

assert.equal(ClientIdentifier.chrome_130_PSK, "chrome_130_PSK");
assert.equal(ClientIdentifier.chrome_146, "chrome_146");
assert.equal(ClientIdentifier.chrome_146_PSK, "chrome_146_PSK");
assert.equal(ClientIdentifier.brave_146, "brave_146");
assert.equal(ClientIdentifier.brave_146_PSK, "brave_146_PSK");
assert.equal(ClientIdentifier.firefox_135, "firefox_135");
assert.equal(ClientIdentifier.firefox_146_PSK, "firefox_146_PSK");
assert.equal(ClientIdentifier.firefox_147_PSK, "firefox_147_PSK");
assert.equal(ClientIdentifier.firefox_148, "firefox_148");
assert.equal(ClientIdentifier.safari_ios_16_0, "safari_ios_16_0");
assert.equal(ClientIdentifier.safari_ios_15_6, "safari_ios_15_6");
assert.equal(ClientIdentifier.safari_ios_18_5, "safari_ios_18_5");
assert.equal(ClientIdentifier.safari_ios_26_0, "safari_ios_26_0");
assert.equal(ClientIdentifier.okhttp4_android_12, "okhttp4_android_12");

const identifierClient = new TLSClient();
let identifierPayload;
identifierClient.forward = async (payload) => {
    identifierPayload = payload;
    return createResponse(payload.requestUrl);
};

const identifierSession = identifierClient.session({
    clientIdentifier: ClientIdentifier.safari_ios_16_0,
});

await identifierSession.get("https://api.pinterest.com/v3/test");

assert.equal(identifierPayload.tlsClientIdentifier, "safari_ios_16_0");

console.log(JSON.stringify({
    ok: true,
    aliasesChecked: [
        "ja3string",
        "timeout",
        "hostOverride",
        "randomTlsExtensionOrder",
        "upstream clientIdentifier constants",
    ],
}));