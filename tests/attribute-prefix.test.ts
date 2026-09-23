import { afterEach, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { Observer } from "../src/contract/observer.js";
import { createObserver, type ObserverOptions } from "../src/telemetry/observer.js";

const observers: Observer[] = [];
const run = {
  id: "u1",
  sessionID: "s1",
  startedAt: 1000,
  parentTool: undefined,
  parentSessionID: undefined,
};

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.shutdown()));
});

function setup(options: Partial<Omit<ObserverOptions, "tracerProvider" | "instrumentationScope">>) {
  const spans: ReadableSpan[] = [];
  const observer = createObserver({
    tracerProvider: new BasicTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor({
          export(batch, callback) {
            spans.push(...batch);
            callback({ code: ExportResultCode.SUCCESS });
          },
          async shutdown() {},
        }),
      ],
    }),
    instrumentationScope: { name: "test" },
    now: () => 2000,
    ...options,
  });
  observers.push(observer);
  return { observer, spans };
}

test.each(
  ["opencode.", "app.", "", "raw"].flatMap((attributePrefix) =>
    [true, false].map((captureContent) => ({ attributePrefix, captureContent })),
  ),
)(
  "all seven span lifecycles use built-in attribute prefix with %j",
  async ({ attributePrefix, captureContent }) => {
    const h = setup({ attributePrefix, captureContent, spanNamePrefix: "spans." });
    const agent = { agentName: "build", agentType: "subagent" as const, parentSessionID: "parent" };
    const interaction = { run, id: "u1", startedAt: 1000, input: "question", ...agent };
    const tool = { interaction, messageID: "a1", callID: "tool1" };
    const skill = { ...tool, callID: "skill1" };
    const permission = { tool, requestID: "p1" };
    const compaction = { interaction, id: "c1" };
    const llm = { interaction, id: "a1" };

    h.observer.startRun({ ...run, parentSessionID: "parent" });
    h.observer.startInteraction(interaction);
    h.observer.startTool({ ...tool, ...agent, name: "read", startedAt: 1100 });
    h.observer.startSkill({ ...skill, ...agent, name: "initial", startedAt: 1100 });
    h.observer.startPermission({
      ...permission,
      ...agent,
      toolName: "read",
      name: "read",
      patterns: ["src/*"],
      startedAt: 1200,
    });
    h.observer.startCompaction({
      ...compaction,
      ...agent,
      startedAt: 1200,
      auto: true,
      overflow: true,
      triggerMessageID: "trigger",
    });
    h.observer.startLlm({
      ...llm,
      ...agent,
      startedAt: 1300,
      providerID: "test",
      providerName: "test",
      model: "model",
      operation: "chat",
      stream: true,
      fallbackInputText: "question",
      compactionID: "c1",
    });
    h.observer.updateLlm({ ...llm, retryCount: 2 });
    h.observer.updateSkill({
      ...skill,
      name: "review",
      directory: "/skills/review",
      outputTruncated: false,
    });
    h.observer.finishLlm({
      ...llm,
      endedAt: 1500,
      fallbackOutputText: "summary",
      cost: 0.25,
      timing: { source: "message", fallbackReason: "fetch-unobserved" },
    });
    h.observer.finishCompaction({
      ...compaction,
      endedAt: 1600,
      promptTokens: 12,
      summaryTokens: 3,
    });
    h.observer.finishPermission({ ...permission, endedAt: 1600, reply: "once" });
    h.observer.finishTool({
      ...tool,
      endedAt: 1700,
      error: { type: "ExecutionError", message: "read failed" },
    });
    h.observer.finishSkill({ ...skill, endedAt: 1700, output: "skill instructions" });
    h.observer.finishInteraction({
      ...interaction,
      endedAt: 1800,
      status: "completed",
      output: "answer",
    });
    h.observer.finishRun({ ...run, endedAt: 1900, output: "answer" });
    await h.observer.flush();

    expect(h.spans.map((span) => span.name).sort()).toEqual([
      "spans.compaction",
      "spans.interaction",
      "spans.llm",
      "spans.permission.check",
      "spans.run",
      "spans.skill.load",
      "spans.tool.read",
    ]);
    const spans = new Map(h.spans.map((span) => [span.name, span]));
    expect(spans.get("spans.run")?.attributes[`${attributePrefix}run.id`]).toBe("u1");
    expect(spans.get("spans.interaction")?.attributes[`${attributePrefix}interaction.id`]).toBe(
      "u1",
    );
    expect(spans.get("spans.llm")?.attributes).toMatchObject({
      [`${attributePrefix}message.id`]: "a1",
      [`${attributePrefix}compaction.id`]: "c1",
      [`${attributePrefix}llm.retry_count`]: 2,
      [`${attributePrefix}llm.cost.total`]: 0.25,
      [`${attributePrefix}llm.timing.source`]: "message",
      [`${attributePrefix}llm.timing.fallback_reason`]: "fetch-unobserved",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "model",
    });
    expect(spans.get("spans.compaction")?.attributes).toMatchObject({
      [`${attributePrefix}compaction.id`]: "c1",
      [`${attributePrefix}compaction.auto`]: true,
      [`${attributePrefix}compaction.overflow`]: true,
      [`${attributePrefix}compaction.trigger_message.id`]: "trigger",
      [`${attributePrefix}compaction.prompt_tokens`]: 12,
      [`${attributePrefix}compaction.summary_tokens`]: 3,
    });
    expect(spans.get("spans.permission.check")?.attributes).toMatchObject({
      [`${attributePrefix}permission.tool.call.id`]: "tool1",
      [`${attributePrefix}permission.tool.name`]: "read",
      [`${attributePrefix}permission.name`]: "read",
      [`${attributePrefix}permission.patterns`]: ["src/*"],
      [`${attributePrefix}permission.reply`]: "once",
      [`${attributePrefix}permission.granted`]: true,
    });
    expect(spans.get("spans.skill.load")?.attributes).toMatchObject({
      [`${attributePrefix}skill.name`]: "review",
      [`${attributePrefix}skill.directory`]: "/skills/review",
      [`${attributePrefix}skill.output.truncated`]: false,
      "ai.agent.skill.name": "review",
      "gen_ai.tool.name": "skill",
      "gen_ai.tool.call.id": "skill1",
    });
    expect(spans.get("spans.skill.load")?.attributes[`${attributePrefix}skill.output`]).toBe(
      captureContent ? "skill instructions" : undefined,
    );
    expect(spans.get("spans.tool.read")?.attributes).toMatchObject({
      "gen_ai.tool.name": "read",
      "error.type": "ExecutionError",
      "exception.message": "read failed",
    });
    expect(spans.get("spans.tool.read")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.get("spans.llm")?.parentSpanContext?.spanId).toBe(
      spans.get("spans.compaction")?.spanContext().spanId,
    );
    expect(spans.get("spans.permission.check")?.parentSpanContext?.spanId).toBe(
      spans.get("spans.tool.read")?.spanContext().spanId,
    );
    h.spans.forEach((span) => {
      expect(span.attributes["session.id"]).toBe("s1");
      expect(span.attributes["gen_ai.conversation.id"]).toBe("s1");
      expect(span.attributes[`${attributePrefix}session.parent_id`]).toBe("parent");
      if (span.name !== "spans.run") {
        expect(span.attributes[`${attributePrefix}agent.type`]).toBe("subagent");
      }
      if (attributePrefix !== "opencode.") {
        expect(Object.keys(span.attributes).some((key) => key.startsWith("opencode."))).toBe(false);
      }
      if (!captureContent) {
        expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
        expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
      }
    });
  },
);

