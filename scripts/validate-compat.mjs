import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptFilePath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptFilePath), "..");

const {
    ClientIdentifier,
    CookieJar,
    TLSClient,
    TLSResponse,
} = require(path.join(rootDir, "dist", "index.js"));

function createResponse(target = "https://api.example.test/resource") {
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
    hostOverride: "api.example.test",
    randomTlsExtensionOrder: true,
});

await aliasSession.get("https://api.example.test/v3/test", {
    headers: {
        accept: "application/json",
    },
});

assert.equal(aliasPayload.customTlsClient?.ja3String, "771,4865-4866-4867,0-11-10,29-23-24,0");
assert.equal(aliasPayload.timeoutSeconds, 0);
assert.equal(aliasPayload.timeoutMilliseconds, 15000);
assert.equal(aliasPayload.requestHostOverride, "api.example.test");
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

await identifierSession.get("https://api.example.test/v3/test");

assert.equal(identifierPayload.tlsClientIdentifier, "safari_ios_16_0");

const cookieJar = new CookieJar();
await cookieJar.setCookie(
    "foo=bar; Domain=.example.com; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Secure",
    "https://example.com/",
    { ignoreError: true },
);

const cookieJarClient = new TLSClient();
let cookieJarPayload;
cookieJarClient.forward = async (payload) => {
    cookieJarPayload = payload;
    return createResponse(payload.requestUrl);
};

const cookieJarSession = cookieJarClient.session({
    cookieJar,
    timeoutSeconds: 30,
});

await cookieJarSession.get("https://example.com/", {
    headers: {
        "user-agent": "Mozilla/5.0",
        accept: "*/*",
    },
});

assert.equal(cookieJarPayload.requestCookies.length, 1);
assert.equal(cookieJarPayload.requestCookies[0].name, "foo");
assert.equal(typeof cookieJarPayload.requestCookies[0].expires, "number");
assert.equal(cookieJarPayload.requestCookies[0].expires, 1918798080);

const runtimeCookieClient = new TLSClient();
runtimeCookieClient.getCookies = async () => ([{
    name: "runtime",
    value: "cookie",
    domain: "example.com",
    path: "/",
    expires: 1918798080,
    secure: true,
}]);

const runtimeCookieSession = runtimeCookieClient.session();
await runtimeCookieSession.cookies("https://example.com/");

const synchronizedCookies = await runtimeCookieSession.cookieJar.getCookies("https://example.com/");
assert.equal(synchronizedCookies.length, 1);
assert.equal(synchronizedCookies[0].key, "runtime");

console.log(JSON.stringify({
    ok: true,
    aliasesChecked: [
        "ja3string",
        "timeout",
        "hostOverride",
        "randomTlsExtensionOrder",
        "upstream clientIdentifier constants",
        "cookieJar expires forwarding",
    ],
}));