import { randomBytes, randomUUID } from "crypto";
import { access, chmod, copyFile, mkdir, open, readFile, rm, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import { CookieJar, type Cookie as ToughCookie } from "tough-cookie";
import { ensureBinary, supportsNativeRuntime, writeConfigFile } from "./binary";
import { TLSClientError } from "./errors";
import { ensureNativeBinding, NativeClientBinding } from "./native";
import { TLSResponse } from "./response";
import {
  ApiResponsePayload,
  ClientIdentifier,
  Cookie,
  CookiesOutput,
  CustomTlsClient,
  DestroyOutput,
  HeadersShape,
  HttpMethod,
  MultipartBodyLike,
  RequestBody,
  RequestOptions,
  RedirectBehavior,
  SerializedCookieJar,
  SessionOptions,
  TLSClientOptions,
} from "./types";

interface RuntimeState {
  mode: "remote" | "managed" | "native";
  baseUrl?: string;
  apiKey?: string;
  native?: NativeClientBinding;
  child?: ChildProcess;
  runtimeDir?: string;
  lockFilePath?: string;
  configFilePath?: string;
}

export interface FetchOptions extends RequestOptions {
  client?: TLSClient;
  session?: Session;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeMethod(method?: string): HttpMethod {
  return (method ?? "GET").toUpperCase() as HttpMethod;
}

function normalizeHeaders(headers?: HeadersShape): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    normalized[key.toLowerCase()] = String(value);
  }

  return normalized;
}

function mergeHeaders(
  base?: HeadersShape,
  override?: HeadersShape
): Record<string, string> {
  return {
    ...normalizeHeaders(base),
    ...normalizeHeaders(override),
  };
}

function normalizeCookieInput(
  cookies?: Cookie[] | Record<string, string>
): Cookie[] {
  if (!cookies) {
    return [];
  }

  if (Array.isArray(cookies)) {
    return cookies.map((cookie) => ({ ...cookie }));
  }

  return Object.entries(cookies).map(([name, value]) => ({ name, value }));
}

function formatCookieExpires(expires: string | number): string {
  const parsedDate = typeof expires === "number"
    ? new Date(expires * 1000)
    : new Date(expires);

  return Number.isNaN(parsedDate.getTime())
    ? String(expires)
    : parsedDate.toUTCString();
}

function normalizeCookieExpiresForRuntime(
  expires?: string | number
): number | undefined {
  if (expires === undefined) {
    return undefined;
  }

  if (typeof expires === "number") {
    return Number.isFinite(expires) ? Math.trunc(expires) : undefined;
  }

  const parsedDate = new Date(expires);
  const timestamp = parsedDate.getTime();

  return Number.isNaN(timestamp)
    ? undefined
    : Math.trunc(timestamp / 1000);
}

function normalizeCookiesForRuntime(
  cookies?: Cookie[] | Record<string, string>
): Cookie[] {
  return normalizeCookieInput(cookies).map((cookie) => ({
    ...cookie,
    expires: normalizeCookieExpiresForRuntime(cookie.expires),
  }));
}

function buildCookieJarString(cookie: Cookie): string {
  const parts = [`${cookie.name}=${cookie.value}`];

  if (cookie.domain) {
    parts.push(`Domain=${cookie.domain}`);
  }

  if (cookie.path) {
    parts.push(`Path=${cookie.path}`);
  }

  if (cookie.maxAge !== undefined) {
    parts.push(`Max-Age=${cookie.maxAge}`);
  }

  if (cookie.expires) {
    parts.push(`Expires=${formatCookieExpires(cookie.expires)}`);
  }

  if (cookie.secure) {
    parts.push("Secure");
  }

  if (cookie.httpOnly) {
    parts.push("HttpOnly");
  }

  return parts.join("; ");
}

async function syncCookiesToJar(
  cookieJar: CookieJar,
  cookies: Cookie[] | Record<string, string> | undefined | null,
  url: string
): Promise<void> {
  const normalizedCookies = normalizeCookieInput(cookies ?? undefined);

  await Promise.all(
    normalizedCookies.map(async (cookie) => {
      await cookieJar.setCookie(buildCookieJarString(cookie), url, {
        ignoreError: true,
      });
    })
  );
}