test.each(["app.", "", "raw"])(
  "prefix %j protects both built-in spellings and preserves explicit custom keys",
  async (attributePrefix) => {
    const custom = {
      "opencode.custom.tag": "opencode.literal-value",
      [`${attributePrefix}custom.tag`]: "kept",
      "user.id": "configured-user",
      "tenant.id": "tenant",
    };
    const h = setup({
      attributePrefix,
      captureContent: false,
      spanAttributes: {
        ...custom,
        "session.id": "forged",
        "gen_ai.input.messages": "forged",
        "http.request.header.authorization": "forged",
        "ai.agent.skill.name": "forged",
        "error.type": "forged",
        ...Object.fromEntries(
          ["opencode.", attributePrefix].flatMap((prefix) =>
            [
              "run.id",
              "interaction.id",
              "session.parent_id",
              "agent.type",
              "llm.retry_count",
              "llm.retry_history",
              "provider.id",
              "message.id",
              "compaction.prompt_tokens",
              "permission.reply",
              "tool.output",
              "skill.output",
            ].map((key) => [`${prefix}${key}`, "forged"]),
          ),
        ),
      },
    });

    h.observer.startRun(run);
    h.observer.finishRun({ ...run, endedAt: 1500, output: undefined });
    await h.observer.flush();

    expect(h.spans[0]?.name).toBe("opencode.run");
    expect(h.spans[0]?.attributes).toEqual({
      ...custom,
      "session.id": "s1",
      "gen_ai.conversation.id": "s1",
      "gen_ai.operation.name": "invoke_workflow",
      [`${attributePrefix}run.id`]: "u1",
    });
  },
);

test("attribute prefixes and their protection remain isolated across observer instances", async () => {
  const options = { attributePrefix: "first.", spanAttributes: { "second.run.id": "custom" } };
  const first = setup(options);
  first.observer.startRun(run);
  options.attributePrefix = "second.";
  const second = setup(options);
  second.observer.startRun(run);

  await Promise.all([first.observer.shutdown(), second.observer.shutdown()]);

  expect(first.spans[0]?.attributes).toMatchObject({
    "first.run.id": "u1",
    "second.run.id": "custom",
  });
  expect(second.spans[0]?.attributes["second.run.id"]).toBe("u1");
  expect(second.spans[0]?.attributes["first.run.id"]).toBeUndefined();
});
