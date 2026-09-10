import { describe, expect, test } from "bun:test";
import { expectError, expectUnset, messages, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

describe("OpenCode compaction E2E", () => {
  test("parents the summary under compaction and keeps continuation in the original interaction", () =>
    withE2EFixture(
      {
        autoCompact: true,
        pluginOptions: { captureContent: true },
        replies: [
          {
            type: "tool",
            name: "bash",
            input: {
              command: "echo before-compaction",
              description: "Trigger automatic compaction",
            },
            usage: { input: 90_000, output: 2 },
          },
          { type: "text", text: "durable summary", usage: { input: 5, output: 3 } },
          { type: "text", text: "continued after compaction", usage: { input: 4, output: 3 } },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("use a tool and continue", [
          "--dangerously-skip-permissions",
        ]);
        const spans = requireSpans(fixture, result, 7);

        expect(fixture.llm.mainHits()).toHaveLength(3);
        const run = oneSpan(spans, "e2e.run");
        const interaction = oneSpan(spans, "e2e.interaction");
        const compaction = oneSpan(spans, "e2e.compaction");
        const summary = oneSpan(
          spans.filter((span) => span.parentSpanId === compaction.spanId),
          "e2e.llm",
        );
        const ordinary = spans.filter((span) => span.name === "e2e.llm" && span !== summary);
        expect(ordinary).toHaveLength(2);
        ordinary.forEach((span) => expect(span.parentSpanId).toBe(interaction.spanId));
        expect(compaction.parentSpanId).toBe(interaction.spanId);
        expect(interaction.parentSpanId).toBe(run.spanId);
        expect(oneSpan(spans, "e2e.tool.bash").parentSpanId).toBe(interaction.spanId);
        expect(compaction.attributes).toMatchObject({
          "opencode.compaction.auto": true,
          "opencode.compaction.overflow": false,
          "opencode.compaction.prompt_tokens": 5,
          "opencode.compaction.summary_tokens": 3,
          "gen_ai.usage.input_tokens": 5,
          "gen_ai.usage.output_tokens": 3,
        });
        expect(summary.attributes["opencode.compaction.id"]).toBe(
          compaction.attributes["opencode.compaction.id"],
        );
        expect(summary.attributes["gen_ai.agent.name"]).toBe("compaction");
        expect(BigInt(compaction.startTimeUnixNano)).toBeLessThanOrEqual(
          BigInt(summary.startTimeUnixNano),
        );
        expect(BigInt(summary.endTimeUnixNano)).toBeLessThanOrEqual(
          BigInt(compaction.endTimeUnixNano),
        );
        [run, interaction].forEach((span) => {
          expect(messages(span, "input")).toEqual([
            { role: "user", parts: [{ type: "text", content: "use a tool and continue" }] },
          ]);
          expect(messages(span, "output")).toEqual([
            { role: "assistant", parts: [{ type: "text", content: "continued after compaction" }] },
          ]);
        });
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
        spans.forEach(expectUnset);
      },
    ));

  test("ends compaction and its owners with the summary provider error", () =>
    withE2EFixture(
      {
        autoCompact: true,
        replies: [
          {
            type: "tool",
            name: "bash",
            input: {
              command: "echo before-summary-error",
              description: "Trigger a failing summary",
            },
            usage: { input: 90_000, output: 2 },
          },
          {
            type: "error",
            code: "context_length_exceeded",
            message: "Summary exceeded the model context limit",
          },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("compact after a tool", [
          "--dangerously-skip-permissions",
        ]);
        const spans = requireSpans(fixture, result, 5, 1);

        expect(fixture.llm.mainHits()).toHaveLength(2);
        const compaction = oneSpan(spans, "e2e.compaction");
        [compaction, oneSpan(spans, "e2e.interaction"), oneSpan(spans, "e2e.run")].forEach((span) =>
          expectError(span, "ContextOverflowError"),
        );
        expect(compaction.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
        expect(compaction.attributes["opencode.compaction.summary_tokens"]).toBeUndefined();
        expectUnset(oneSpan(spans, "e2e.llm"));
        expectUnset(oneSpan(spans, "e2e.tool.bash"));
      },
    ));
});
