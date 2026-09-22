import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

test("telemetry defaults to disabled and does not parse unused exporter settings", () => {
  expect(loadConfig({}, {})).toEqual({ enabled: false });
  expect(loadConfig({ enabled: false, endpoint: "invalid" }, {})).toEqual({ enabled: false });
});

test("enabled defaults use OTLP HTTP and leave content capture off", () => {
  expect(loadConfig({ enabled: true }, {})).toMatchObject({
    enabled: true,
    endpoint: "http://localhost:4318/v1/traces",
    spanNamePrefix: "opencode.",
    attributePrefix: "opencode.",
    captureContent: false,
    captureHttpHeaders: false,
    llmTimingMode: "message",
    spanAttributeCountLimit: 4096,
    otlpTimeoutMillis: 10_000,
    batchExportTimeoutMillis: 30_000,
    forceFlushTimeoutMillis: 30_000,
  });
});

test.each([
  { option: "otlpTimeoutMillis", env: "OPENCODE_OTLP_TIMEOUT" },
  { option: "batchExportTimeoutMillis", env: "OPENCODE_BATCH_EXPORT_TIMEOUT" },
  { option: "forceFlushTimeoutMillis", env: "OPENCODE_FORCE_FLUSH_TIMEOUT" },
])("$option validates milliseconds and options override the environment", ({ option, env }) => {
  expect(loadConfig({ enabled: true }, { [env]: "45000" })).toMatchObject({ [option]: 45_000 });
  expect(loadConfig({ enabled: true, [option]: 20_000 }, { [env]: "45000" })).toMatchObject({
    [option]: 20_000,
  });
  expect(loadConfig({ enabled: true, [option]: "15000" }, {})).toMatchObject({
    [option]: 15_000,
  });
  expect(loadConfig({ enabled: true, [option]: 2_147_483_647 }, {})).toMatchObject({
    [option]: 2_147_483_647,
  });

  for (const value of [0, -1, 1.5, "", " ", "invalid", NaN, Infinity, 2_147_483_648, true, []]) {
    expect(() => loadConfig({ enabled: true, [option]: value }, {})).toThrow(option);
    expect(() => loadConfig({ enabled: true }, { [env]: String(value) })).toThrow(option);
  }

  expect(loadConfig({ [option]: "invalid" }, { [env]: "invalid" })).toEqual({ enabled: false });
});

test.each([true, false, "true", "false", "1", "0"])(
  "HTTP header capture parses boolean option and environment value %s",
  (value) => {
    const expected = value === true || value === "true" || value === "1";
    expect(loadConfig({ enabled: true, captureHttpHeaders: value }, {})).toMatchObject({
      captureContent: false,
      captureHttpHeaders: expected,
    });
    expect(
      loadConfig({ enabled: true }, { OPENCODE_CAPTURE_HTTP_HEADERS: String(value) }),
    ).toMatchObject({ captureHttpHeaders: expected });
  },
);

test("HTTP header capture defaults off with content enabled and rejects invalid values", () => {
  expect(loadConfig({ enabled: true, captureContent: true }, {})).toMatchObject({
    captureHttpHeaders: false,
  });
  expect(() => loadConfig({ enabled: true, captureHttpHeaders: "yes" }, {})).toThrow();
  expect(() => loadConfig({ enabled: true }, { OPENCODE_CAPTURE_HTTP_HEADERS: "yes" })).toThrow();
});

test("LLM timing mode validates values and options override the environment", () => {
  expect(loadConfig({ enabled: true }, { OPENCODE_LLM_TIMING_MODE: "fetch" })).toMatchObject({
    llmTimingMode: "fetch",
  });
  expect(
    loadConfig({ enabled: true, llmTimingMode: "message" }, { OPENCODE_LLM_TIMING_MODE: "fetch" }),
  ).toMatchObject({ llmTimingMode: "message" });
  for (const llmTimingMode of [true, "FETCH", "network", "", 1]) {
    expect(() => loadConfig({ enabled: true, llmTimingMode }, {})).toThrow("llmTimingMode");
  }
  expect(loadConfig({ llmTimingMode: "invalid" }, {})).toEqual({ enabled: false });
});

