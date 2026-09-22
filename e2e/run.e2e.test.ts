import { describe, expect, test } from "bun:test";
import { name, version } from "../package.json";
import { expectError, expectUnset, messages, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

describe("OpenCode run E2E", () => {
  test.each([true, false, undefined])(
    "exports a complete GenAI trace with HTTP headers=%s",
    (captureHttpHeaders) =>
      withE2EFixture(
        {
          pluginOptions: { captureContent: true, captureHttpHeaders },
          replies: [
            {
              type: "text",
              text: "hello from observer",
              reasoning: "consider the greeting",
              usage: { input: 11, output: 7, cacheRead: 4, reasoning: 2 },
            },
          ],
        },
        async (fixture) => {
          const result = await fixture.run("say hello");
          const spans = requireSpans(fixture, result, 3);

          expect(result.stdout).toContain("hello from observer");
          expect(fixture.llm.mainHits()).toHaveLength(1);
          const run = oneSpan(spans, "e2e.run");
          const interaction = oneSpan(spans, "e2e.interaction");
          const llm = oneSpan(spans, "e2e.llm");
          expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
          expect(run.parentSpanId ?? "").toBe("");
          expect(interaction.parentSpanId).toBe(run.spanId);
          expect(interaction.endTimeUnixNano).toBe(run.endTimeUnixNano);
          expect(llm.parentSpanId).toBe(interaction.spanId);
          expect([run.kind, interaction.kind, llm.kind]).toEqual([1, 1, 3]);
          expect(run.attributes["gen_ai.operation.name"]).toBe("invoke_workflow");
          expect(interaction.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
          expect(llm.attributes).toMatchObject({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "test",
            "gen_ai.request.model": "test-model",
            "gen_ai.response.model": "test-response-model",
            "gen_ai.request.stream": true,
            "gen_ai.agent.name": "build",
            "opencode.agent.type": "primary",
            "gen_ai.usage.input_tokens": 11,
            "gen_ai.usage.output_tokens": 7,
            "gen_ai.usage.cache_read.input_tokens": 4,
            "gen_ai.usage.cache_write.input_tokens": 0,
            "gen_ai.usage.reasoning.output_tokens": 2,
            "gen_ai.response.finish_reasons": ["stop"],
            "opencode.llm.retry_count": 0,
            "gen_ai.response.time_to_first_chunk": expect.any(Number),
          });
          expect(llm.attributes["opencode.provider.id"]).toBeUndefined();
          expect(llm.attributes["opencode.llm.fetch.end_reason"]).toBeUndefined();
          expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
          expect(messages(llm, "input")).toContainEqual({
            role: "user",
            parts: [{ type: "text", content: "say hello" }],
          });
          expect(messages(llm, "input")).toContainEqual({
            role: "system",
            parts: expect.arrayContaining([{ type: "text", content: expect.any(String) }]),
          });
          expect(llm.attributes["gen_ai.system_instructions"]).toBeUndefined();
          const request = fixture.llm.mainHits()[0]!;
          expect(
            (messages(llm, "input") as Array<{ role: string; parts: unknown[] }>).filter(
              (message) => message.role === "system",
            ),
          ).toEqual(
            (request.body.messages as Array<{ role: string; content: string }>)
              .filter((message) => message.role === "system")
              .map((message) => ({
                role: "system",
                parts: [{ type: "text", content: message.content }],
              })),
          );
          expect(llm.attributes["http.request.header.x-observer-model"]).toEqual(
            captureHttpHeaders ? ["request-one,two"] : undefined,
          );
          expect(request.headers.get("x-observer-model")).toBe("request-one,two");
          expect(request.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
          expect(llm.attributes["http.request.header.traceparent"]).toEqual(
            captureHttpHeaders ? [request.headers.get("traceparent")] : undefined,
          );
          expect(llm.attributes["http.response.header.content-type"]).toEqual(
            captureHttpHeaders ? ["text/event-stream"] : undefined,
          );
          expect(llm.attributes["http.response.header.x-observer-response"]).toEqual(
            captureHttpHeaders ? ["success-one,two"] : undefined,
          );
          if (!captureHttpHeaders) {
            expect(Object.keys(llm.attributes).some((key) => key.startsWith("http."))).toBe(false);
          }
          expect(llm.attributes["http.request.header.x-opencode-observer-request"]).toBeUndefined();
          expect(llm.attributes["gen_ai.request.seed"]).toBeUndefined();
          expect(llm.attributes["gen_ai.output.type"]).toBe("text");
          const definitions = JSON.parse(
            String(llm.attributes["gen_ai.tool.definitions"]),
          ) as Array<{
            type: string;
            name: string;
            parameters?: unknown;
          }>;
          const sentTools = request.body.tools as Array<{
            type: string;
            function: { name: string; parameters?: unknown };
          }>;
          expect(definitions.map((definition) => definition.name).sort()).toEqual(
            sentTools.map((tool) => tool.function.name).sort(),
          );
          const read = definitions.find((definition) => definition.name === "read");
          expect(read).toMatchObject({
            type: "function",
            parameters: { type: "object", properties: { filePath: { type: "string" } } },
          });
          expect(read).not.toHaveProperty("function");
          expect(messages(llm, "output")).toEqual([
            {
              role: "assistant",
              parts: [
                { type: "reasoning", content: "consider the greeting" },
                { type: "text", content: "hello from observer" },
              ],
            },
          ]);
          [run, interaction].forEach((span) => {
            expect(messages(span, "input")).toEqual([
              { role: "user", parts: [{ type: "text", content: "say hello" }] },
            ]);
            expect(messages(span, "output")).toEqual([
              { role: "assistant", parts: [{ type: "text", content: "hello from observer" }] },
            ]);
          });
          spans.forEach((span) => {
            expectUnset(span);
            expect(span.scope).toEqual({ name, version });
            expect(span.resource).toMatchObject({
              "service.name": "opencode",
              "service.version": "local",
              "e2e.resource": "opencode-observer",
            });
            expect(span.attributes["e2e.fixture"]).toBeString();
            expect(span.attributes["user.id"]).toBeUndefined();
            expect(span.attributes["openinference.span.kind"]).toBeUndefined();
          });
        },
      ),
  );

  test.each([true, false, undefined])(
    "omits content by default with HTTP headers=%s while preserving metadata",
    (captureHttpHeaders) =>
      withE2EFixture(
        {
          pluginOptions: { captureHttpHeaders },
          replies: [
            {
              type: "tool",
              name: "bash",
              input: { command: "echo private-tool-result", description: "Print private output" },
              usage: { input: 5, output: 2 },
            },
            { type: "text", text: "private-assistant-output", usage: { input: 4, output: 3 } },
          ],
        },
        async (fixture) => {
          const result = await fixture.run("private-user-input", [
            "--dangerously-skip-permissions",
          ]);
          const spans = requireSpans(fixture, result, 5);

          expect(fixture.llm.mainHits()).toHaveLength(2);
          expect(oneSpan(spans, "e2e.tool.bash").attributes["gen_ai.tool.name"]).toBe("bash");
          spans.forEach((span) => {
            expectUnset(span);
            [
              "gen_ai.input.messages",
              "gen_ai.output.messages",
              "gen_ai.system_instructions",
              "gen_ai.tool.call.arguments",
              "gen_ai.tool.call.result",
              "gen_ai.tool.definitions",
              "gen_ai.tool.description",
            ].forEach((key) => expect(span.attributes[key]).toBeUndefined());
            expect(
              Object.keys(span.attributes).some(
                (key) =>
                  key.startsWith("http.request.header.") || key.startsWith("http.response.header."),
              ),
            ).toBe(false);
          });
          expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("private-");
          spans
            .filter((span) => span.name === "e2e.llm")
            .forEach((span) => {
              expect(span.attributes["gen_ai.output.type"]).toBe("text");
              expect(span.attributes["gen_ai.response.model"]).toBe("test-response-model");
              expect(span.attributes["gen_ai.response.time_to_first_chunk"]).toBeGreaterThanOrEqual(
                0,
              );
              expect(span.attributes["opencode.provider.id"]).toBeUndefined();
              expect(span.attributes["opencode.llm.fetch.end_reason"]).toBeUndefined();
              expect(span.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
            });
          expect(
            spans
              .filter((span) => span.name === "e2e.llm")
              .map((span) => span.attributes["gen_ai.usage.input_tokens"])
              .sort(),
          ).toEqual([4, 5]);
        },
      ),
  );

  test("loads the plugin without exporting when telemetry is disabled", () =>
    withE2EFixture(
      {
        pluginOptions: { enabled: false, captureContent: true },
        replies: [{ type: "text", text: "telemetry is disabled" }],
      },
      async (fixture) => {
        const result = await fixture.run("do not trace this");
        requireSpans(fixture, result, 0);

        expect(result.stdout).toContain("telemetry is disabled");
        expect(result.stderr).not.toContain("Observer plugin initialized");
        expect(result.stderr).not.toContain("OTLP endpoint TCP");
        expect(fixture.llm.mainHits()).toHaveLength(1);
        expect(fixture.otlp.payloads).toEqual([]);
      },
    ));

  test("keeps one successful logical LLM span after provider retries", () =>
    withE2EFixture(
      {
        replies: [
          { type: "error", code: "server_error", status: 500, message: "temporary failure one" },
          { type: "error", code: "server_error", status: 500, message: "temporary failure two" },
          { type: "text", text: "recovered", usage: { input: 3, output: 2 } },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("retry temporary failures");
        const spans = requireSpans(fixture, result, 3);

        expect(result.stdout).toContain("recovered");
        expect(fixture.llm.mainHits()).toHaveLength(3);
        const llm = oneSpan(spans, "e2e.llm");
        expect(llm.attributes["opencode.llm.retry_count"]).toBe(2);
        expect(
          Object.keys(llm.attributes).filter((key) => key.startsWith("opencode.llm.retry")),
        ).toEqual(["opencode.llm.retry_count"]);
        const firstChunk = llm.attributes["gen_ai.response.time_to_first_chunk"];
        expect(firstChunk).toBeGreaterThanOrEqual(
          (fixture.llm.mainHits()[2]!.receivedAt - fixture.llm.mainHits()[0]!.receivedAt) / 1000,
        );
        expect(firstChunk).toBeLessThanOrEqual(
          Number(BigInt(llm.endTimeUnixNano) - BigInt(llm.startTimeUnixNano)) / 1_000_000_000,
        );
        expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
        expect(llm.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
        spans.forEach(expectUnset);
      },
    ));

  test("preserves only reported OpenCode retry count on terminal provider failure", () =>
    withE2EFixture(
      {
        replies: [
          { type: "error", code: "server_error", status: 500, message: "retry this" },
          { type: "error", code: "invalid_request", message: "stop retrying" },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("retry then fail");
        const spans = requireSpans(fixture, result, 3, 1);
        const llm = oneSpan(spans, "e2e.llm");

        expect(fixture.llm.mainHits()).toHaveLength(2);
        expect(llm.attributes["opencode.llm.retry_count"]).toBe(1);
        expect(llm.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
        expect(llm.attributes["opencode.llm.time_to_first_chunk.source"]).toBeUndefined();
        expect(
          Object.keys(llm.attributes).filter((key) => key.startsWith("opencode.llm.retry")),
        ).toEqual(["opencode.llm.retry_count"]);
        spans.forEach((span) => expectError(span, "APIError"));
      },
    ));

  test.each(
    [true, false].flatMap((content) =>
      [true, false, undefined].map((headers) => [content, headers] as const),
    ),
  )(
    "exports a prepared failed LLM span with content=%s headers=%s",
    (captureContent, captureHttpHeaders) =>
      withE2EFixture(
        {
          pluginOptions: { captureContent, captureHttpHeaders },
          replies: [{ type: "error", code: "invalid_request", message: "invalid e2e request" }],
        },
        async (fixture) => {
          const result = await fixture.run("fail the model request");
          const spans = requireSpans(fixture, result, 3, 1);

          expect(fixture.llm.mainHits()).toHaveLength(1);
          expect(
            oneSpan(spans, "e2e.llm").attributes["http.request.header.x-observer-model"],
          ).toEqual(captureContent && captureHttpHeaders ? ["request-one,two"] : undefined);
          expect(
            oneSpan(spans, "e2e.llm").attributes["http.response.header.x-observer-response"],
          ).toEqual(captureContent && captureHttpHeaders ? ["error-response"] : undefined);
          if (!captureContent || !captureHttpHeaders) {
            expect(
              Object.keys(oneSpan(spans, "e2e.llm").attributes).some((key) =>
                key.startsWith("http."),
              ),
            ).toBe(false);
          }
          expect(oneSpan(spans, "e2e.llm").parentSpanId).toBe(
            oneSpan(spans, "e2e.interaction").spanId,
          );
          spans.forEach((span) => expectError(span, "APIError"));
          expect(oneSpan(spans, "e2e.interaction").parentSpanId).toBe(
            oneSpan(spans, "e2e.run").spanId,
          );
        },
      ),
  );

  test.each([true, false])(
    "exports a default summary for a blank provider error with captureContent=%s",
    (captureContent) =>
      withE2EFixture(
        {
          pluginOptions: { captureContent },
          replies: [{ type: "error", code: "invalid_request", message: " \t " }],
        },
        async (fixture) => {
          const result = await fixture.run("fail without an error summary");
          // OpenCode only sets a failure exit code when the source error message is nonempty.
          const spans = requireSpans(fixture, result, 3);

          expect(result.stdout).toContain('"type":"error"');
          expect(result.stdout).toContain('"message":""');
          spans.forEach((span) => {
            expectError(span, "APIError");
            expect(span.status.message).toBe("APIError: no error message provided");
          });
        },
      ),
  );

  test("starts a separate run when an idle session receives another user message", () =>
    withE2EFixture(
      {
        pluginOptions: { captureContent: true },
        replies: [
          { type: "text", text: "first response" },
          { type: "text", text: "second response" },
        ],
      },
      async (fixture) => {
        const first = await fixture.run("first request");
        expect(first.exitCode).toBe(0);
        const initial = oneSpan(fixture.otlp.spans(), "e2e.run");
        const sessionID = initial.attributes["session.id"];
        expect(sessionID).toBeString();

        const second = await fixture.run("second request", ["--session", String(sessionID)]);
        const spans = requireSpans(fixture, second, 6);

        expect(fixture.llm.mainHits()).toHaveLength(2);
        const resumed = oneSpan(
          spans.filter((span) => span.traceId !== initial.traceId),
          "e2e.run",
        );
        expect(resumed.attributes["session.id"]).toBe(sessionID);
        expect(resumed.attributes["opencode.run.id"]).not.toBe(
          initial.attributes["opencode.run.id"],
        );
        expect(resumed.parentSpanId ?? "").toBe("");
        expect(messages(resumed, "input")).toEqual([
          { role: "user", parts: [{ type: "text", content: "second request" }] },
        ]);
        expect(messages(resumed, "output")).toEqual([
          { role: "assistant", parts: [{ type: "text", content: "second response" }] },
        ]);
        const llm = oneSpan(
          spans.filter((span) => span.traceId === resumed.traceId),
          "e2e.llm",
        );
        expect(messages(llm, "input")).toContainEqual({
          role: "assistant",
          parts: [{ type: "text", content: "first response" }],
        });
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
        spans.forEach(expectUnset);
      },
    ));
});
