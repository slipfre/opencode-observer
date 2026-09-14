import type { ModelHeaders } from "../../contract/observer.js";

export function parseModelHeaders(value: unknown): ModelHeaders | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const headers: ModelHeaders = {};
  Object.entries(value).forEach(([key, value]) => {
    const name = key.toLowerCase();

    // This token associates SDK callbacks locally and is removed before provider execution.
    if (!name || name === "x-opencode-observer-request") {
      return;
    }

    const values = typeof value === "string" ? [value] : value;

    if (Array.isArray(values) && values.every((item) => typeof item === "string")) {
      Object.defineProperty(headers, name, {
        value: [...(Object.hasOwn(headers, name) ? headers[name]! : []), ...values],
        enumerable: true,
        configurable: true,
      });
    }
  });

  return headers;
}

export function parseErrorResponseHeaders(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) {
    return;
  }

  const data = error.data;

  return data && typeof data === "object" && "responseHeaders" in data
    ? parseModelHeaders(data.responseHeaders)
    : undefined;
}