test("options take precedence over environment variables, including explicit false", () => {
  expect(
    loadConfig(
      {
        enabled: true,
        captureContent: false,
        captureHttpHeaders: false,
        tracePrefix: "",
        endpoint: "https://collector/otel/v1/traces",
      },
      {
        OPENCODE_ENABLE_TELEMETRY: "false",
        OPENCODE_CAPTURE_CONTENT: "true",
        OPENCODE_CAPTURE_HTTP_HEADERS: "true",
        OPENCODE_TRACE_PREFIX: "env.",
      },
    ),
  ).toMatchObject({
    enabled: true,
    captureContent: false,
    captureHttpHeaders: false,
    spanNamePrefix: "",
    endpoint: "https://collector/otel/v1/traces",
  });
});

test.each(["app.", "", "raw"])(
  "attribute prefix %j is independent and preserves literal strings",
  (attributePrefix) => {
    expect(loadConfig({ enabled: true, attributePrefix }, {})).toMatchObject({
      spanNamePrefix: "opencode.",
      attributePrefix,
    });
    expect(
      loadConfig({ enabled: true }, { OPENCODE_ATTRIBUTE_PREFIX: attributePrefix }),
    ).toMatchObject({
      spanNamePrefix: "opencode.",
      attributePrefix,
    });
    expect(
      loadConfig(
        { enabled: true, tracePrefix: "spans.", attributePrefix },
        { OPENCODE_ATTRIBUTE_PREFIX: "env." },
      ),
    ).toMatchObject({ spanNamePrefix: "spans.", attributePrefix });
  },
);

test("attribute prefix defaults independently of the span name prefix and validates strings", () => {
  expect(loadConfig({ enabled: true, tracePrefix: "spans." }, {})).toMatchObject({
    attributePrefix: "opencode.",
  });
  expect(loadConfig({ enabled: true }, { OPENCODE_TRACE_PREFIX: "spans." })).toMatchObject({
    attributePrefix: "opencode.",
  });
  [true, 1, {}, []].forEach((attributePrefix) => {
    expect(() => loadConfig({ enabled: true, attributePrefix }, {})).toThrow();
    expect(loadConfig({ attributePrefix }, {})).toEqual({ enabled: false });
  });
});

test("environment attributes preserve equals signs and parse trace configuration", () => {
  expect(
    loadConfig(
      {},
      {
        OPENCODE_ENABLE_TELEMETRY: "1",
        OPENCODE_OTLP_HEADERS: "authorization=token==, x-tenant=demo",
        OPENCODE_RESOURCE_ATTRIBUTES: "service.name=test",
        OPENCODE_SPAN_ATTRIBUTES: "team=observability",
        OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT: "5000",
      },
    ),
  ).toMatchObject({
    otlpHeaders: { authorization: "token==", "x-tenant": "demo" },
    resourceAttributes: { "service.name": "test" },
    spanAttributes: { team: "observability" },
    spanAttributeCountLimit: 5000,
  });
});

test("invalid configuration is rejected instead of silently enabling telemetry or bad limits", () => {
  expect(() => loadConfig({ enabled: "yes" }, {})).toThrow();
  expect(() => loadConfig({ enabled: true, endpoint: "ftp://example.test/traces" }, {})).toThrow();
  expect(() => loadConfig({ enabled: true, spanAttributeCountLimit: 0 }, {})).toThrow();
  expect(() => loadConfig({ enabled: true, spanAttributeCountLimit: 1.5 }, {})).toThrow();
  expect(() => loadConfig({ enabled: true, spanAttributes: { count: 1 } }, {})).toThrow();
  expect(() => loadConfig({ enabled: true, otlpHeaders: "broken" }, {})).toThrow();
});