function normalizeJarCookie(cookie: ToughCookie): Cookie {
  return {
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain ?? undefined,
    path: cookie.path ?? undefined,
    expires: cookie.expires instanceof Date
      ? cookie.expires.toISOString()
      : cookie.expires === "Infinity"
        ? undefined
        : typeof cookie.expires === "string"
        ? cookie.expires
        : undefined,
    maxAge: typeof cookie.maxAge === "number" ? cookie.maxAge : undefined,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
}

async function getCookiesFromJar(cookieJar: CookieJar, url: string): Promise<Cookie[]> {
  const jarCookies = await cookieJar.getCookies(url);
  return jarCookies.map((cookie) => normalizeJarCookie(cookie));
}

function normalizeCertificatePinningHosts(
  value?: Record<string, string | string[]>
): Record<string, string[]> {
  if (!value) {
    return {};
  }

  const normalized: Record<string, string[]> = {};

  for (const [key, hostPins] of Object.entries(value)) {
    normalized[key] = Array.isArray(hostPins) ? hostPins : [hostPins];
  }

  return normalized;
}

const CUSTOM_TLS_REJECTION_PATTERNS = [
  /tls:\s*illegal parameter/i,
  /unknown\s+clienthelloid:\s*custom-1/i,
];

const MANAGED_RUNTIME_START_RETRIES = 3;
const MANAGED_RUNTIME_PORT_CONFLICT_PATTERNS = [
  /address already in use/i,
  /only one usage of each socket address/i,
];

const RETRIABLE_TRANSPORT_PATTERNS = [
  /\beof\b/i,
  /context deadline exceeded/i,
  /client\.timeout exceeded while awaiting headers/i,
  /connection reset/i,
  /reset by peer/i,
  /peer disconnect/i,
  /socket hang up/i,
  /broken pipe/i,
  /tls handshake/i,
  /http\/?2.*goaway/i,
  /http\/?2.*stream/i,
];

const RUNTIME_SLOT_COUNT = 8;

function isManagedRuntimePortConflict(output: string): boolean {
  return MANAGED_RUNTIME_PORT_CONFLICT_PATTERNS.some((pattern) => pattern.test(output));
}

function cloneStringArray(value?: string[]): string[] | undefined {
  return value ? [...value] : undefined;
}

function normalizeCustomTlsClient(
  value?: CustomTlsClient
): CustomTlsClient | undefined {
  if (!value) {
    return undefined;
  }

  const {
    certCompressionAlgo,
    certCompressionAlgos,
    h2Settings,
    h2SettingsOrder,
    h3Settings,
    h3SettingsOrder,
    h3PseudoHeaderOrder,
    headerPriority,
    supportedSignatureAlgorithms,
    supportedDelegatedCredentialsAlgorithms,
    supportedVersions,
    keyShareCurves,
    alpnProtocols,
    alpsProtocols,
    pseudoHeaderOrder,
    priorityFrames,
    ECHCandidatePayloads,
    ECHCandidateCipherSuites,
    ...rest
  } = value;

  const normalizedCertCompressionAlgos = certCompressionAlgos
    ? [...certCompressionAlgos]
    : certCompressionAlgo === undefined
      ? undefined
      : Array.isArray(certCompressionAlgo)
        ? [...certCompressionAlgo]
        : [certCompressionAlgo];

  return {
    ...rest,
    h2Settings: h2Settings ? { ...h2Settings } : undefined,
    h2SettingsOrder: cloneStringArray(h2SettingsOrder),
    h3Settings: h3Settings ? { ...h3Settings } : undefined,
    h3SettingsOrder: cloneStringArray(h3SettingsOrder),
    h3PseudoHeaderOrder: cloneStringArray(h3PseudoHeaderOrder),
    headerPriority: headerPriority ? { ...headerPriority } : headerPriority,
    certCompressionAlgos: normalizedCertCompressionAlgos,
    supportedSignatureAlgorithms: cloneStringArray(supportedSignatureAlgorithms),
    supportedDelegatedCredentialsAlgorithms: cloneStringArray(
      supportedDelegatedCredentialsAlgorithms
    ),
    supportedVersions: cloneStringArray(supportedVersions),
    keyShareCurves: cloneStringArray(keyShareCurves),
    alpnProtocols: cloneStringArray(alpnProtocols),
    alpsProtocols: cloneStringArray(alpsProtocols),
    pseudoHeaderOrder: cloneStringArray(pseudoHeaderOrder),
    priorityFrames: priorityFrames?.map((frame) => ({
      ...frame,
      priorityParam: { ...frame.priorityParam },
    })),
    ECHCandidatePayloads: ECHCandidatePayloads
      ? [...ECHCandidatePayloads]
      : undefined,
    ECHCandidateCipherSuites: ECHCandidateCipherSuites?.map((cipherSuite) => ({
      ...cipherSuite,
    })),
  };
}

function normalizeJa3String(value?: string): CustomTlsClient | undefined {
  const ja3String = String(value ?? "").trim();
  if (!ja3String) {
    return undefined;
  }

  return normalizeCustomTlsClient({ ja3String });
}

function normalizeHostOverride(value?: string | null): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeRedirectBehavior(
  value?: RedirectBehavior
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return value === "follow";
}

function isMultipartBodyLike(body: RequestBody): body is MultipartBodyLike {
  return typeof body === "object" && body !== null && "toFormData" in body;
}

function isFormDataBody(body: RequestBody): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

async function encodeBody(
  body: RequestBody,
  headers: Record<string, string>,
  forceBinary?: boolean
): Promise<{ requestBody?: string; isByteRequest: boolean }> {
  const normalizedBody = isMultipartBodyLike(body) ? body.toFormData() : body;

  if (normalizedBody === undefined || normalizedBody === null) {
    return {
      requestBody: undefined,
      isByteRequest: Boolean(forceBinary),
    };
  }

  if (typeof normalizedBody === "string") {
    return {
      requestBody: normalizedBody,
      isByteRequest: Boolean(forceBinary),
    };
  }

  if (normalizedBody instanceof URLSearchParams) {
    if (!headers["content-type"]) {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }

    return {
      requestBody: normalizedBody.toString(),
      isByteRequest: false,
    };
  }

  if (isFormDataBody(normalizedBody)) {
    const request = new Request("http://127.0.0.1/", {
      method: "POST",
      body: normalizedBody,
    });
    const contentType = request.headers.get("content-type");
    const arrayBuffer = await request.arrayBuffer();

    if (contentType) {
      headers["content-type"] = contentType;
    }

    return {
      requestBody: Buffer.from(arrayBuffer).toString("base64"),
      isByteRequest: true,
    };
  }

  if (normalizedBody instanceof ArrayBuffer || ArrayBuffer.isView(normalizedBody)) {
    const buffer = normalizedBody instanceof ArrayBuffer
      ? Buffer.from(normalizedBody)
      : Buffer.from(normalizedBody.buffer, normalizedBody.byteOffset, normalizedBody.byteLength);

    if (!headers["content-type"]) {
      headers["content-type"] = "application/octet-stream";
    }

    return {
      requestBody: buffer.toString("base64"),
      isByteRequest: true,
    };
  }

  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  return {
    requestBody: JSON.stringify(normalizedBody),
    isByteRequest: false,
  };
}

function pickDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function matchesKnownFailure(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

function getProfileSelection(
  sessionDefaults: SessionOptions | undefined,
  requestOptions: RequestOptions
): {
  customTlsClient?: CustomTlsClient;
  tlsClientIdentifier?: ClientIdentifier;
} {
  const customTlsClient = normalizeCustomTlsClient(
    pickDefined(
      requestOptions.customTlsClient,
      normalizeJa3String(requestOptions.ja3string),
      sessionDefaults?.customTlsClient,
      normalizeJa3String(sessionDefaults?.ja3string)
    )
  );

  const explicitTlsClientIdentifier = pickDefined(
    requestOptions.tlsClientIdentifier,
    requestOptions.clientIdentifier,
    sessionDefaults?.tlsClientIdentifier,
    sessionDefaults?.clientIdentifier
  );

  if (customTlsClient && explicitTlsClientIdentifier !== undefined) {
    throw new TLSClientError(
      "customTlsClient cannot be combined with clientIdentifier/tlsClientIdentifier. Omit the stock identifier so the request stays custom-only.",
      {
        code: "ERR_CUSTOM_TLS_CONFLICT",
        details: {
          tlsClientIdentifier: explicitTlsClientIdentifier,
          customTlsClient,
        },
      }
    );
  }

  return {
    customTlsClient,
    tlsClientIdentifier: customTlsClient
      ? undefined
      : pickDefined(explicitTlsClientIdentifier, ClientIdentifier.chrome_136),
  };
}

async function buildForwardPayload(
  url: string,
  sessionDefaults: SessionOptions | undefined,
  requestOptions: RequestOptions,
  sessionId?: string
) {
  const headers = mergeHeaders(sessionDefaults?.headers, requestOptions.headers);
  const profileSelection = getProfileSelection(sessionDefaults, requestOptions);
  const timeoutMilliseconds = pickDefined(
    requestOptions.timeoutMilliseconds,
    requestOptions.timeout,
    sessionDefaults?.timeoutMilliseconds,
    sessionDefaults?.timeout
  );
  const timeoutSeconds = pickDefined(
    requestOptions.timeoutSeconds,
    sessionDefaults?.timeoutSeconds,
    timeoutMilliseconds !== undefined ? 0 : 30
  );
  const { requestBody, isByteRequest } = await encodeBody(
    requestOptions.body,
    headers,
    requestOptions.isByteRequest
  );

  return {
    requestUrl: url,
    requestMethod: normalizeMethod(requestOptions.method),
    requestBody,
    requestCookies: normalizeCookiesForRuntime(requestOptions.cookies),
    tlsClientIdentifier: profileSelection.tlsClientIdentifier,
    customTlsClient: profileSelection.customTlsClient,
    followRedirects: pickDefined(
      normalizeRedirectBehavior(requestOptions.redirect),
      requestOptions.followRedirects,
      normalizeRedirectBehavior(sessionDefaults?.redirect),
      sessionDefaults?.followRedirects,
      false
    ),
    insecureSkipVerify: pickDefined(
      requestOptions.insecureSkipVerify,
      sessionDefaults?.insecureSkipVerify,
      false
    ),
    withoutCookieJar: pickDefined(
      requestOptions.withoutCookieJar,
      sessionDefaults?.withoutCookieJar,
      false
    ),
    withCustomCookieJar: pickDefined(
      requestOptions.withCustomCookieJar,
      sessionDefaults?.withCustomCookieJar,
      false
    ),
    withRandomTLSExtensionOrder: pickDefined(
      requestOptions.withRandomTLSExtensionOrder,
      requestOptions.randomTlsExtensionOrder,
      sessionDefaults?.withRandomTLSExtensionOrder,
      sessionDefaults?.randomTlsExtensionOrder,
      false
    ),
    timeoutSeconds,
    timeoutMilliseconds: timeoutMilliseconds ?? 0,
    sessionId,
    proxyUrl: pickDefined(
      requestOptions.proxyUrl,
      requestOptions.proxy,
      sessionDefaults?.proxyUrl,
      sessionDefaults?.proxy,
      ""
    ),
    isRotatingProxy: pickDefined(
      requestOptions.isRotatingProxy,
      sessionDefaults?.isRotatingProxy,
      false
    ),
    forceHttp1: pickDefined(
      requestOptions.forceHttp1,
      sessionDefaults?.forceHttp1,
      false
    ),
    disableHttp3: pickDefined(
      requestOptions.disableHttp3,
      sessionDefaults?.disableHttp3,
      false
    ),
    withProtocolRacing: pickDefined(
      requestOptions.withProtocolRacing,
      sessionDefaults?.withProtocolRacing,
      false
    ),
    withDebug: pickDefined(
      requestOptions.withDebug,
      requestOptions.debug,
      sessionDefaults?.withDebug,
      sessionDefaults?.debug,
      false
    ),
    catchPanics: pickDefined(
      requestOptions.catchPanics,
      sessionDefaults?.catchPanics,
      false
    ),
    isByteRequest,
    isByteResponse: pickDefined(
      requestOptions.isByteResponse,
      requestOptions.byteResponse,
      false
    ),
    disableIPV6: pickDefined(
      requestOptions.disableIPV6,
      sessionDefaults?.disableIPV6,
      false
    ),
    disableIPV4: pickDefined(
      requestOptions.disableIPV4,
      sessionDefaults?.disableIPV4,
      false
    ),
    certificatePinningHosts: normalizeCertificatePinningHosts(
      pickDefined(
        requestOptions.certificatePinningHosts,
        sessionDefaults?.certificatePinningHosts
      )
    ),
    transportOptions: pickDefined(
      requestOptions.transportOptions,
      sessionDefaults?.transportOptions
    ),
    headers,
    defaultHeaders: pickDefined(
      requestOptions.defaultHeaders,
      sessionDefaults?.defaultHeaders
    ),
    connectHeaders: pickDefined(
      requestOptions.connectHeaders,
      sessionDefaults?.connectHeaders
    ),
    headerOrder: pickDefined(
      requestOptions.headerOrder,
      sessionDefaults?.headerOrder,
      Object.keys(headers)
    ),
    localAddress: pickDefined(
      requestOptions.localAddress,
      sessionDefaults?.localAddress
    ),
    serverNameOverwrite: pickDefined(
      requestOptions.serverNameOverwrite,
      sessionDefaults?.serverNameOverwrite
    ),
    requestHostOverride: pickDefined(
      requestOptions.requestHostOverride,
      normalizeHostOverride(requestOptions.hostOverride),
      sessionDefaults?.requestHostOverride
      , normalizeHostOverride(sessionDefaults?.hostOverride)
    ),
    streamOutputPath: pickDefined(
      requestOptions.streamOutputPath,
      sessionDefaults?.streamOutputPath
    ),
    streamOutputBlockSize: pickDefined(
      requestOptions.streamOutputBlockSize,
      sessionDefaults?.streamOutputBlockSize
    ),
    streamOutputEOFSymbol: pickDefined(
      requestOptions.streamOutputEOFSymbol,
      sessionDefaults?.streamOutputEOFSymbol
    ),
  };
}

type ForwardPayload = Awaited<ReturnType<typeof buildForwardPayload>>;

function classifyForwardError(
  value: unknown,
  payload: ForwardPayload
): TLSClientError {
  const error = TLSClientError.fromUnknown(value);
  const target = describeTarget(payload.requestUrl);

  if (
    payload.customTlsClient &&
    matchesKnownFailure(error.message, CUSTOM_TLS_REJECTION_PATTERNS)
  ) {
    return new TLSClientError(
      `Custom TLS profile was rejected for ${target}: ${error.message}. This client does not fall back to any stock client identifier. Verify the customTlsClient payload, especially certCompressionAlgos and the HTTP/2 ordering fields.`,
      {
        code: "ERR_CUSTOM_TLS_REJECTED",
        cause: error,
        status: error.status,
        details: {
          target,
          sessionId: payload.sessionId,
          customTlsClient: payload.customTlsClient,
        },
      }
    );
  }

  if (matchesKnownFailure(error.message, RETRIABLE_TRANSPORT_PATTERNS)) {
    return new TLSClientError(
      `Retriable transport error while requesting ${target}: ${error.message}`,
      {
        code: "ERR_RETRIABLE_TRANSPORT",
        cause: error,
        status: error.status,
        retriable: true,
        details: {
          target,
          sessionId: payload.sessionId,
          customTlsClient: Boolean(payload.customTlsClient),
        },
      }
    );
  }

  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendBoundedLog(current: string, chunk: Buffer | string, maxLength = 16_384): string {
  const next = current + chunk.toString();
  return next.length <= maxLength ? next : next.slice(-maxLength);
}

function shouldUseNativeRuntime(options: TLSClientOptions): boolean {
  if (options.runtimeMode === "native") {
    return true;
  }

  if (options.runtimeMode === "managed") {
    return false;
  }

  if (options.nativeLibraryPath) {
    return true;
  }

  if (options.binaryPath) {
    return false;
  }

  return supportsNativeRuntime();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getRuntimeRootDirectory(options: TLSClientOptions): string {
  if (options.runtimeDir) {
    return options.runtimeDir;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
      ?? path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "tls-client-node", "runtime");
  }

  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "tls-client-node", "runtime");
  }

  return path.join(
    process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
    "tls-client-node",
    "runtime"
  );
}

async function releaseRuntimeLock(lockFilePath?: string): Promise<void> {
  if (!lockFilePath) {
    return;
  }

  await rm(lockFilePath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function claimRuntimeLock(lockFilePath: string): Promise<boolean> {
  try {
    const handle = await open(lockFilePath, "wx");
    await handle.writeFile(String(process.pid), "utf8");
    await handle.close();
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const existingPid = Number.parseInt(
      (await readFile(lockFilePath, "utf8")).trim(),
      10
    );

    if (isProcessAlive(existingPid)) {
      return false;
    }
  } catch {
    // Treat unreadable lock files as stale and replace them.
  }

  await rm(lockFilePath, { force: true });

  try {
    const handle = await open(lockFilePath, "wx");
    await handle.writeFile(String(process.pid), "utf8");
    await handle.close();
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

async function prepareRuntimeSlot(
  options: TLSClientOptions,
  executablePath: string,
  version: string
): Promise<{
  runtimeDir: string;
  runtimeExecutablePath: string;
  lockFilePath: string;
}> {
  if (process.platform === "win32" && !options.runtimeDir) {
    const runtimeDir = path.dirname(executablePath);
    const lockFilePath = path.join(runtimeDir, `.${path.basename(executablePath)}.lock`);

    if (!(await claimRuntimeLock(lockFilePath))) {
      throw new TLSClientError(
        "The managed tls-client-api Windows runtime is already in use.",
        { code: "ERR_RUNTIME_SLOT_UNAVAILABLE" }
      );
    }

    return {
      runtimeDir,
      runtimeExecutablePath: executablePath,
      lockFilePath,
    };
  }

  const runtimeRoot = getRuntimeRootDirectory(options);
  const versionRoot = path.join(runtimeRoot, version);
  const executableName = path.basename(executablePath);

  await mkdir(versionRoot, { recursive: true });

  for (let slotIndex = 0; slotIndex < RUNTIME_SLOT_COUNT; slotIndex += 1) {
    const runtimeDir = path.join(versionRoot, `slot-${slotIndex}`);
    const lockFilePath = path.join(runtimeDir, ".lock");

    await mkdir(runtimeDir, { recursive: true });

    if (!(await claimRuntimeLock(lockFilePath))) {
      continue;
    }

    const runtimeExecutablePath = path.join(runtimeDir, executableName);

    try {
      if (!(await pathExists(runtimeExecutablePath))) {
        await copyFile(executablePath, runtimeExecutablePath);

        if (process.platform !== "win32") {
          await chmod(runtimeExecutablePath, 0o755);
        }
      }
    } catch (error) {
      await releaseRuntimeLock(lockFilePath);
      throw error;
    }

    return {
      runtimeDir,
      runtimeExecutablePath,
      lockFilePath,
    };
  }

  throw new TLSClientError(
    `Unable to allocate a tls-client runtime slot after checking ${RUNTIME_SLOT_COUNT} slots.`,
    { code: "ERR_RUNTIME_SLOT_UNAVAILABLE" }
  );
}

async function stopChildProcess(child?: ChildProcess): Promise<void> {
  if (!child) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill();

  await Promise.race([exitPromise, delay(5_000)]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exitPromise, delay(5_000)]);
  }
}

async function findAvailablePort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    try {
      return await claimPort(preferred);
    } catch {
      return claimPort(0);
    }
  }

  return claimPort(0);
}

function claimPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve port.")));
        return;
      }

      const resolvedPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(resolvedPort);
      });
    });
  });
}

