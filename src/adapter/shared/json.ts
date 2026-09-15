import type { JsonValue } from "../../contract/messages.js";

export function jsonValue(value: unknown, parents = new WeakSet<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "bigint" || value instanceof URL) {
    return String(value);
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (typeof value !== "object" || parents.has(value)) {
    return;
  }

  parents.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => jsonValue(item, parents) ?? null)
    : Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const cleaned = jsonValue(item, parents);
          return cleaned === undefined ? [] : [[key, cleaned]];
        }),
      );
  parents.delete(value);

  return result;
}

export function jsonObject(value: unknown) {
  const result = jsonValue(value);
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? result
    : undefined;
}
