import type { ObservationError } from "../../contract/observer.js";

export function normalizeError(error: unknown): ObservationError {
  if (!error || typeof error !== "object") {
    return {
      type: "_OTHER",
      ...(typeof error === "string" && error.trim() ? { message: error } : {}),
    };
  }

  const type =
    "name" in error && typeof error.name === "string" && error.name
      ? error.name
      : "code" in error && (typeof error.code === "string" || typeof error.code === "number")
        ? String(error.code)
        : "_OTHER";
  const data =
    "data" in error && error.data && typeof error.data === "object" ? error.data : undefined;
  // OpenCode NamedError may repeat its type in the outer message without providing details.
  const message = [
    data && "message" in data ? data.message : undefined,
    "message" in error && (!data || error.message !== type) ? error.message : undefined,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return { type, ...(message === undefined ? {} : { message }) };
}