export class TLSClient {
  private readonly options: Required<
    Pick<TLSClientOptions, "requestTimeoutMs" | "startupTimeoutMs">
  > & TLSClientOptions;
  private startPromise?: Promise<void>;
  private runtime?: RuntimeState;

  constructor(options: TLSClientOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 20_000,
      ...options,
    };
  }

  public async start(): Promise<void> {
    if (this.runtime) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }

    await this.startPromise;
  }

  public async stop(): Promise<void> {
    if (!this.runtime) {
      return;
    }

    if (this.runtime.mode === "native") {
      this.runtime.native?.destroyAll<DestroyOutput>();
      this.runtime = undefined;
      return;
    }

    await stopChildProcess(this.runtime.child);
    if (this.runtime.configFilePath) {
      await unlink(this.runtime.configFilePath).catch(() => undefined);
    }
    await releaseRuntimeLock(this.runtime.lockFilePath);

    this.runtime = undefined;
  }

  public session(options: SessionOptions = {}): Session {
    return new Session(this, options);
  }

  public async request(
    url: string,
    options: RequestOptions = {}
  ): Promise<TLSResponse> {
    const payload = await buildForwardPayload(
      url,
      undefined,
      options,
      options.sessionId
    );
    return this.forward(payload);
  }

  public async getCookies(sessionId: string, url: string): Promise<Cookie[]> {
    await this.start();
    const runtime = this.getRuntime();

    if (runtime.mode === "native") {
      return runtime.native!.getCookiesFromSession<CookiesOutput>({
        sessionId,
        url,
      }).cookies;
    }

    const response = await this.requestJson<CookiesOutput>("/api/cookies", {
      sessionId,
      url,
    });

    return response.cookies;
  }

  public async destroySession(sessionId: string): Promise<DestroyOutput> {
    await this.start();
    const runtime = this.getRuntime();

    if (runtime.mode === "native") {
      return runtime.native!.destroySession<DestroyOutput>({ sessionId });
    }

    return this.requestJson<DestroyOutput>("/api/free-session", { sessionId });
  }

  public async destroyAll(): Promise<DestroyOutput> {
    await this.start();
    const runtime = this.getRuntime();

    if (runtime.mode === "native") {
      return runtime.native!.destroyAll<DestroyOutput>();
    }

    const apiKey = runtime.apiKey ?? "";

    const response = await globalThis.fetch(`${runtime.baseUrl}/api/free-all`, {
      method: "GET",
      headers: {
        "X-API-KEY": apiKey,
      },
    });

    if (!response.ok) {
      throw new TLSClientError(
        `tls-client-api free-all failed with ${response.status} ${response.statusText}`,
        { code: "ERR_API_REQUEST", status: response.status }
      );
    }

    return (await response.json()) as DestroyOutput;
  }

  private async startInternal(): Promise<void> {
    if (this.options.baseUrl) {
      this.runtime = {
        mode: "remote",
        baseUrl: stripTrailingSlash(this.options.baseUrl),
        apiKey: this.options.apiKey ?? "",
      };
      return;
    }

    if (shouldUseNativeRuntime(this.options)) {
      this.runtime = {
        mode: "native",
        native: await ensureNativeBinding(this.options),
      };
      return;
    }

    const binary = await ensureBinary(this.options);
    const apiKey = this.options.apiKey ?? randomBytes(16).toString("hex");
    let lastStartupError: TLSClientError | undefined;

    for (let attempt = 0; attempt < MANAGED_RUNTIME_START_RETRIES; attempt += 1) {
      const port = await findAvailablePort(this.options.port);
      const healthPort = await findAvailablePort(this.options.healthPort);
      const { runtimeDir, runtimeExecutablePath, lockFilePath } = await prepareRuntimeSlot(
        this.options,
        binary.executablePath,
        binary.version
      );
      const configFilePath = await writeConfigFile(runtimeDir, port, healthPort, apiKey);

      const child = spawn(runtimeExecutablePath, [], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: runtimeDir,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      const onStdoutData = (chunk: Buffer | string) => {
        stdout = appendBoundedLog(stdout, chunk);
      };
      const onStderrData = (chunk: Buffer | string) => {
        stderr = appendBoundedLog(stderr, chunk);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exitCode = code;
        exitSignal = signal;
      };

      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("exit", onExit);

      const detachStartupListeners = () => {
        child.stdout.off("data", onStdoutData);
        child.stderr.off("data", onStderrData);
        child.off("exit", onExit);
      };

      const runtime: RuntimeState = {
        mode: "managed",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
        child,
        runtimeDir,
        lockFilePath,
        configFilePath,
      };

      this.runtime = runtime;

      try {
        await this.waitUntilReady();
        detachStartupListeners();
        return;
      } catch (error) {
        detachStartupListeners();
        await stopChildProcess(child);
        await unlink(configFilePath).catch(() => undefined);
        await releaseRuntimeLock(lockFilePath);
        this.runtime = undefined;

        const startupOutput = [stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n");
        const startupError = new TLSClientError(
          startupOutput
            ? `tls-client-api failed to start: ${startupOutput}`
            : exitCode !== null || exitSignal !== null
              ? `tls-client-api failed to start (exit code: ${exitCode ?? "null"}, signal: ${exitSignal ?? "null"}).`
              : "tls-client-api failed to start.",
          { code: "ERR_STARTUP", cause: error }
        );

        lastStartupError = startupError;

        if (
          attempt + 1 < MANAGED_RUNTIME_START_RETRIES
          && isManagedRuntimePortConflict(startupOutput)
        ) {
          continue;
        }

        throw startupError;
      }
    }

    throw lastStartupError ?? new TLSClientError("tls-client-api failed to start.", {
      code: "ERR_STARTUP",
    });
  }

  private async waitUntilReady(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.options.startupTimeoutMs) {
      try {
        await this.requestJson<DestroyOutput>("/api/free-session", {
          sessionId: "tls-client-healthcheck",
        });
        return;
      } catch {
        await delay(200);
      }
    }

    throw new TLSClientError("Timed out waiting for tls-client-api to become ready.", {
      code: "ERR_STARTUP_TIMEOUT",
    });
  }

  private getRuntime(): RuntimeState {
    if (!this.runtime) {
      throw new TLSClientError("TLS client is not started.", {
        code: "ERR_NOT_STARTED",
      });
    }

    return this.runtime;
  }

  public async forward(payload: ForwardPayload): Promise<TLSResponse> {
    await this.start();
    const runtime = this.getRuntime();

    let response: ApiResponsePayload;

    try {
      response = runtime.mode === "native"
        ? runtime.native!.request<ApiResponsePayload>(payload)
        : await this.requestJson<ApiResponsePayload>("/api/forward", payload);
    } catch (error) {
      throw classifyForwardError(error, payload);
    }

    if (response.status === 0) {
      throw classifyForwardError(
        new TLSClientError(response.body || "tls-client-api request failed.", {
          code: "ERR_FORWARD_REQUEST",
          details: response,
        }),
        payload
      );
    }

    return new TLSResponse(response);
  }

  private async requestJson<T>(
    pathName: string,
    body: unknown,
    method = "POST",
    endpointOverride?: string
  ): Promise<T> {
    await this.start();
    const runtime = this.getRuntime();
    if (runtime.mode === "native") {
      throw new TLSClientError(
        `The ${pathName} endpoint is not available in native-library mode.`,
        { code: "ERR_UNSUPPORTED_RUNTIME_OPERATION" }
      );
    }

    const apiKey = runtime.apiKey ?? "";
    const endpoint = endpointOverride ?? pathName;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    try {
      const response = await globalThis.fetch(`${runtime.baseUrl}${endpoint}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: method === "GET" ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new TLSClientError(
          `tls-client-api request failed with ${response.status} ${response.statusText}: ${text}`,
          { code: "ERR_API_REQUEST", status: response.status }
        );
      }

      const text = await response.text();
      if (!text) {
        throw new TLSClientError("tls-client-api returned an empty response.", {
          code: "ERR_EMPTY_RESPONSE",
        });
      }

      return JSON.parse(text) as T;
    } catch (error) {
      throw TLSClientError.fromUnknown(error, { code: "ERR_API_REQUEST" });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class Session {
  public readonly id: string;
  public readonly cookieJar: CookieJar;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly client: TLSClient,
    private readonly defaults: SessionOptions = {}
  ) {
    this.id = defaults.sessionId ?? randomUUID();
    this.cookieJar = defaults.cookieJar ?? new CookieJar();
  }

  public async request(
    url: string,
    options: RequestOptions = {}
  ): Promise<TLSResponse> {
    this.assertOpen();
    const useLocalCookieJar = !pickDefined(
      options.withoutCookieJar,
      this.defaults.withoutCookieJar,
      false
    );

    if (useLocalCookieJar) {
      await syncCookiesToJar(this.cookieJar, options.cookies, url);
    }

    const requestCookies = useLocalCookieJar
      ? await getCookiesFromJar(this.cookieJar, url)
      : normalizeCookieInput(options.cookies);

    const payload = await buildForwardPayload(
      url,
      this.defaults,
      {
        ...options,
        cookies: requestCookies,
      },
      this.id
    );
    const response = await this.client.forward(payload);

    if (useLocalCookieJar) {
      await syncCookiesToJar(this.cookieJar, response.cookies, url);
    }

    return response;
  }

  public get(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "GET" });
  }

  public post(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "POST" });
  }

  public put(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "PUT" });
  }

  public patch(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "PATCH" });
  }

  public delete(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "DELETE" });
  }

  public head(url: string, options: RequestOptions = {}): Promise<TLSResponse> {
    return this.request(url, { ...options, method: "HEAD" });
  }

  public options(
    url: string,
    requestOptions: RequestOptions = {}
  ): Promise<TLSResponse> {
    return this.request(url, { ...requestOptions, method: "OPTIONS" });
  }

  public async cookies(url: string): Promise<Cookie[]> {
    this.assertOpen();
    const runtimeCookies = await this.client.getCookies(this.id, url);
    await syncCookiesToJar(this.cookieJar, runtimeCookies, url);
    return getCookiesFromJar(this.cookieJar, url);
  }

  public async exportCookies(): Promise<SerializedCookieJar> {
    return this.cookieJar.serialize();
  }

  public async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    if (this.closed) {
      return;
    }

    this.closed = true;
    this.closePromise = this.client.destroySession(this.id)
      .then(() => undefined)
      .catch((error) => {
        this.closed = false;
        this.closePromise = undefined;
        throw error;
      });

    await this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TLSClientError("Session is already closed.", {
        code: "ERR_SESSION_CLOSED",
      });
    }
  }
}

export async function fetch(
  url: string,
  options: FetchOptions = {}
): Promise<TLSResponse> {
  if (options.session) {
    const { session, client: _client, ...requestOptions } = options;
    return session.request(url, requestOptions);
  }

  const { client: _client, session: _session, ...requestOptions } = options;

  if (options.client) {
    return options.client.request(url, requestOptions);
  }

  const client = new TLSClient();

  try {
    return await client.request(url, requestOptions);
  } finally {
    await client.stop();
  }
}
