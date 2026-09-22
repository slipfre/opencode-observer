export function loadConfig(
  options: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
) {
  const enabled = parseBoolean(options.enabled ?? env.OPENCODE_ENABLE_TELEMETRY, false);

  if (!enabled) {
    return { enabled: false as const };
  }

  const endpoint = new URL(
    parseString(options.endpoint ?? env.OPENCODE_OTLP_ENDPOINT, "http://localhost:4318"),
  );

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("OTLP endpoint must use HTTP or HTTPS");
  }

  if (!endpoint.pathname.endsWith("/v1/traces")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/traces`;
  }

  const spanAttributeCountLimit = Number(
    options.spanAttributeCountLimit ?? env.OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT ?? 4096,
  );

  if (!Number.isSafeInteger(spanAttributeCountLimit) || spanAttributeCountLimit <= 0) {
    throw new Error("spanAttributeCountLimit must be a positive integer");
  }

  const llmTimingMode = options.llmTimingMode ?? env.OPENCODE_LLM_TIMING_MODE ?? "message";
  if (llmTimingMode !== "message" && llmTimingMode !== "fetch") {
    throw new Error('llmTimingMode must be "message" or "fetch"');
  }

  return {
    enabled: true as const,
    endpoint: endpoint.toString(),
    captureContent: parseBoolean(options.captureContent ?? env.OPENCODE_CAPTURE_CONTENT, false),
    captureHttpHeaders: parseBoolean(
      options.captureHttpHeaders ?? env.OPENCODE_CAPTURE_HTTP_HEADERS,
      false,
    ),
    llmTimingMode: llmTimingMode as "message" | "fetch",
    spanNamePrefix: parseString(options.tracePrefix ?? env.OPENCODE_TRACE_PREFIX, "opencode."),
    attributePrefix: parseString(
      options.attributePrefix ?? env.OPENCODE_ATTRIBUTE_PREFIX,
      "opencode.",
    ),
    otlpHeaders: parseStringMap(options.otlpHeaders ?? env.OPENCODE_OTLP_HEADERS),
    otlpTimeoutMillis: parseTimeout(
      options.otlpTimeoutMillis ?? env.OPENCODE_OTLP_TIMEOUT ?? 10_000,
      "otlpTimeoutMillis",
    ),
    batchExportTimeoutMillis: parseTimeout(
      options.batchExportTimeoutMillis ?? env.OPENCODE_BATCH_EXPORT_TIMEOUT ?? 30_000,
      "batchExportTimeoutMillis",
    ),
    forceFlushTimeoutMillis: parseTimeout(
      options.forceFlushTimeoutMillis ?? env.OPENCODE_FORCE_FLUSH_TIMEOUT ?? 30_000,
      "forceFlushTimeoutMillis",
    ),
    resourceAttributes: parseStringMap(
      options.resourceAttributes ?? env.OPENCODE_RESOURCE_ATTRIBUTES,
    ),
    spanAttributes: parseStringMap(options.spanAttributes ?? env.OPENCODE_SPAN_ATTRIBUTES),
    spanAttributeCountLimit,
  };
}

function parseTimeout(value: unknown, name: string) {
  const timeout = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  // Larger delays overflow the runtime's signed 32-bit timers and can fire immediately.
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647 milliseconds`);
  }

  return timeout;
}

function parseString(value: unknown, fallback: string) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error("Expected a string configuration value");
  }

  return value;
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  if (value === true || value === "true" || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === "0") {
    return false;
  }

  throw new Error("Expected a boolean configuration value");
}

function parseStringMap(value: unknown): Record<string, string> {
  if (value === undefined || value === "") {
    return {};
  }

  if (typeof value === "string") {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=");

        if (index <= 0 || !entry.slice(0, index).trim()) {
          throw new Error("Expected comma-separated key=value attributes");
        }

        return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
      }),
    );
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === "string")
  ) {
    return value as Record<string, string>;
  }

  throw new Error("Expected string-valued attributes");
}
