import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage, Part, Session, ToolPart, UserMessage } from "@opencode-ai/sdk";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { createCoordinatorHarness } from "./support/coordinator.js";
import { createObserver } from "../src/telemetry/observer.js";
import type { ToolStart } from "../src/contract/observer.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function setup(captureContent = true) {
  const spans: ReadableSpan[] = [];
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        export(batch, callback) {
          spans.push(...batch);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: async () => {},
      }),
    ],
  });
  const observer = createObserver({
    provider,
    scope: { name: "test" },
    captureContent,
    now: () => 9000,
    spanAttributes: {
      "opencode.permission.granted": "fake",
      "opencode.compaction.auto": "fake",
      "gen_ai.tool.call.result": "fake",
    },
  });
  const coordinator = createCoordinatorHarness({ observer, captureContent, now: () => 1100 });
  cleanups.push(coordinator.hooks.dispose);

  return {
    observer,
    coordinator,
    spans,
    async session(id = "s1", parentID?: string) {
      const info: Session = {
        id,
        projectID: "project",
        directory: "/test",
        title: "test",
        version: "1",
        parentID,
        time: { created: 900, updated: 900 },
      };
      await coordinator.event({ type: "session.created", properties: { info } }, 900);
    },
    async user(info = user()) {
      await coordinator.message(info, [
        {
          id: info.id + "-text",
          messageID: info.id,
          sessionID: info.sessionID,
          type: "text",
          text: "question",
        },
      ]);
    },
    async message(info: AssistantMessage | UserMessage, time = 1200) {
      await coordinator.event({ type: "message.updated", properties: { info } }, time);
    },
    async part(part: Part, time = 1200) {
      await coordinator.event({ type: "message.part.updated", properties: { part } }, time);
    },
    async idle(sessionID = "s1", time = 2000) {
      await coordinator.event({ type: "session.idle", properties: { sessionID } }, time);
    },
    async ask(id = "p1", messageID = "a1", callID = "call1", sessionID = "s1", time = 1250) {
      await coordinator.event(
        {
          type: "permission.asked",
          properties: {
            id,
            sessionID,
            permission: "read",
            patterns: ["src/*"],
            always: [],
            metadata: {},
            tool: { messageID, callID },
          },
        },
        time,
      );
    },
    async reply(reply: "once" | "always" | "reject", id = "p1", sessionID = "s1", time = 1300) {
      await coordinator.event(
        { type: "permission.replied", properties: { sessionID, requestID: id, reply } },
        time,
      );
    },
  };
}

