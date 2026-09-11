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
  parent: undefined,
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
  const provider = new BasicTracerProvider({
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
    provider,
    scope: { name: "test" },
    captureContent: false,
    now: () => 2000,
    spanAttributes,
  });
  observers.push(observer);

  return { observer, spans };
}

test.each(
  ["configured-user", "unknown"].flatMap((configuredUserID) =>
    [undefined, "", "explicit-user"].map((userID) => ({ configuredUserID, userID })),
  ),
)(
  "all six span types preserve $configuredUserID with contract identity $userID",
  async ({ configuredUserID, userID }) => {
    const h = setup({
      "user.id": configuredUserID,
      "custom.attribute": "retained",
      "session.id": "forged",
      "gen_ai.input.messages": "forged",
    });
    const tool = { interaction, messageID: "a1", callID: "tool1" };

    h.observer.startRun({ ...run, userID });
    h.observer.startInteraction({ ...interaction, userID });
    h.observer.startLlm({
      interaction,
      id: "a1",
      startedAt: 1100,
      providerID: "test",
      providerName: "test",
      model: "model",
      operation: "chat",
      stream: true,
      input: undefined,
      agentType: undefined,
      parentSessionID: undefined,
      compactionID: undefined,
      userID,
    });
    h.observer.startTool({ ...tool, name: "read", startedAt: 1200, userID });
    h.observer.startPermission({
      tool,
      requestID: "p1",
      toolName: "read",
      name: "read",
      patterns: ["*"],
      startedAt: 1300,
      userID,
    });
    h.observer.startCompaction({
      interaction,
      id: "c1",
      startedAt: 1400,
      auto: true,
      overflow: false,
      userID,
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
      expect(span.attributes["user.id"]).toBe(userID || configuredUserID);
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
