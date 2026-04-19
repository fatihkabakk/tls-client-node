import type { MultipartBodyLike } from "./types";

export type MultipartFieldValue = string | number | boolean | Blob;
export type MultipartFileSource = string | Blob | ArrayBuffer | ArrayBufferView;

export interface MultipartFileOptions {
  filename: string;
  contentType?: string;
}

export interface MultipartFileValue extends MultipartFileOptions {
  data: MultipartFileSource;
}

export type MultipartValue = MultipartFieldValue | MultipartFileValue;
export type MultipartRecord = Record<string, MultipartValue | MultipartValue[]>;

function isMultipartFileValue(value: MultipartValue): value is MultipartFileValue {
  return typeof value === "object" && value !== null && "data" in value;
}

function createBlobFromSource(
  value: MultipartFileSource,
  contentType?: string
): Blob {
  if (value instanceof Blob && contentType === undefined) {
    return value;
  }

  if (value instanceof Blob) {
    return new Blob([value], { type: contentType });
  }

  if (value instanceof ArrayBuffer) {
    return new Blob([value], { type: contentType });
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    );

    return new Blob([
      bytes,
    ], { type: contentType });
  }

  return new Blob([value], { type: contentType });
}

export class MultipartForm implements MultipartBodyLike {
  private readonly formData = new FormData();

  public append(name: string, value: MultipartFieldValue): this {
    if (value instanceof Blob) {
      this.formData.append(name, value);
    } else {
      this.formData.append(name, String(value));
    }

    return this;
  }

  public appendFile(
    name: string,
    value: MultipartFileSource,
    options: MultipartFileOptions
  ): this {
    this.formData.append(
      name,
      createBlobFromSource(value, options.contentType),
      options.filename
    );
    return this;
  }

  public appendJson(
    name: string,
    value: unknown,
    filename = `${name}.json`
  ): this {
    return this.appendFile(name, JSON.stringify(value), {
      filename,
      contentType: "application/json",
    });
  }

  public toFormData(): FormData {
    return this.formData;
  }

  public static fromRecord(record: MultipartRecord): MultipartForm {
    const form = new MultipartForm();

    for (const [name, rawValue] of Object.entries(record)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];

      for (const value of values) {
        if (isMultipartFileValue(value)) {
          form.appendFile(name, value.data, value);
        } else {
          form.append(name, value);
        }
      }
    }

    return form;
  }
}

export function createMultipartForm(record?: MultipartRecord): MultipartForm {
  return record ? MultipartForm.fromRecord(record) : new MultipartForm();
}