function user(id = "u1", sessionID = "s1", created = 1000): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created },
  };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "a1",
    sessionID: "s1",
    parentID: "u1",
    role: "assistant",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    modelID: "test",
    providerID: "test",
    time: { created: 1100 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function tool(
  state: ToolPart["state"] = { status: "running", input: { path: "a" }, time: { start: 1200 } },
  overrides: Partial<ToolPart> = {},
): ToolPart {
  return {
    type: "tool",
    id: "part1",
    sessionID: "s1",
    messageID: "a1",
    callID: "call1",
    tool: "read",
    state,
    ...overrides,
  };
}

function completed(output = "result", start = 1200, end = 1400): ToolPart["state"] {
  return {
    status: "completed",
    input: { path: "a" },
    output,
    metadata: {},
    title: "read",
    time: { start, end },
  };
}

function step(messageID: string, type: "step-start" | "step-finish", sessionID = "s1"): Part {
  return type === "step-start"
    ? { type, id: messageID + "-start", messageID, sessionID }
    : {
        type,
        id: messageID + "-finish",
        messageID,
        sessionID,
        reason: "stop",
        cost: 0,
        tokens: { input: 10, output: 4, reasoning: 5, cache: { read: 2, write: 3 } },
      };
}

async function marker(h: ReturnType<typeof setup>, id = "c1", time = 1400, overflow = false) {
  await h.message(user(id, "s1", time), time);
  await h.part(
    {
      type: "compaction",
      id: id + "-part",
      messageID: id,
      sessionID: "s1",
      auto: true,
      overflow,
    } as Part,
    time + 10,
  );
}

test("coordinator trackers isolate identical object IDs in concurrent sessions during cleanup", async () => {
  const h = setup();
  for (const sessionID of ["s1", "s2"]) {
    await h.session(sessionID);
    await h.user(user("u1", sessionID));
    await h.message(assistant({ sessionID }));
    await h.part(step("a1", "step-start", sessionID));
    await h.part(tool(undefined, { sessionID }));
    await h.ask("p1", "a1", "call1", sessionID);
    await h.message(user("c1", sessionID, 1400));
    await h.part({ type: "compaction", id: "marker", messageID: "c1", sessionID, auto: true });
    await h.message(assistant({ id: "summary", parentID: "c1", sessionID, summary: true }));
    await h.part(step("summary", "step-start", sessionID));
  }

  await h.reply("reject", "p1", "s1");
  await h.idle("s1");

  expect(h.spans).toHaveLength(7);
  expect(h.spans.every((span) => span.attributes["session.id"] === "s1")).toBe(true);

  await h.reply("once", "p1", "s2");
  await h.part(tool(completed(), { sessionID: "s2" }));
  await h.part(step("summary", "step-finish", "s2"));
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s2" } }, 1800);
  await h.part(step("a1", "step-finish", "s2"));
  await h.message(
    assistant({ sessionID: "s2", time: { created: 1100, completed: 1900 }, finish: "stop" }),
  );
  await h.idle("s2");

  const spans = h.spans.filter((span) => span.attributes["session.id"] === "s2");
  expect(spans).toHaveLength(7);
  expect(spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
  expect(
    spans.find((span) => span.name.endsWith(".permission.check"))?.attributes[
      "opencode.permission.granted"
    ],
  ).toBe(true);
  expect(new Set(h.spans.map((span) => span.spanContext().traceId)).size).toBe(2);
});

test("tool keeps its original interaction across steer and uses source times", async () => {
  const h = setup();
  await h.session();
  await h.user();
  await h.message(assistant());
  await h.part(tool());
  await h.user(user("u2", "s1", 1300));
  await h.part(tool(completed()), 5000);
  await h.part(tool(completed("late")), 6000);
  await h.idle("s1", 7000);
  const span = h.spans.find((value) => value.name === "opencode.tool.read");
  const parent = h.spans.find((value) => value.attributes["opencode.interaction.id"] === "u1");

  expect(span?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  expect(span?.kind).toBe(SpanKind.INTERNAL);
  expect(span?.startTime).toEqual([1, 200_000_000]);
  expect(span?.endTime).toEqual([1, 400_000_000]);
  expect(span?.attributes["gen_ai.tool.call.id"]).toBe("call1");
  expect(span?.attributes["opencode.agent.type"]).toBe("primary");
  expect(span?.attributes["gen_ai.operation.name"]).toBe("execute_tool");
  expect(span?.attributes["gen_ai.tool.call.arguments"]).toBe('{"path":"a"}');
  expect(span?.attributes["gen_ai.tool.call.result"]).toBe('{"content":"result"}');
  expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  expect(h.spans.filter((value) => value.name === span?.name)).toHaveLength(1);
  expect(h.spans.some((value) => value.name === "opencode.llm")).toBe(false);
});

test.each([
  ['{"ok":true}', { ok: true }],
  ["[1,2]", { content: "[1,2]" }],
  ["null", { content: "null" }],
  ["", { content: "" }],
])(
  "terminal tool snapshots backfill a missing running event and encode result %s",
  async (output, expected) => {
    const h = setup();
    await h.user();
    await h.part(tool(completed(output)));
    expect(h.spans).toHaveLength(0);
    await h.part(tool({ status: "running", input: { path: "stale" }, time: { start: 1200 } }));
    await h.message(assistant());

    expect(h.spans).toHaveLength(1);
    expect(JSON.parse(String(h.spans[0]?.attributes["gen_ai.tool.call.result"]))).toEqual(expected);
    expect(h.spans[0]?.startTime).toEqual([1, 200_000_000]);
    expect(h.spans[0]?.attributes["gen_ai.tool.call.arguments"]).toBe('{"path":"a"}');
  },
);

test("permission rejection ends normally and classifies only the precisely associated failed tool", async () => {
  const h = setup();
  await h.session();
  await h.user();
  await h.message(assistant());
  await h.part(tool());
  await h.ask("wrong", "other");
  await h.ask();
  await h.ask();
  await h.reply("reject");
  await h.reply("always");
  await h.part(
    tool({ status: "error", input: {}, error: "denied", time: { start: 1200, end: 1400 } }),
  );
  await h.part(
    tool(
      { status: "error", input: {}, error: "failed", time: { start: 1200, end: 1500 } },
      { callID: "call2", id: "part2" },
    ),
  );
  const permission = h.spans.find((value) => value.name === "opencode.permission.check");
  const rejected = h.spans.find(
    (value) =>
      value.name === "opencode.tool.read" && value.attributes["gen_ai.tool.call.id"] === "call1",
  );
  const other = h.spans.find((value) => value.attributes["gen_ai.tool.call.id"] === "call2");

  expect(h.spans.filter((value) => value.name === "opencode.permission.check")).toHaveLength(1);
  expect(permission?.parentSpanContext?.spanId).toBe(rejected?.spanContext().spanId);
  expect(permission?.attributes["opencode.permission.granted"]).toBe(false);
  expect(permission?.attributes["opencode.permission.reply"]).toBe("reject");
  expect(permission?.attributes["opencode.permission.patterns"]).toEqual(["src/*"]);
  expect(permission?.attributes["gen_ai.operation.name"]).toBeUndefined();
  expect(permission?.status.code).toBe(SpanStatusCode.UNSET);
  expect(rejected?.attributes["error.type"]).toBe("PermissionRejectedError");
  expect(rejected?.attributes["gen_ai.tool.call.result"]).toBeUndefined();
  expect(rejected?.status.message).toBe("denied");
  expect(other?.attributes["error.type"]).toBe("ExecutionError");
});

test("tool completion closes unanswered permissions before the tool and ignores later replies", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.ask("early");
  await h.part(tool());
  await h.reply("once", "out-of-order");
  await h.ask("out-of-order");
  await h.ask();
  await h.part(tool(completed()), 1500);
  await h.reply("once");
  await h.ask();
  await h.ask("after");

  expect(h.spans.map((value) => value.name)).toEqual([
    "opencode.permission.check",
    "opencode.tool.read",
  ]);
  expect(h.spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(h.spans[0]?.endTime).toEqual([1, 500_000_000]);
  expect(h.spans[1]?.endTime).toEqual([1, 400_000_000]);
  expect(h.spans[0]?.attributes["opencode.permission.granted"]).toBeUndefined();
  expect(h.spans[1]?.status.code).toBe(SpanStatusCode.UNSET);
});

test("permission capacity eviction ends the oldest wait with an error and keeps replies correlated", async () => {
  const h = setup(false);
  await h.user();
  await h.message(assistant());
  await h.part(tool());
  await Promise.all(Array.from({ length: 1025 }, (_, index) => h.ask("p" + index)));
  await h.reply("always", "p1024");

  expect(h.spans).toHaveLength(2);
  expect(h.spans[0]?.status.message).toBe("permission correlation capacity exceeded");
  expect(h.spans[1]?.attributes["opencode.permission.granted"]).toBe(true);
});

test("compaction owns its summary LLM and only completed summary usage is mirrored", async () => {
  const h = setup();
  await h.session();
  await h.user();
  await marker(h);
  const summary = assistant({
    id: "summary",
    parentID: "c1",
    mode: "compaction",
    summary: true,
    time: { created: 1500 },
  });
  await h.message(summary, 1500);
  await h.part(step("summary", "step-start"), 1500);
  await h.part(
    { id: "summary-text", sessionID: "s1", messageID: "summary", type: "text", text: "summary" },
    1600,
  );
  await h.part(step("summary", "step-finish"), 1700);
  await h.message(
    {
      ...summary,
      time: { created: 1500, completed: 1700 },
      tokens: { input: 10, output: 4, reasoning: 5, cache: { read: 2, write: 3 } },
    },
    1700,
  );
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1800);
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1850);
  await h.message(
    assistant({ id: "final", time: { created: 1900, completed: 1950 }, finish: "stop" }),
    1950,
  );
  await h.part(
    { id: "final-text", sessionID: "s1", messageID: "final", type: "text", text: "answer" },
    1950,
  );
  await h.idle();
  const compaction = h.spans.find((value) => value.name === "opencode.compaction");
  const llm = h.spans.find((value) => value.name === "opencode.llm");
  const run = h.spans.find((value) => value.name === "opencode.run");

  expect(llm?.parentSpanContext?.spanId).toBe(compaction?.spanContext().spanId);
  expect(llm?.attributes["opencode.compaction.id"]).toBe("c1");
  expect(llm?.attributes["gen_ai.usage.output_tokens"]).toBe(9);
  expect(compaction?.startTime).toEqual([1, 400_000_000]);
  expect(compaction?.endTime).toEqual([1, 800_000_000]);
  expect(compaction?.attributes["opencode.compaction.prompt_tokens"]).toBe(15);
  expect(compaction?.attributes["opencode.compaction.summary_tokens"]).toBe(4);
  expect(compaction?.attributes["gen_ai.usage.input_tokens"]).toBe(15);
  expect(compaction?.attributes["gen_ai.usage.output_tokens"]).toBe(9);
  expect(compaction?.attributes["opencode.compaction.overflow"]).toBe(false);
  expect(compaction?.attributes["gen_ai.operation.name"]).toBeUndefined();
  expect(compaction?.status.code).toBe(SpanStatusCode.UNSET);
  expect(String(run?.attributes["gen_ai.output.messages"])).toContain("answer");
  expect(String(run?.attributes["gen_ai.output.messages"])).not.toContain("summary");
});

test("coordinator resolves a completed summary after delayed compaction evidence", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant({ id: "summary", parentID: "c1", summary: true }), 1500);
  await h.part(step("summary", "step-start"), 1500);
  await h.part(step("summary", "step-finish"), 1700);
  expect(h.spans).toHaveLength(0);

  await h.message(user("c1", "s1", 1400), 1800);
  await h.part(
    { type: "compaction", id: "marker", messageID: "c1", sessionID: "s1", auto: true },
    1810,
  );
  expect(h.spans).toHaveLength(1);
  const summary = h.spans[0];
  expect(summary?.name).toBe("opencode.llm");
  expect(summary?.startTime).toEqual([1, 500_000_000]);
  expect(summary?.endTime).toEqual([1, 700_000_000]);

  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1900);
  await h.idle();
  const compaction = h.spans.find((span) => span.name === "opencode.compaction");
  expect(summary?.parentSpanContext?.spanId).toBe(compaction?.spanContext().spanId);
  expect(h.spans.filter((span) => span.name === "opencode.llm")).toHaveLength(1);
});

