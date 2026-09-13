import { describe, expect, test } from "bun:test";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

describe("OpenCode trace context E2E", () => {
  test("native flag fallback to AI SDK propagates without SDK capture", () =>
    withE2EFixture(
      {
        env: { OPENCODE_EXPERIMENTAL_NATIVE_LLM: "1" },
        pluginOptions: { captureContent: true },
        replies: [{ type: "text", text: "fallback trace propagated" }],
      },
      async (fixture) => {
        const result = await fixture.run("propagate fallback request context");
        const spans = requireSpans(fixture, result, 3);

        expect(result.stdout).toContain("fallback trace propagated");
        expect(result.stderr).toContain("native runtime unavailable; falling back to ai-sdk");
        spans.forEach(expectUnset);
      },
    ));

  test("exports a new trace with collector headers", () => {
    return withE2EFixture(
      {
        pluginOptions: {
          otlpHeaders: { "x-e2e-collector": "local-receiver" },
        },
        replies: [{ type: "text", text: "trace exported" }],
      },
      async (fixture) => {
        const result = await fixture.run("export a new trace");
        const spans = requireSpans(fixture, result, 3);

        const run = oneSpan(spans, "e2e.run");
        const interaction = oneSpan(spans, "e2e.interaction");
        const llm = oneSpan(spans, "e2e.llm");
        expect(run.parentSpanId ?? "").toBe("");
        expect(interaction.parentSpanId).toBe(run.spanId);
        expect(llm.parentSpanId).toBe(interaction.spanId);
        spans.forEach((span) => {
          expect(span.traceId).toBe(run.traceId);
          expect(span.traceState).toBeUndefined();
          expectUnset(span);
        });
        expect(fixture.otlp.headers.length).toBeGreaterThan(0);
        fixture.otlp.headers.forEach((headers) =>
          expect(headers.get("x-e2e-collector")).toBe("local-receiver"),
        );
        fixture.llm.hits.forEach((hit) => expect(hit.headers.has("x-e2e-collector")).toBe(false));
      },
    );
  });

  test("ignores removed trace context options and exports a fresh trace", () =>
    withE2EFixture(
      {
        pluginOptions: {
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
          tracestate: "observer=value",
        },
        replies: [{ type: "text", text: "fresh trace" }],
      },
      async (fixture) => {
        const result = await fixture.run("start a new trace");
        const spans = requireSpans(fixture, result, 3);

        expect(oneSpan(spans, "e2e.run").parentSpanId ?? "").toBe("");
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
        spans.forEach((span) => {
          expect(span.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
          expect(span.traceState).toBeUndefined();
          expectUnset(span);
        });
      },
    ));
});
