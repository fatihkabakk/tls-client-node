import { ensureNativeLibrary } from "./binary";
import { TLSClientError } from "./errors";
import { TLSClientOptions } from "./types";

interface RawNativeBinding {
  request: (payload: string) => string;
  getCookiesFromSession: (payload: string) => string;
  destroySession: (payload: string) => string;
  destroyAll: () => string;
  freeMemory: (id: string) => void;
}

export interface NativeClientBinding {
  libraryPath: string;
  request<T>(payload: unknown): Promise<T>;
  getCookiesFromSession<T>(payload: unknown): Promise<T>;
  destroySession<T>(payload: unknown): Promise<T>;
  destroyAll<T>(): Promise<T>;
}

type NativeAsyncCallback = (error: Error | null, result: string | undefined) => void;
type NativeAsyncFunction = {
  async: (...args: [...unknown[], NativeAsyncCallback]) => void;
};

const bindingCache = new Map<string, NativeClientBinding>();

function parseNativeResponse<T>(
  rawResponse: string | undefined,
  operation: string,
  binding: RawNativeBinding
): T {
  if (!rawResponse) {
    throw new TLSClientError(`tls-client native ${operation} returned no data.`, {
      code: "ERR_NATIVE_EMPTY_RESPONSE",
    });
  }

  let parsed: T & { id?: string };

  try {
    parsed = JSON.parse(rawResponse) as T & { id?: string };
  } catch (error) {
    throw new TLSClientError(
      `tls-client native ${operation} returned invalid JSON: ${rawResponse}`,
      {
        code: "ERR_NATIVE_INVALID_RESPONSE",
        cause: error,
      }
    );
  }

  if (parsed.id) {
    binding.freeMemory(parsed.id);
  }

  return parsed;
}

function invokeNativeAsync(
  operation: string,
  fn: NativeAsyncFunction,
  ...args: unknown[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (error, result) => {
      if (error) {
        reject(new TLSClientError(`tls-client native ${operation} failed: ${error.message}`, {
          code: "ERR_NATIVE_CALL_FAILED",
          cause: error,
        }));
        return;
      }

      if (result === undefined) {
        reject(new TLSClientError(`tls-client native ${operation} returned no data.`, {
          code: "ERR_NATIVE_EMPTY_RESPONSE",
        }));
        return;
      }

      resolve(result);
    });
  });
}

async function loadNativeBinding(libraryPath: string): Promise<NativeClientBinding> {
  const existing = bindingCache.get(libraryPath);
  if (existing) {
    return existing;
  }

  const koffiModule = (await import("koffi")) as {
    load?: (filePath: string) => {
      func: (name: string, result: string, params: string[]) => (...args: string[]) => string;
    };
    default?: {
      load?: (filePath: string) => {
        func: (name: string, result: string, params: string[]) => (...args: string[]) => string;
      };
    };
  };

  const load = koffiModule.load ?? koffiModule.default?.load;
  if (!load) {
    throw new TLSClientError("Failed to load koffi for the Windows native backend.", {
      code: "ERR_NATIVE_BINDING_LOAD",
    });
  }

  const library = load(libraryPath);
  const rawBinding: RawNativeBinding = {
    request: library.func("request", "string", ["string"]),
    getCookiesFromSession: library.func("getCookiesFromSession", "string", ["string"]),
    destroySession: library.func("destroySession", "string", ["string"]),
    destroyAll: library.func("destroyAll", "string", []),
    freeMemory: library.func("freeMemory", "void", ["string"]),
  };

  const binding: NativeClientBinding = {
    libraryPath,
    async request(payload) {
      return parseNativeResponse(
        await invokeNativeAsync(
          "request",
          rawBinding.request as typeof rawBinding.request & NativeAsyncFunction,
          JSON.stringify(payload)
        ),
        "request",
        rawBinding
      );
    },
    async getCookiesFromSession(payload) {
      return parseNativeResponse(
        await invokeNativeAsync(
          "getCookiesFromSession",
          rawBinding.getCookiesFromSession as typeof rawBinding.getCookiesFromSession & NativeAsyncFunction,
          JSON.stringify(payload)
        ),
        "getCookiesFromSession",
        rawBinding
      );
    },
    async destroySession(payload) {
      return parseNativeResponse(
        await invokeNativeAsync(
          "destroySession",
          rawBinding.destroySession as typeof rawBinding.destroySession & NativeAsyncFunction,
          JSON.stringify(payload)
        ),
        "destroySession",
        rawBinding
      );
    },
    async destroyAll() {
      return parseNativeResponse(
        await invokeNativeAsync(
          "destroyAll",
          rawBinding.destroyAll as typeof rawBinding.destroyAll & NativeAsyncFunction
        ),
        "destroyAll",
        rawBinding
      );
    },
  };

  bindingCache.set(libraryPath, binding);
  return binding;
}

export async function ensureNativeBinding(
  options: TLSClientOptions = {}
): Promise<NativeClientBinding> {
  const library = await ensureNativeLibrary(options);
  return loadNativeBinding(library.libraryPath);
}