test.each([
  {
    name: "zero counts",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    input: 0,
    output: 0,
    summary: 0,
  },
  {
    name: "invalid counts",
    tokens: {
      input: Number.NaN,
      output: -1,
      reasoning: 0,
      cache: { read: 0, write: Number.POSITIVE_INFINITY },
    },
    input: undefined,
    output: undefined,
    summary: undefined,
  },
  {
    name: "fractional counts",
    tokens: { input: 1.5, output: 1, reasoning: 0.5, cache: { read: 0, write: 0 } },
    input: undefined,
    output: undefined,
    summary: 1,
  },
  {
    name: "unsafe totals",
    tokens: {
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
      reasoning: 1,
      cache: { read: 1, write: 0 },
    },
    input: undefined,
    output: undefined,
    summary: Number.MAX_SAFE_INTEGER,
  },
])("LLM and compaction preserve the same usage limits for $name", async (scenario) => {
  const h = setup();
  await h.user();
  await marker(h);
  const summary = assistant({
    id: "summary",
    parentID: "c1",
    mode: "compaction",
    summary: true,
    time: { created: 1500 },
  });
  await h.message(summary, 1500);
  await h.part(step("summary", "step-start"), 1500);

  await h.part(
    {
      type: "step-finish",
      id: "summary-finish",
      messageID: "summary",
      sessionID: "s1",
      reason: "stop",
      cost: 0,
      tokens: scenario.tokens,
    },
    1700,
  );
  await h.message(
    { ...summary, time: { created: 1500, completed: 1700 }, tokens: scenario.tokens },
    1700,
  );
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1800);
  const llm = h.spans.find((value) => value.name === "opencode.llm");
  const compaction = h.spans.find((value) => value.name === "opencode.compaction");

  expect(llm).toBeDefined();
  expect(compaction).toBeDefined();
  expect(llm?.attributes["gen_ai.usage.input_tokens"]).toBe(scenario.input);
  expect(compaction?.attributes["gen_ai.usage.input_tokens"]).toBe(scenario.input);
  expect(llm?.attributes["gen_ai.usage.output_tokens"]).toBe(scenario.output);
  expect(compaction?.attributes["gen_ai.usage.output_tokens"]).toBe(scenario.output);
  expect(compaction?.attributes["opencode.compaction.prompt_tokens"]).toBe(scenario.input);
  expect(compaction?.attributes["opencode.compaction.summary_tokens"]).toBe(scenario.summary);
});

