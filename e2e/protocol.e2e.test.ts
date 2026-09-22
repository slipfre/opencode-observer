import { expect, test } from "bun:test";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test.each(
  (["http/json", "http/protobuf", "grpc"] as const).flatMap((protocol) =>
    ["options", "environment"].map((source) => ({ protocol, source })),
  ),
)("exports OTLP $protocol configured through $source", ({ protocol, source }) =>
  withE2EFixture(
    {
      otlpProtocol: protocol,
      pluginOptions: {
        ...(source === "options" ? { otlpProtocol: protocol } : {}),
        otlpHeaders: { "x-e2e-collector": "protocol-test" },
      },
      env: { OPENCODE_OTLP_PROTOCOL: source === "environment" ? protocol : "invalid" },
      replies: [{ type: "text", text: "protocol export completed" }],
    },
    async (fixture) => {
      const result = await fixture.run("export with the configured protocol");
      const spans = requireSpans(fixture, result, 3);
      const run = oneSpan(spans, "e2e.run");
      const interaction = oneSpan(spans, "e2e.interaction");
      const llm = oneSpan(spans, "e2e.llm");

      expect(result.stdout).toContain("protocol export completed");
      expect(run.parentSpanId ?? "").toBe("");
      expect(interaction.parentSpanId).toBe(run.spanId);
      expect(llm.parentSpanId).toBe(interaction.spanId);
      spans.forEach((span) => {
        expect(span.traceId).toBe(run.traceId);
        expect(span.resource["e2e.resource"]).toBe("opencode-observer");
        expectUnset(span);
      });
      expect(fixture.otlp.headers.length).toBeGreaterThan(0);
      fixture.otlp.headers.forEach((headers) =>
        expect(headers.get("x-e2e-collector")).toBe("protocol-test"),
      );
      fixture.llm.hits.forEach((hit) => expect(hit.headers.has("x-e2e-collector")).toBe(false));
    },
  ),
);
