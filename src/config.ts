export function loadConfig(
  options: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
) {
  const enabled = boolean(options.enabled ?? env.OPENCODE_ENABLE_TELEMETRY, false);

  if (!enabled) {
    return { enabled: false as const };
  }

  const endpoint = new URL(
    string(options.endpoint ?? env.OPENCODE_OTLP_ENDPOINT, "http://localhost:4318"),
  );

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("OTLP endpoint must use HTTP or HTTPS");
  }

  if (!endpoint.pathname.endsWith("/v1/traces")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/traces`;
  }

  const attributeCountLimit = Number(
    options.spanAttributeCountLimit ?? env.OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT ?? 4096,
  );

  if (!Number.isSafeInteger(attributeCountLimit) || attributeCountLimit <= 0) {
    throw new Error("spanAttributeCountLimit must be a positive integer");
  }

  return {
    enabled: true as const,
    endpoint: endpoint.toString(),
    captureContent: boolean(options.captureContent ?? env.OPENCODE_CAPTURE_CONTENT, false),
    tracePrefix: string(options.tracePrefix ?? env.OPENCODE_TRACE_PREFIX, "opencode."),
    traceparent: string(options.traceparent ?? env.OPENCODE_TRACEPARENT, ""),
    tracestate: string(options.tracestate ?? env.OPENCODE_TRACESTATE, ""),
    headers: attributes(options.otlpHeaders ?? env.OPENCODE_OTLP_HEADERS),
    resourceAttributes: attributes(options.resourceAttributes ?? env.OPENCODE_RESOURCE_ATTRIBUTES),
    spanAttributes: attributes(options.spanAttributes ?? env.OPENCODE_SPAN_ATTRIBUTES),
    attributeCountLimit,
  };
}

function string(value: unknown, fallback: string) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error("Expected a string configuration value");
  }

  return value;
}

function boolean(value: unknown, fallback: boolean) {
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

function attributes(value: unknown): Record<string, string> {
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