test("overflow compaction retains the triggering interaction across steer", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.part(step("a1", "step-start"), 1100);
  await h.coordinator.event(
    {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "ContextOverflowError", data: { message: "overflow" } },
      },
    },
    1200,
  );
  await h.user(user("u2", "s1", 1300));
  await marker(h, "c1", 1400, true);
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1500);
  await h.idle();
  const compaction = h.spans.find((value) => value.name === "opencode.compaction");
  const owner = h.spans.find((value) => value.attributes["opencode.interaction.id"] === "u1");

  expect(compaction?.parentSpanContext?.spanId).toBe(owner?.spanContext().spanId);
  expect(compaction?.attributes["opencode.compaction.trigger_message.id"]).toBe("a1");
  expect(compaction?.attributes["opencode.compaction.overflow"]).toBe(true);
  expect(compaction?.attributes["opencode.compaction.prompt_tokens"]).toBeUndefined();
  expect(h.spans.find((value) => value.name === "opencode.run")?.status.code).toBe(
    SpanStatusCode.UNSET,
  );
});

test("replacing compaction ends its unfinished summary first and duplicate markers cannot replace the new one", async () => {
  const h = setup();
  await h.user();
  await marker(h);
  await h.message(assistant({ id: "summary", parentID: "c1", summary: true }));
  await h.part(step("summary", "step-start"), 1500);
  await marker(h, "c2", 1600);
  await marker(h, "c1", 1700);
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1800);

  expect(h.spans.map((value) => value.name)).toEqual([
    "opencode.llm",
    "opencode.compaction",
    "opencode.compaction",
  ]);
  expect(h.spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(h.spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(h.spans[2]?.status.code).toBe(SpanStatusCode.UNSET);
  expect(h.spans[2]?.attributes["opencode.compaction.id"]).toBe("c2");
});

test("summary failure ends compaction and the run without reporting successful compaction usage", async () => {
  const h = setup();
  await h.user();
  await marker(h);
  await h.message(
    assistant({
      id: "summary",
      parentID: "c1",
      summary: true,
      error: { name: "UnknownError", data: { message: "summary failed" } },
    }),
    1600,
  );
  await h.idle();
  const compaction = h.spans.find((value) => value.name === "opencode.compaction");

  expect(compaction?.status.code).toBe(SpanStatusCode.ERROR);
  expect(compaction?.attributes["opencode.compaction.prompt_tokens"]).toBeUndefined();
  expect(h.spans.filter((value) => value.name === "opencode.run")).toHaveLength(1);
  expect(h.spans.find((value) => value.name === "opencode.run")?.status.code).toBe(
    SpanStatusCode.ERROR,
  );
});

test("foreground task metadata attaches child run and all child spans retain their own session identity", async () => {
  const h = setup();
  await h.session();
  await h.user();
  await h.part(
    tool(
      { status: "running", input: {}, metadata: { sessionId: "s2" }, time: { start: 1200 } },
      { tool: "task" },
    ),
  );
  await h.message(assistant());
  await h.session("s2", "s1");
  await h.user(user("child-input", "s2", 1250));
  await h.message(
    assistant({
      id: "child-assistant",
      sessionID: "s2",
      parentID: "child-input",
      time: { created: 1300, completed: 1450 },
      finish: "stop",
    }),
    1450,
  );
  await h.part(
    tool(completed("child", 1350, 1400), { sessionID: "s2", messageID: "child-assistant" }),
  );
  await h.idle("s2", 1500);
  await h.part(tool(completed("child result", 1200, 1600), { tool: "task" }));
  await h.idle();
  const task = h.spans.find((value) => value.name === "opencode.tool.task");
  const child = h.spans.find(
    (value) => value.name === "opencode.run" && value.attributes["session.id"] === "s2",
  );
  const childSpans = h.spans.filter((value) => value.attributes["session.id"] === "s2");

  expect(child?.parentSpanContext?.spanId).toBe(task?.spanContext().spanId);
  expect(
    childSpans.every((value) => value.spanContext().traceId === task?.spanContext().traceId),
  ).toBe(true);
  expect(childSpans.every((value) => value.attributes["opencode.session.parent_id"] === "s1")).toBe(
    true,
  );
  expect(
    childSpans
      .filter((value) => value.name !== "opencode.run")
      .every((value) => value.attributes["opencode.agent.type"] === "subagent"),
  ).toBe(true);
  expect(h.spans.indexOf(child!)).toBeLessThan(h.spans.indexOf(task!));
  await h.user(user("later-input", "s2", 3000));
  await h.idle("s2", 4000);
  const later = h.spans.find((value) => value.attributes["opencode.run.id"] === "later-input");

  expect(later?.parentSpanContext).toBeUndefined();
  expect(later?.spanContext().traceId).not.toBe(task?.spanContext().traceId);
});

test("shutdown closes nested permissions, tools and child runs before their parent task exactly once", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.part(
    tool(
      { status: "running", input: {}, metadata: { sessionId: "s2" }, time: { start: 1200 } },
      { tool: "task" },
    ),
  );
  await h.user(user("child-input", "s2", 1300));
  await h.message(assistant({ id: "child-assistant", sessionID: "s2", parentID: "child-input" }));
  await h.part(tool(undefined, { sessionID: "s2", messageID: "child-assistant" }));
  await h.ask("child-permission", "child-assistant", "call1", "s2");
  await h.coordinator.hooks.dispose();
  await h.coordinator.hooks.dispose();

  expect(h.spans.map((value) => value.name)).toEqual([
    "opencode.permission.check",
    "opencode.tool.read",
    "opencode.interaction",
    "opencode.run",
    "opencode.tool.task",
    "opencode.interaction",
    "opencode.run",
  ]);
  expect(h.spans.every((value) => value.status.code === SpanStatusCode.ERROR)).toBe(true);
  expect(h.spans.every((value) => value.endTime[0] === 9)).toBe(true);
});

