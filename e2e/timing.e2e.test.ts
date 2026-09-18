import { expect, test } from "bun:test";
import path from "node:path";
import { expectError, expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test("LLM span timestamps match assistant messages and include their tool execution", () =>
  withE2EFixture(
    {
      pluginEntry: path.join(import.meta.dir, "support/timing-plugin.ts"),
      replies: [
        {
          type: "tool",
          name: "bash",
          input: { command: "echo timing-tool", description: "Check timing" },
        },
        { type: "text", text: "timing complete" },
      ],
    },
    async (fixture) => {
      const result = await fixture.run("use the tool then answer", [
        "--dangerously-skip-permissions",
      ]);
      const spans = requireSpans(fixture, result, 5);
      const times = (await Bun.file(
        path.join(fixture.directory, "assistant-times.json"),
      ).json()) as Array<{
        id: string;
        created: number;
        completed?: number;
      }>;
      const llms = spans.filter((span) => span.name === "e2e.llm");

      expect(llms).toHaveLength(2);
      llms.forEach((span) => {
        const message = times.find((time) => time.id === span.attributes["opencode.message.id"]);
        expect(message?.completed).toBeNumber();
        expect(BigInt(span.startTimeUnixNano)).toBe(BigInt(message!.created) * 1_000_000n);
        expect(BigInt(span.endTimeUnixNano)).toBe(BigInt(message!.completed!) * 1_000_000n);
        expect(span.attributes["opencode.llm.end_time_source"]).toBeUndefined();
      });
      const tool = oneSpan(spans, "e2e.tool.bash");
      const owner = llms.find(
        (span) =>
          fixture.llm.mainHits()[0]!.headers.get("traceparent") ===
          `00-${span.traceId}-${span.spanId}-01`,
      );
      expect(owner).toBeDefined();
      expect(BigInt(owner!.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(tool.startTimeUnixNano));
      expect(BigInt(owner!.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(tool.endTimeUnixNano));
      spans.forEach(expectUnset);
    },
  ));

test("terminal provider error uses fallback timing without exporting time source", () =>
  withE2EFixture(
    {
      pluginEntry: path.join(import.meta.dir, "support/timing-plugin.ts"),
      replies: [{ type: "error", code: "invalid_request", message: "timing failure" }],
    },
    async (fixture) => {
      const result = await fixture.run("fail the request");
      const spans = requireSpans(fixture, result, 3, 1);
      const llm = oneSpan(spans, "e2e.llm");
      const times = (await Bun.file(
        path.join(fixture.directory, "assistant-times.json"),
      ).json()) as Array<{
        id: string;
        created: number;
        completed?: number;
      }>;
      const message = times.find((time) => time.id === llm.attributes["opencode.message.id"]);

      expectError(llm, "APIError");
      expect(BigInt(llm.startTimeUnixNano)).toBe(BigInt(message!.created) * 1_000_000n);
      expect(llm.attributes["opencode.llm.end_time_source"]).toBeUndefined();
      expect(message?.completed).toBeNumber();
      expect(BigInt(llm.endTimeUnixNano)).toBeLessThanOrEqual(
        BigInt(message!.completed!) * 1_000_000n,
      );
    },
  ));
