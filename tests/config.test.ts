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
    tracePrefix: "opencode.",
    captureContent: false,
    spanAttributeCountLimit: 4096,
  });
});

test("options take precedence over environment variables, including explicit false", () => {
  expect(
    loadConfig(
      {
        enabled: true,
        captureContent: false,
        tracePrefix: "",
        endpoint: "https://collector/otel/v1/traces",
      },
      {
        OPENCODE_ENABLE_TELEMETRY: "false",
        OPENCODE_CAPTURE_CONTENT: "true",
        OPENCODE_TRACE_PREFIX: "env.",
      },
    ),
  ).toMatchObject({
    enabled: true,
    captureContent: false,
    tracePrefix: "",
    endpoint: "https://collector/otel/v1/traces",
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