test("legacy permission replies pair with the same request and preserve the human decision", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.part(tool());
  await h.ask();
  await h.coordinator.event(
    {
      type: "permission.replied",
      properties: { sessionID: "s1", permissionID: "p1", response: "always" },
    },
    1500,
  );

  expect(h.spans).toHaveLength(1);
  expect(h.spans[0]?.attributes["opencode.permission.reply"]).toBe("always");
  expect(h.spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
});

test("background task metadata does not create a foreground child-run binding", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.part(
    tool(
      {
        status: "running",
        input: {},
        metadata: { sessionId: "s2", background: true },
        time: { start: 1200 },
      },
      { tool: "task" },
    ),
  );
  await h.session("s2", "s1");
  await h.user(user("child-input", "s2", 1300));
  await h.part(tool(completed("background started"), { tool: "task" }), 1500);

  expect(h.spans.some((span) => span.name === "opencode.run")).toBe(false);
  await h.idle("s2", 1700);
  const child = h.spans.find((span) => span.name === "opencode.run");
  const task = h.spans.find((span) => span.name === "opencode.tool.task");

  expect(child?.parentSpanContext).toBeUndefined();
  expect(child?.spanContext().traceId).not.toBe(task?.spanContext().traceId);
  expect(child?.attributes["opencode.session.parent_id"]).toBe("s1");
});

