import { afterEach, expect, test } from "bun:test";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { Observer } from "../src/contract/observer.js";
import { createObserver } from "../src/telemetry/observer.js";

const observers: Observer[] = [];
const run = {
  id: "u1",
  sessionID: "s1",
  startedAt: 1000,
  parentTool: undefined,
  parentSessionID: undefined,
};
const interaction = {
  run,
  id: "u1",
  startedAt: 1000,
  agentName: "build",
  agentType: undefined,
  parentSessionID: undefined,
  input: undefined,
};

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.shutdown()));
});

function setup(spanAttributes: Record<string, string>) {
  const spans: ReadableSpan[] = [];
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        export(batch, callback) {
          spans.push(...batch);
          callback({ code: ExportResultCode.SUCCESS });
        },
        async shutdown() {},
      }),
    ],
  });
  const observer = createObserver({
    tracerProvider,
    instrumentationScope: { name: "test" },
    captureContent: false,
    now: () => 2000,
    spanAttributes,
  });
  observers.push(observer);

  return { observer, spans };
}

test.each([undefined, "configured-user", "unknown"])(
  "all six span types use only the configured user identity %j",
  async (configuredUserID) => {
    const h = setup({
      ...(configuredUserID ? { "user.id": configuredUserID } : {}),
      "custom.attribute": "retained",
      "session.id": "forged",
      "gen_ai.input.messages": "forged",
    });
    const tool = { interaction, messageID: "a1", callID: "tool1" };

    h.observer.startRun(run);
    h.observer.startInteraction(interaction);
    h.observer.startLlm({
      interaction,
      id: "a1",
      startedAt: 1100,
      providerID: "test",
      providerName: "test",
      model: "model",
      operation: "chat",
      stream: true,
      fallbackInputText: undefined,
      agentType: undefined,
      parentSessionID: undefined,
      compactionID: undefined,
    });
    h.observer.startTool({ ...tool, name: "read", startedAt: 1200 });
    h.observer.startPermission({
      tool,
      requestID: "p1",
      toolName: "read",
      name: "read",
      patterns: ["*"],
      startedAt: 1300,
    });
    h.observer.startCompaction({
      interaction,
      id: "c1",
      startedAt: 1400,
      auto: true,
      overflow: false,
    });
    await h.observer.shutdown();

    expect(h.spans.map((span) => span.name).sort()).toEqual([
      "opencode.compaction",
      "opencode.interaction",
      "opencode.llm",
      "opencode.permission.check",
      "opencode.run",
      "opencode.tool.read",
    ]);
    h.spans.forEach((span) => {
      expect(span.attributes["user.id"]).toBe(configuredUserID);
      expect(span.attributes["session.id"]).toBe("s1");
      expect(span.attributes["custom.attribute"]).toBe("retained");
      expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
      expect(span.resource.attributes["user.id"]).toBeUndefined();
    });
  },
);

test("user.id is an initialization snapshot like other configured span attributes", async () => {
  const attributes = { "user.id": "first", team: "original" };
  const h = setup(attributes);

  h.observer.startRun(run);
  attributes["user.id"] = "second";
  attributes.team = "changed";
  h.observer.startInteraction(interaction);
  await h.observer.shutdown();

  expect(h.spans.map((span) => span.attributes["user.id"])).toEqual(["first", "first"]);
  expect(h.spans.map((span) => span.attributes.team)).toEqual(["original", "original"]);
});
