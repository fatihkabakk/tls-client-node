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
  request<T>(payload: unknown): T;
  getCookiesFromSession<T>(payload: unknown): T;
  destroySession<T>(payload: unknown): T;
  destroyAll<T>(): T;
}

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
    request(payload) {
      return parseNativeResponse(
        rawBinding.request(JSON.stringify(payload)),
        "request",
        rawBinding
      );
    },
    getCookiesFromSession(payload) {
      return parseNativeResponse(
        rawBinding.getCookiesFromSession(JSON.stringify(payload)),
        "getCookiesFromSession",
        rawBinding
      );
    },
    destroySession(payload) {
      return parseNativeResponse(
        rawBinding.destroySession(JSON.stringify(payload)),
        "destroySession",
        rawBinding
      );
    },
    destroyAll() {
      return parseNativeResponse(rawBinding.destroyAll(), "destroyAll", rawBinding);
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