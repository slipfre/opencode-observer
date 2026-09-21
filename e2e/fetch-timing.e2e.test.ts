import path from "node:path";
import { expect, test } from "bun:test";
import { expectError, expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

// CLI and server are separate Bun processes; wall-clock samples can differ by 1 ms.
const clockToleranceMs = 2;

test.each(["message", "fetch"])(
  "LLM timing mode=%s selects actual boundaries without changing tools or output",
  (llmTimingMode) =>
    withE2EFixture(
      {
        pluginEntry: path.join(import.meta.dir, "support/fetch-timing-plugin.ts"),
        pluginOptions: { llmTimingMode },
        replies: [
          {
            type: "tool",
            name: "timing_wait",
            input: { delay: 700 },
            usage: { input: 5, output: 2 },
          },
          { type: "tool", name: "timing_wait", input: { delay: 0 }, tailDelayMs: 300 },
          {
            type: "text",
            text: "timing complete",
            tailDelayMs: 200,
            usage: { input: 4, output: 3 },
          },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("Run the timing tools, then answer.", [
          "--dangerously-skip-permissions",
        ]);
        const spans = requireSpans(fixture, result, 7);
        expect(result.stdout).toContain("timing complete");
        const messages = (await Bun.file(
          path.join(fixture.directory, "timing-messages.json"),
        ).json()) as Record<string, { created: number; completed: number; firstStep: number }>;
        const llms = spans.filter((span) => span.name === "e2e.llm");
        expect(llms).toHaveLength(3);
        fixture.llm.mainHits().forEach((hit, index) => {
          const llm = llms.find(
            (span) => hit.headers.get("traceparent") === `00-${span.traceId}-${span.spanId}-01`,
          )!;
          const message = messages[String(llm.attributes["opencode.message.id"])]!;
          const start = Number(BigInt(llm.startTimeUnixNano) / 1_000_000n);
          const end = Number(BigInt(llm.endTimeUnixNano) / 1_000_000n);
          expectUnset(llm);
          expect(llm.attributes["opencode.llm.timing.source"]).toBe(llmTimingMode);
          expect(llm.attributes["opencode.llm.timing.fallback_reason"]).toBeUndefined();
          expect(llm.attributes["gen_ai.input.messages"]).toBeUndefined();
          expect(llm.attributes["gen_ai.output.messages"]).toBeUndefined();
          expect(message.firstStep).toBeGreaterThanOrEqual(start);
          expect(llm.attributes["gen_ai.response.time_to_first_chunk"]).toBe(
            (message.firstStep - start) / 1000,
          );
          expect(llm.attributes["opencode.provider.id"]).toBeUndefined();
          expect(llm.attributes["opencode.llm.fetch.end_reason"]).toBeUndefined();
          expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
          if (llmTimingMode === "message") {
            expect(start).toBe(message.created);
            expect(end).toBe(message.completed);
            return;
          }

          expect(start).toBeGreaterThanOrEqual(message.created + 90);
          expect(start).toBeLessThanOrEqual(hit.receivedAt + clockToleranceMs);
          expect(end).toBeGreaterThanOrEqual(hit.finishedAt! - clockToleranceMs);
          expect(end).toBeLessThanOrEqual(message.completed);
          if (index === 0) {
            expect(message.completed - end).toBeGreaterThan(500);
          }
          if (index > 0) {
            expect(end - start).toBeGreaterThanOrEqual(index === 1 ? 290 : 190);
          }
        });
        expect(llms.some((span) => span.attributes["gen_ai.usage.input_tokens"] === 5)).toBe(true);
        expect(llms.some((span) => span.attributes["gen_ai.usage.input_tokens"] === 4)).toBe(true);
        expect(spans.filter((span) => span.name === "e2e.tool.timing_wait")).toHaveLength(2);
      },
    ),
);

test("fetch timing includes transport retries and still captures structured output", () =>
  withE2EFixture(
    {
      pluginEntry: path.join(import.meta.dir, "support/fetch-timing-plugin.ts"),
      pluginOptions: { llmTimingMode: "fetch", captureContent: true },
      replies: [
        {
          type: "error",
          status: 503,
          message: "retry timing",
          code: "overloaded",
          retryAfterMs: 20,
        },
        { type: "text", text: "retried timing", tailDelayMs: 100 },
      ],
    },
    async (fixture) => {
      const spans = requireSpans(fixture, await fixture.run("retry the model"), 3);
      const llm = oneSpan(spans, "e2e.llm");
      const hits = fixture.llm.mainHits();
      expect(hits).toHaveLength(2);
      expect(llm.attributes["opencode.llm.retry_count"]).toBe(1);
      expect(
        Object.keys(llm.attributes).filter((key) => key.startsWith("opencode.llm.retry")),
      ).toEqual(["opencode.llm.retry_count"]);
      expect(llm.attributes["opencode.llm.timing.source"]).toBe("fetch");
      expect(llm.attributes["opencode.llm.timing.fallback_reason"]).toBeUndefined();
      expect(Number(BigInt(llm.startTimeUnixNano) / 1_000_000n)).toBeLessThanOrEqual(
        hits[0]!.receivedAt + clockToleranceMs,
      );
      expect(Number(BigInt(llm.endTimeUnixNano) / 1_000_000n)).toBeGreaterThanOrEqual(
        hits[1]!.finishedAt! - clockToleranceMs,
      );
      expect(hits[0]!.headers.get("traceparent")).toBe(hits[1]!.headers.get("traceparent"));
      expect(String(llm.attributes["gen_ai.output.messages"])).toContain("retried timing");
      const messages = await Bun.file(path.join(fixture.directory, "timing-messages.json")).json();
      const message = messages[String(llm.attributes["opencode.message.id"])];
      const start = Number(BigInt(llm.startTimeUnixNano) / 1_000_000n);
      expect(llm.attributes["gen_ai.response.time_to_first_chunk"]).toBe(
        (message.firstStep - start) / 1000,
      );
      expect(message.firstStep).toBeGreaterThanOrEqual(hits[1]!.receivedAt - clockToleranceMs);
      expectUnset(llm);
    },
  ));

test("fetch mode explicitly falls back when a provider retains a different transport", () =>
  withE2EFixture(
    {
      pluginEntry: path.join(import.meta.dir, "support/fetch-timing-plugin.ts"),
      pluginOptions: { llmTimingMode: "fetch", bypassTimingFetch: true },
      replies: [{ type: "text", text: "bypassed transport" }],
    },
    async (fixture) => {
      const spans = requireSpans(
        fixture,
        await fixture.run("answer with the retained transport"),
        3,
      );
      const llm = oneSpan(spans, "e2e.llm");
      const times = await Bun.file(path.join(fixture.directory, "timing-messages.json")).json();
      const message = times[String(llm.attributes["opencode.message.id"])];
      expect(llm.attributes["opencode.llm.timing.source"]).toBe("message");
      expect(llm.attributes["opencode.llm.timing.fallback_reason"]).toBe("fetch-unobserved");
      expect(llm.attributes["opencode.llm.fetch.end_reason"]).toBeUndefined();
      expect(BigInt(llm.startTimeUnixNano)).toBe(BigInt(message.created) * 1_000_000n);
      expect(BigInt(llm.endTimeUnixNano)).toBe(BigInt(message.completed) * 1_000_000n);
      expect(llm.attributes["gen_ai.response.time_to_first_chunk"]).toBe(
        (message.firstStep - message.created) / 1000,
      );
      expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
      expectUnset(llm);
    },
  ));

test("terminal model error retains measured fetch boundaries and the model error status", () =>
  withE2EFixture(
    {
      pluginOptions: { llmTimingMode: "fetch" },
      replies: [{ type: "error", code: "invalid_request", message: "fetch timing failure" }],
    },
    async (fixture) => {
      const spans = requireSpans(fixture, await fixture.run("fail the model request"), 3, 1);
      const llm = oneSpan(spans, "e2e.llm");
      const request = fixture.llm.mainHits()[0]!;
      expectError(llm, "APIError");
      expect(llm.attributes["opencode.llm.timing.source"]).toBe("fetch");
      expect(llm.attributes["opencode.llm.timing.fallback_reason"]).toBeUndefined();
      expect(llm.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
      expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
      expect(Number(BigInt(llm.startTimeUnixNano) / 1_000_000n)).toBeLessThanOrEqual(
        request.receivedAt + clockToleranceMs,
      );
      expect(Number(BigInt(llm.endTimeUnixNano) / 1_000_000n)).toBeGreaterThanOrEqual(
        request.finishedAt! - clockToleranceMs,
      );
    },
  ));
