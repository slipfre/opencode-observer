import type { ObservationError } from "../../contract/observer.js";

export function normalizeError(error: unknown): ObservationError {
  if (!error || typeof error !== "object") {
    return { type: "_OTHER", ...(typeof error === "string" && error ? { message: error } : {}) };
  }

  const type =
    "name" in error && typeof error.name === "string" && error.name
      ? error.name
      : "code" in error && (typeof error.code === "string" || typeof error.code === "number")
        ? String(error.code)
        : "_OTHER";
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : error;

  return {
    type,
    ...("message" in data && typeof data.message === "string" ? { message: data.message } : {}),
  };
}