test("a direct task finish cleans only its child run before ending the task", async () => {
  const h = setup();
  await h.user();
  await h.message(assistant());
  await h.part(
    tool(
      { status: "running", input: {}, metadata: { sessionId: "s2" }, time: { start: 1200 } },
      { tool: "task" },
    ),
  );
  await h.user(user("child-input", "s2", 1300));
  await h.user(user("unrelated-input", "s3", 1300));
  h.observer.finishTool({
    interaction: { run: { sessionID: "s1", id: "u1" }, id: "u1" },
    messageID: "a1",
    callID: "call1",
    endedAt: 1500,
    output: "done",
  });

  expect(h.spans.map((span) => span.name)).toEqual([
    "opencode.interaction",
    "opencode.run",
    "opencode.tool.task",
  ]);
  expect(h.spans[1]?.attributes["session.id"]).toBe("s2");
  expect(h.spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(h.spans[2]?.status.code).toBe(SpanStatusCode.UNSET);
});

test("disabled tool capture never accesses body getters and permission patterns remain operational metadata", async () => {
  const h = setup(false);
  await h.user();
  await h.message(assistant());
  const state = completed();
  Object.defineProperty(state, "input", {
    get() {
      throw new Error("input read");
    },
  });
  Object.defineProperty(state, "output", {
    get() {
      throw new Error("output read");
    },
  });
  await h.part(tool());
  await h.ask();
  await h.reply("once");
  await h.part(tool(state));

  expect(
    h.spans.every(
      (value) =>
        value.attributes["gen_ai.tool.call.arguments"] === undefined &&
        value.attributes["gen_ai.tool.call.result"] === undefined,
    ),
  ).toBe(true);
  expect(h.spans[0]?.attributes["opencode.permission.patterns"]).toEqual(["src/*"]);
  expect(h.spans[0]?.attributes["opencode.permission.granted"]).toBe(true);
});

test("direct contract rejects unknown parents and cannot use an ordinary tool as a child run parent", async () => {
  const h = setup();
  const interaction = { run: { id: "u1", sessionID: "s1" }, id: "u1" };
  const start: ToolStart = {
    interaction,
    callID: "call1",
    messageID: "a1",
    name: "read",
    startedAt: 1200,
  };
  h.observer.startTool(start);
  h.observer.startPermission({
    tool: start,
    requestID: "p1",
    startedAt: 1200,
    name: "read",
    toolName: "read",
    patterns: [],
  });
  await h.user();
  h.observer.startTool(start);
  h.observer.startRun({
    sessionID: "child",
    id: "child",
    startedAt: 1300,
    parent: start,
    parentSessionID: "s1",
  });
  h.observer.finishTool({ ...start, endedAt: 1400 });
  h.observer.startPermission({
    tool: start,
    requestID: "late",
    startedAt: 1500,
    name: "read",
    toolName: "read",
    patterns: [],
  });
  await h.coordinator.hooks.dispose();

  expect(h.spans.filter((value) => value.name === "opencode.tool.read")).toHaveLength(1);
  expect(h.spans.filter((value) => value.name === "opencode.permission.check")).toHaveLength(0);
  expect(h.spans.some((value) => value.attributes["session.id"] === "child")).toBe(false);
});
