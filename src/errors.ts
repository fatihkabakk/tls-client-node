export interface TLSClientErrorOptions {
  code?: string;
  status?: number;
  details?: unknown;
  cause?: unknown;
  retriable?: boolean;
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class TLSClientError extends Error {
  public readonly code?: string;
  public readonly status?: number;
  public readonly details?: unknown;
  public readonly retriable?: boolean;

  constructor(message: string, options: TLSClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "TLSClientError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.retriable = options.retriable;
  }

  public static fromUnknown(
    value: unknown,
    options: TLSClientErrorOptions = {}
  ): TLSClientError {
    if (value instanceof TLSClientError) {
      return value;
    }

    return new TLSClientError(getErrorMessage(value), {
      ...options,
      cause: options.cause ?? value,
    });
  }
}
