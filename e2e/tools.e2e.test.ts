import { describe, expect, test } from "bun:test";
import { expectError, expectUnset, messages, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

describe("OpenCode tools E2E", () => {
  test("correlates tool calls, real tool results and the next model request", () => {
    const input = {
      command: "echo observer-tool-output",
      description: "Print deterministic output",
    };

    return withE2EFixture(
      {
        pluginOptions: { captureContent: true },
        replies: [
          { type: "tool", name: "bash", input, usage: { input: 5, output: 2 } },
          { type: "text", text: "tool completed", usage: { input: 4, output: 3 } },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("use the bash tool", ["--dangerously-skip-permissions"]);
        const spans = requireSpans(fixture, result, 5);

        expect(fixture.llm.mainHits()).toHaveLength(2);
        const interaction = oneSpan(spans, "e2e.interaction");
        const tool = oneSpan(spans, "e2e.tool.bash");
        const llms = spans.filter((span) => span.name === "e2e.llm");
        const call = llms.find((span) => span.attributes["gen_ai.usage.input_tokens"] === 5)!;
        const continuation = llms.find(
          (span) => span.attributes["gen_ai.usage.input_tokens"] === 4,
        )!;
        expect(llms).toHaveLength(2);
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
        expect(tool.parentSpanId).toBe(interaction.spanId);
        llms.forEach((span) => expect(span.parentSpanId).toBe(interaction.spanId));
        expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
        expect(tool.attributes["gen_ai.tool.name"]).toBe("bash");
        const definitions = JSON.parse(
          String(call.attributes["gen_ai.tool.definitions"]),
        ) as Array<{
          name: string;
          description?: string;
        }>;
        const description = definitions.find(
          (definition) => definition.name === "bash",
        )?.description;
        expect(description).toBeString();
        expect(description!.length).toBeGreaterThan(0);
        expect(tool.attributes["gen_ai.tool.description"]).toBe(description);
        expect(JSON.parse(String(tool.attributes["gen_ai.tool.call.arguments"]))).toEqual(input);
        expect(JSON.parse(String(tool.attributes["gen_ai.tool.call.result"]))).toEqual({
          content: expect.stringMatching(/^observer-tool-output\r?\n$/),
        });
        expect(messages(call, "output")).toEqual([
          {
            role: "assistant",
            parts: [
              {
                type: "tool_call",
                id: tool.attributes["gen_ai.tool.call.id"],
                name: "bash",
                arguments: input,
              },
            ],
          },
        ]);
        expect(messages(continuation, "input")).toContainEqual({
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: tool.attributes["gen_ai.tool.call.id"],
              response: expect.stringMatching(/^observer-tool-output\r?\n$/),
            },
          ],
        });
        expect(messages(continuation, "output")).toEqual([
          { role: "assistant", parts: [{ type: "text", content: "tool completed" }] },
        ]);
        expect(messages(interaction, "output")).toEqual(messages(continuation, "output"));
        expect(BigInt(tool.endTimeUnixNano)).toBeLessThanOrEqual(
          BigInt(continuation.startTimeUnixNano),
        );
        spans.forEach(expectUnset);
      },
    );
  });

  test("marks a failed tool as ERROR while allowing the run to recover", () =>
    withE2EFixture(
      {
        pluginOptions: { captureContent: true },
        replies: [
          { type: "tool", name: "read", input: { filePath: "missing-e2e-file.txt" } },
          { type: "text", text: "handled the missing file" },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("read the missing file", [
          "--dangerously-skip-permissions",
        ]);
        const spans = requireSpans(fixture, result, 5);

        expect(fixture.llm.mainHits()).toHaveLength(2);
        const tool = oneSpan(spans, "e2e.tool.read");
        expect(tool.attributes["gen_ai.tool.description"]).toBeString();
        expectError(tool, "ExecutionError");
        expect(tool.status.message).toContain("missing-e2e-file.txt");
        expect(tool.attributes["gen_ai.tool.call.result"]).toBeUndefined();
        spans.filter((span) => span !== tool).forEach(expectUnset);
        expect(result.stdout).toContain("handled the missing file");
      },
    ));

  test("attaches a foreground subagent run to its task tool", () =>
    withE2EFixture(
      {
        pluginOptions: { captureContent: true },
        replies: [
          {
            type: "tool",
            name: "task",
            input: {
              description: "Check delegated result",
              prompt: "Return subtask completed",
              subagent_type: "explore",
            },
          },
          { type: "text", text: "subtask completed" },
          { type: "text", text: "parent received subtask" },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("delegate a subtask", ["--dangerously-skip-permissions"]);
        const spans = requireSpans(fixture, result, 8);

        expect(fixture.llm.mainHits()).toHaveLength(3);
        const task = oneSpan(spans, "e2e.tool.task");
        const runs = spans.filter((span) => span.name === "e2e.run");
        const parent = runs.find((span) => !span.attributes["opencode.session.parent_id"])!;
        const child = runs.find((span) => span.attributes["opencode.session.parent_id"])!;
        expect(runs).toHaveLength(2);
        expect(child.parentSpanId).toBe(task.spanId);
        expect(child.attributes["session.id"]).not.toBe(parent.attributes["session.id"]);
        expect(child.attributes["opencode.session.parent_id"]).toBe(
          parent.attributes["session.id"],
        );
        const parentInteraction = oneSpan(
          spans.filter((span) => span.parentSpanId === parent.spanId),
          "e2e.interaction",
        );
        const childInteraction = oneSpan(
          spans.filter((span) => span.parentSpanId === child.spanId),
          "e2e.interaction",
        );
        expect(task.parentSpanId).toBe(parentInteraction.spanId);
        expect(childInteraction.attributes["opencode.agent.type"]).toBe("subagent");
        expect(childInteraction.attributes["gen_ai.agent.name"]).toBe("explore");
        expect(
          spans.filter(
            (span) => span.name === "e2e.llm" && span.parentSpanId === parentInteraction.spanId,
          ),
        ).toHaveLength(2);
        const childLlm = oneSpan(
          spans.filter((span) => span.parentSpanId === childInteraction.spanId),
          "e2e.llm",
        );
        expect(childLlm.attributes["session.id"]).toBe(child.attributes["session.id"]);
        expect(childLlm.attributes["opencode.agent.type"]).toBe("subagent");
        expect(messages(childInteraction, "output")).toEqual([
          { role: "assistant", parts: [{ type: "text", content: "subtask completed" }] },
        ]);
        expect(messages(parent, "output")).toEqual([
          { role: "assistant", parts: [{ type: "text", content: "parent received subtask" }] },
        ]);
        expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
        spans.forEach(expectUnset);
      },
    ));

  test("records a rejected permission as a completed check and classifies the failed tool", () =>
    withE2EFixture(
      {
        permission: { bash: "ask" },
        pluginOptions: { captureContent: true },
        replies: [
          {
            type: "tool",
            name: "bash",
            input: { command: "echo should-not-execute", description: "Request bash permission" },
          },
        ],
      },
      async (fixture) => {
        // Non-interactive OpenCode rejects an asked permission without waiting for user input.
        const result = await fixture.run("request permission to use bash");
        const spans = requireSpans(fixture, result, 5);

        expect(fixture.llm.mainHits()).toHaveLength(1);
        const permission = oneSpan(spans, "e2e.permission.check");
        const tool = oneSpan(spans, "e2e.tool.bash");
        expect(permission.parentSpanId).toBe(tool.spanId);
        expect(permission.attributes).toMatchObject({
          "opencode.permission.tool.call.id": tool.attributes["gen_ai.tool.call.id"],
          "opencode.permission.tool.name": "bash",
          "opencode.permission.name": "bash",
          "opencode.permission.reply": "reject",
          "opencode.permission.granted": false,
        });
        expect(permission.attributes["opencode.permission.patterns"]).toContain(
          "echo should-not-execute",
        );
        expect(permission.attributes["gen_ai.operation.name"]).toBeUndefined();
        expect(permission.attributes["gen_ai.tool.call.id"]).toBeUndefined();
        expect(permission.attributes["gen_ai.tool.name"]).toBeUndefined();
        expectError(tool, "PermissionRejectedError");
        expect(tool.attributes["gen_ai.tool.call.result"]).toBeUndefined();
        // OpenCode stops after rejection, leaving the interaction without a final assistant reply.
        const interaction = oneSpan(spans, "e2e.interaction");
        expectError(interaction, "_OTHER");
        expect(interaction.status.message).toBe("session ended before interaction completed");
        [permission, oneSpan(spans, "e2e.run"), oneSpan(spans, "e2e.llm")].forEach(expectUnset);
        expect(result.stdout).toContain("The user rejected permission");
      },
    ));
});
