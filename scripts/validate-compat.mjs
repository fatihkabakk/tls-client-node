import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptFilePath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptFilePath), "..");

const {
    ClientIdentifier,
    CookieJar,
    Emulation,
    MultipartForm,
    TLSClient,
    TLSResponse,
    createMultipartForm,
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
assert.equal(Emulation.chrome_136, ClientIdentifier.chrome_136);

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

const multipartClient = new TLSClient();
let multipartPayload;
multipartClient.forward = async (payload) => {
    multipartPayload = payload;
    return createResponse(payload.requestUrl);
};

const multipartBody = createMultipartForm({
    alpha: "one",
    beta: {
        data: "hello world",
        filename: "hello.txt",
        contentType: "text/plain",
    },
});

await multipartClient.request("https://api.example.test/upload", {
    method: "POST",
    body: multipartBody,
});

assert.equal(multipartPayload.isByteRequest, true);
assert.match(multipartPayload.headers["content-type"], /^multipart\/form-data; boundary=/);

const multipartBodyText = Buffer.from(multipartPayload.requestBody, "base64").toString("utf8");
assert.match(multipartBodyText, /name="alpha"\r\n\r\none/);
assert.match(multipartBodyText, /name="beta"; filename="hello.txt"/);
assert.match(multipartBodyText, /Content-Type: text\/plain/);

const multipartBuilder = new MultipartForm()
    .append("title", "example")
    .appendFile("payload", new Uint8Array([65, 66, 67]), {
        filename: "letters.bin",
        contentType: "application/octet-stream",
    })
    .appendJson("meta", { ok: true });

let multipartBuilderPayload;
multipartClient.forward = async (payload) => {
    multipartBuilderPayload = payload;
    return createResponse(payload.requestUrl);
};

await multipartClient.request("https://api.example.test/upload-builder", {
    method: "POST",
    body: multipartBuilder,
});

const multipartBuilderBodyText = Buffer.from(multipartBuilderPayload.requestBody, "base64").toString("utf8");
assert.match(multipartBuilderBodyText, /name="title"\r\n\r\nexample/);
assert.match(multipartBuilderBodyText, /name="payload"; filename="letters.bin"/);
assert.match(multipartBuilderBodyText, /name="meta"; filename="meta.json"/);

const redirectClient = new TLSClient();
let redirectPayload;
redirectClient.forward = async (payload) => {
    redirectPayload = payload;
    return createResponse(payload.requestUrl);
};

const redirectSession = redirectClient.session({
    redirect: "follow",
});

await redirectSession.get("https://api.example.test/redirect-follow");
assert.equal(redirectPayload.followRedirects, true);

await redirectSession.get("https://api.example.test/redirect-manual", {
    redirect: "manual",
});
assert.equal(redirectPayload.followRedirects, false);

await redirectSession.get("https://api.example.test/redirect-boolean", {
    redirect: true,
    followRedirects: false,
});
assert.equal(redirectPayload.followRedirects, true);

const delayServer = spawn(process.execPath, [
    "-e",
    [
        "const http = require('node:http');",
        "let activeRequests = 0;",
        "let maxConcurrentRequests = 0;",
        "const server = http.createServer((req, res) => {",
        "  activeRequests += 1;",
        "  maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);",
        "  setTimeout(() => {",
        "    res.writeHead(200, {",
        "      'content-type': 'application/json',",
        "    });",
        "    res.end(JSON.stringify({ maxConcurrentRequests }));",
        "    activeRequests -= 1;",
        "  }, 600);",
        "});",
        "server.listen(0, '127.0.0.1', () => {",
        "  const address = server.address();",
        "  process.stdout.write(String(address.port));",
        "});",
    ].join(" "),
], {
    stdio: ["ignore", "pipe", "inherit"],
});

const [portOutput] = await once(delayServer.stdout, "data");
const delayServerPort = Number.parseInt(String(portOutput).trim(), 10);

assert.equal(Number.isInteger(delayServerPort), true);

const nativeClient = new TLSClient({
    runtimeMode: "native",
    requestTimeoutMs: 5_000,
});

const startedAt = Date.now();

try {
    const nativeResponses = await Promise.all([
        nativeClient.request(`http://127.0.0.1:${delayServerPort}/one`, {
            forceHttp1: true,
            insecureSkipVerify: true,
        }),
        nativeClient.request(`http://127.0.0.1:${delayServerPort}/two`, {
            forceHttp1: true,
            insecureSkipVerify: true,
        }),
        nativeClient.request(`http://127.0.0.1:${delayServerPort}/three`, {
            forceHttp1: true,
            insecureSkipVerify: true,
        }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    const maxConcurrentRequests = Math.max(
        ...(await Promise.all(nativeResponses.map((response) => response.json())))
            .map((payload) => Number(payload?.maxConcurrentRequests ?? 0)),
    );

    assert.deepEqual(nativeResponses.map((response) => response.status), [200, 200, 200]);
    assert.ok(
        maxConcurrentRequests > 1,
        `Expected concurrent native requests to overlap, but server observed max concurrency ${maxConcurrentRequests}.`,
    );
    assert.ok(
        elapsedMs < 2_500,
        `Expected concurrent native requests to finish well below serialized timing, but they took ${elapsedMs}ms.`,
    );
} finally {
    await nativeClient.stop();
    delayServer.kill();
}

const closingClient = new TLSClient();
const closingSession = closingClient.session();
let destroySessionCalls = 0;
let releaseClose;
const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
});

closingClient.destroySession = async (sessionId) => {
    destroySessionCalls += 1;
    assert.equal(sessionId, closingSession.id);
    await closeGate;
    return {
        id: sessionId,
        success: true,
    };
};

const closePromiseA = closingSession.close();
const closePromiseB = closingSession.close();

assert.equal(destroySessionCalls, 1);
releaseClose();
await Promise.all([closePromiseA, closePromiseB]);

await assert.rejects(
    () => closingSession.get("https://example.com/"),
    /Session is already closed/,
);

console.log(JSON.stringify({
    ok: true,
    aliasesChecked: [
        "ja3string",
        "timeout",
        "hostOverride",
        "randomTlsExtensionOrder",
        "upstream clientIdentifier constants",
        "emulation alias",
        "multipart form-data",
        "multipart helpers",
        "redirect alias",
        "native concurrency",
        "cookieJar expires forwarding",
        "concurrent session close",
    ],
}));