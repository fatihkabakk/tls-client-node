import { ApiResponsePayload, CookieMap } from "./types";

function isDataUrl(value: string): boolean {
  // Strict full-string match for the exact format the Go library emits for byte
  // responses. The loose startsWith+includes check would false-positive on text
  // bodies that happen to contain "data:" and ";base64," (e.g. CSS with data URIs).
  return /^data:[^;]{1,256};base64,[A-Za-z0-9+/]*={0,2}$/.test(value);
}

export class TLSResponse {
  public readonly id: string;
  public readonly ok: boolean;
  public readonly status: number;
  public readonly url: string;
  public readonly body: string;
  public readonly headers: Record<string, string[]>;
  public readonly cookies: CookieMap;
  public readonly sessionId?: string;
  public readonly usedProtocol?: string;

  constructor(payload: ApiResponsePayload) {
    this.id = payload.id;
    this.ok = payload.status >= 200 && payload.status < 300;
    this.status = payload.status;
    this.url = payload.target;
    this.body = payload.body;
    // Normalize to lowercase so header() lookups are case-insensitive regardless
    // of what casing the Go API uses in its response.
    this.headers = Object.fromEntries(
      Object.entries(payload.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    this.cookies = payload.cookies ?? {};
    this.sessionId = payload.sessionId;
    this.usedProtocol = payload.usedProtocol;
  }

  public text(): Promise<string> {
    return Promise.resolve(this.body);
  }

  public json<T = unknown>(): Promise<T> {
    return Promise.resolve(JSON.parse(this.body) as T);
  }

  public bytes(): Promise<Uint8Array> {
    if (!isDataUrl(this.body)) {
      return Promise.resolve(new TextEncoder().encode(this.body));
    }

    const [, encoded = ""] = this.body.split(",", 2);
    return Promise.resolve(Buffer.from(encoded, "base64"));
  }

  public async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    return Uint8Array.from(bytes).buffer;
  }

  public header(name: string): string | undefined {
    return this.headers[name.toLowerCase()]?.join(", ");
  }

  public toJSON(): ApiResponsePayload {
    return {
      id: this.id,
      status: this.status,
      target: this.url,
      body: this.body,
      headers: this.headers,
      cookies: this.cookies,
      sessionId: this.sessionId,
      usedProtocol: this.usedProtocol,
    };
  }
}
