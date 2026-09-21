export function withUserTraceState(tracestate: string | undefined, userID: string | undefined) {
  const id = userID?.trim();
  // W3C values allow at most 256 printable ASCII characters, excluding comma and equals.
  const value = id && /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/.test(id) ? id : "unknown";
  const entries = (tracestate?.split(",") ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.slice(0, entry.indexOf("=")).trim() !== "user_id");

  // Replace our entry at the front; evict the oldest member if all 32 slots are occupied.
  return [`user_id=${value}`, ...entries].slice(0, 32).join(",");
}
