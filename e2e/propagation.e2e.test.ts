import { describe, expect, test } from "bun:test";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

describe("OpenCode trace context E2E", () => {
  test("honors the remote W3C parent and collector headers", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const parentId = "b7ad6b7169203331";

    return withE2EFixture(
      {
        pluginOptions: {
          traceparent: `00-${traceId}-${parentId}-01`,
          tracestate: "observer=value",
          otlpHeaders: { "x-e2e-collector": "local-receiver" },
        },
        replies: [{ type: "text", text: "context attached" }],
      },
      async (fixture) => {
        const result = await fixture.run("attach the configured parent");
        const spans = requireSpans(fixture, result, 3);

        const run = oneSpan(spans, "e2e.run");
        const interaction = oneSpan(spans, "e2e.interaction");
        const llm = oneSpan(spans, "e2e.llm");
        expect(run.parentSpanId).toBe(parentId);
        expect(interaction.parentSpanId).toBe(run.spanId);
        expect(llm.parentSpanId).toBe(interaction.spanId);
        spans.forEach((span) => {
          expect(span.traceId).toBe(traceId);
          expect(span.traceState).toBe("observer=value");
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

  test("starts a fresh root when the configured parent is invalid", () =>
    withE2EFixture(
      {
        pluginOptions: { traceparent: "invalid-parent" },
        replies: [{ type: "text", text: "fresh trace" }],
      },
      async (fixture) => {
        const result = await fixture.run("start a new trace");
        const spans = requireSpans(fixture, result, 3);

        expect(oneSpan(spans, "e2e.run").parentSpanId ?? "").toBe("");
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
        spans.forEach(expectUnset);
      },
    ));
});
