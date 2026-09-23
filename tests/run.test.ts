import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage, Part, TextPart, UserMessage } from "@opencode-ai/sdk";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { CoordinatorOptions } from "../src/adapter/opencode/coordinator.js";
import { createCoordinatorHarness } from "./support/coordinator.js";
import { createObserver, type ObserverOptions } from "../src/telemetry/observer.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function setup(
  options: Partial<
    Omit<CoordinatorOptions, "observer"> &
      Omit<ObserverOptions, "tracerProvider" | "instrumentationScope">
  > = {},
) {
  const spans: ReadableSpan[] = [];
  const tracerProvider = new BasicTracerProvider({
    spanLimits: { attributeCountLimit: 4096 },
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
    tracerProvider,
    instrumentationScope: { name: "test" },
    captureContent: true,
    now: () => 2000,
    ...options,
  });

  const coordinator = createCoordinatorHarness({
    observer,
    captureContent: true,
    now: () => 2000,
    ...options,
  });
  cleanups.push(coordinator.hooks.dispose);

  return {
    coordinator,
    async spans() {
      await observer.flush();
      return spans.filter((span) => span.attributes["gen_ai.operation.name"] === "invoke_workflow");
    },
  };
}

function user(id = "u1", created = 1000, sessionID = "s1"): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  };
}

function text(messageID: string, content: string, sessionID = "s1"): TextPart {
  return { id: `${messageID}-text`, messageID, sessionID, type: "text", text: content };
}

function assistant(
  id = "a1",
  parentID = "u1",
  created = 1100,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id,
    parentID,
    sessionID: "s1",
    role: "assistant",
    time: { created, completed: created + 50 },
    modelID: "test",
    providerID: "test",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...overrides,
  };
}

async function reply(
  coordinator: ReturnType<typeof createCoordinatorHarness>,
  info = assistant(),
  content = "answer",
) {
  await coordinator.event({
    type: "message.part.updated",
    properties: { part: text(info.id, content, info.sessionID) },
  });
  await coordinator.event({ type: "message.updated", properties: { info } });
}

async function idle(coordinator: ReturnType<typeof createCoordinatorHarness>, sessionID = "s1") {
  await coordinator.event({
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  });
}

async function overflow(coordinator: ReturnType<typeof createCoordinatorHarness>) {
  await coordinator.event({
    type: "session.error",
    properties: {
      sessionID: "s1",
      error: { name: "ContextOverflowError", data: { message: "context full" } },
    },
  });
}

async function compact(coordinator: ReturnType<typeof createCoordinatorHarness>) {
  await coordinator.event({ type: "message.updated", properties: { info: user("compact", 1200) } });
  await coordinator.event({
    type: "message.part.updated",
    properties: {
      part: {
        id: "compaction-part",
        sessionID: "s1",
        messageID: "compact",
        type: "compaction",
        auto: true,
      },
    },
  });
}

test("run records workflow identity, real input, final output, and UNSET status", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);

  expect(await h.spans()).toHaveLength(0);

  await reply(h.coordinator);
  await idle(h.coordinator);
  await h.coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } });

  const spans = await h.spans();

  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({
    name: "opencode.run",
    kind: SpanKind.INTERNAL,
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes: {
      "session.id": "s1",
      "gen_ai.conversation.id": "s1",
      "opencode.run.id": "u1",
      "gen_ai.operation.name": "invoke_workflow",
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "question" }] },
      ]),
      "gen_ai.output.messages": JSON.stringify([
        { role: "assistant", parts: [{ type: "text", content: "answer" }] },
      ]),
    },
  });
  expect(spans[0]?.parentSpanContext).toBeUndefined();
});

test("steers share a run and late output from the old owner never replaces the final answer", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "first")]);
  await h.coordinator.message(user(), [text("u1", "duplicate hook")]);
  await reply(h.coordinator, assistant(), "intermediate");

  await h.coordinator.message(user("u2", 1300), [text("u2", "steer")]);
  await reply(h.coordinator, assistant("a2", "u2", 1400), "final");

  await reply(
    h.coordinator,
    assistant("a1", "u1", 1100, { time: { created: 1100, completed: 1900 } }),
    "late old answer",
  );
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans).toHaveLength(1);
  expect(JSON.parse(String(spans[0]?.attributes["gen_ai.input.messages"]))).toEqual([
    { role: "user", parts: [{ type: "text", content: "first" }] },
    { role: "user", parts: [{ type: "text", content: "steer" }] },
  ]);
  expect(String(spans[0]?.attributes["gen_ai.output.messages"])).toContain("final");
  expect(String(spans[0]?.attributes["gen_ai.output.messages"])).not.toContain("late");
});

test("new tasks create independent traces while concurrent sessions remain isolated", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "one")]);
  await h.coordinator.message(user("child", 1050, "s2"), [text("child", "two", "s2")]);

  for (const type of ["session.created", "session.updated"] as const) {
    await h.coordinator.event({
      type,
      properties: {
        info: {
          id: "s2",
          parentID: "s1",
          projectID: "project",
          directory: "/test",
          title: "child",
          version: "1.18.30",
          time: { created: 1050, updated: 1100 },
        },
      },
    });
  }

  await idle(h.coordinator);

  expect(await h.spans()).toHaveLength(1);

  await h.coordinator.message(user("u2", 1300), [text("u2", "three")]);
  await idle(h.coordinator, "s2");
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans.map((span) => span.attributes["opencode.run.id"])).toEqual(["u1", "child", "u2"]);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(3);
  expect(spans[1]?.attributes["opencode.session.parent_id"]).toBeUndefined();
  expect(spans[1]?.attributes["session.id"]).toBe("s2");
});

test("synthetic and compaction-only messages never create runs; mixed input keeps real text", async () => {
  const h = setup();
  const synthetic: Part = {
    ...text("u1", "continue"),
    type: "text",
    text: "continue",
    synthetic: true,
  };

  await h.coordinator.message(user(), [synthetic]);
  await h.coordinator.message(user(), [
    { id: "c", messageID: "u1", sessionID: "s1", type: "compaction", auto: true },
  ]);

  expect(await h.spans()).toHaveLength(0);

  await h.coordinator.message(user(), [synthetic, { ...text("u1", "actual"), id: "real" }]);
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans).toHaveLength(1);
  expect(String(spans[0]?.attributes["gen_ai.input.messages"])).toContain("actual");
  expect(String(spans[0]?.attributes["gen_ai.input.messages"])).not.toContain("continue");
});

test("missing input is omitted instead of exporting partial input or fabricating empty text", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "known")]);
  await h.coordinator.message(user("u2", 1300), [
    {
      id: "f",
      messageID: "u2",
      sessionID: "s1",
      type: "file",
      mime: "image/png",
      url: "https://example.test/image.png",
    },
  ]);
  await idle(h.coordinator);

  expect((await h.spans())[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
});

test("disabled content capture omits both bodies and cannot be bypassed with custom attributes", async () => {
  const h = setup({
    captureContent: false,
    spanAttributes: { "gen_ai.input.messages": "leak", "gen_ai.output.messages": "leak" },
  });

  await h.coordinator.message(user(), [text("u1", "secret")]);
  await reply(h.coordinator);
  await idle(h.coordinator);

  const span = (await h.spans())[0];

  expect(span?.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(span?.attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("known empty output is represented as text, unknown output is omitted", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "")]);
  await reply(h.coordinator, assistant(), "");
  await idle(h.coordinator);

  await h.coordinator.message(user("u2", 1300), [text("u2", "next")]);
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans[0]?.attributes["gen_ai.output.messages"]).toBe(
    '[{"role":"assistant","parts":[{"type":"text","content":""}]}]',
  );
  expect(spans[1]?.attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("the latest unfinished assistant cannot fall back to a previous answer", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await reply(h.coordinator);
  await reply(
    h.coordinator,
    assistant("a2", "u1", 1500, { time: { created: 1500 } }),
    "unfinished",
  );
  await idle(h.coordinator);

  expect((await h.spans())[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("text updates replace snapshots instead of appending deltas; removed parts are excluded", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await reply(h.coordinator, assistant(), "hel");
  await h.coordinator.event({
    type: "message.part.updated",
    properties: { part: text("a1", "hello"), delta: "lo" },
  });
  await h.coordinator.event({
    type: "message.part.updated",
    properties: { part: { ...text("a1", "remove"), id: "removed" } },
  });
  await h.coordinator.event({
    type: "message.part.removed",
    properties: { sessionID: "s1", messageID: "a1", partID: "removed" },
  });
  await idle(h.coordinator);

  expect((await h.spans())[0]?.attributes["gen_ai.output.messages"]).toBe(
    '[{"role":"assistant","parts":[{"type":"text","content":"hello"}]}]',
  );
});

test("overflow survives retry, compaction and synthetic continuation, then succeeds", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await overflow(h.coordinator);
  await h.coordinator.event({
    type: "session.status",
    properties: {
      sessionID: "s1",
      status: { type: "retry", attempt: 1, next: 1200, message: "retry" },
    },
  });

  expect(await h.spans()).toHaveLength(0);

  await compact(h.coordinator);
  await reply(
    h.coordinator,
    assistant("summary", "compact", 1250, { summary: true }),
    "internal summary",
  );
  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } });

  await h.coordinator.event({
    type: "message.updated",
    properties: { info: user("continue", 1400) },
  });
  await h.coordinator.event({
    type: "message.part.updated",
    properties: {
      part: { ...text("continue", "continue"), type: "text", text: "continue", synthetic: true },
    },
  });
  await reply(h.coordinator, assistant("a2", "continue", 1500), "recovered answer");
  await idle(h.coordinator);

  const span = (await h.spans())[0];

  expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  expect(span?.attributes["error.type"]).toBeUndefined();
  expect(String(span?.attributes["gen_ai.output.messages"])).toContain("recovered answer");
  expect(String(span?.attributes["gen_ai.input.messages"])).not.toContain("continue");
});

test("late synthetic continuation keeps its pre-steer owner", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "first")]);
  await h.coordinator.message(user("u2", 1500), [text("u2", "second")]);
  await h.coordinator.event({
    type: "message.updated",
    properties: { info: user("continue", 1400) },
  });
  await reply(h.coordinator, assistant("new", "u2", 1600), "new answer");
  await reply(h.coordinator, assistant("old", "continue", 1800), "old answer");
  await idle(h.coordinator);

  expect(String((await h.spans())[0]?.attributes["gen_ai.output.messages"])).toContain(
    "new answer",
  );
});

test("overflow still pending at idle fails without successful output", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await reply(h.coordinator);
  await overflow(h.coordinator);
  await idle(h.coordinator);

  const span = (await h.spans())[0];

  expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "context full" });
  expect(span?.attributes["error.type"]).toBe("ContextOverflowError");
  expect(span?.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(span?.attributes["status.message"]).toBeUndefined();
});

test("another overflow during compaction fails immediately", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await overflow(h.coordinator);
  await compact(h.coordinator);
  await overflow(h.coordinator);

  expect(await h.spans()).toHaveLength(1);
  expect((await h.spans())[0]?.status.code).toBe(SpanStatusCode.ERROR);

  await h.coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } });
  await idle(h.coordinator);

  expect(await h.spans()).toHaveLength(1);
});

test("summary failure terminates the run even without a second session.error", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await compact(h.coordinator);
  await reply(
    h.coordinator,
    assistant("summary", "compact", 1300, {
      summary: true,
      error: { name: "UnknownError", data: { message: "summary failed" } },
    }),
  );

  expect((await h.spans())[0]?.status).toEqual({
    code: SpanStatusCode.ERROR,
    message: "summary failed",
  });
});

test("terminal errors end once and late events cannot recreate or mutate a run", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);

  const error = {
    type: "session.error" as const,
    properties: {
      sessionID: "s1",
      error: { name: "MessageAbortedError", data: { message: "cancelled" } },
    },
  };

  await h.coordinator.event(error);
  await h.coordinator.event(error);
  await reply(h.coordinator);
  await h.coordinator.event({ type: "message.updated", properties: { info: user() } });
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans).toHaveLength(1);
  expect(spans[0]?.attributes["error.type"]).toBe("MessageAbortedError");
  expect(spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("errors without a session do not affect runs; unknown error types use _OTHER", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await h.coordinator.event({ type: "session.error", properties: { error: "unrelated" } });

  expect(await h.spans()).toHaveLength(0);

  await h.coordinator.event({
    type: "session.error",
    properties: { sessionID: "s1", error: { message: "unclassified" } },
  });

  expect((await h.spans())[0]?.attributes["error.type"]).toBe("_OTHER");
  expect((await h.spans())[0]?.status.message).toBe("unclassified");
});

test.each([
  { error: undefined, type: "_OTHER", message: "Operation failed: no error message provided" },
  {
    error: { name: "MessageOutputLengthError", data: {} },
    type: "MessageOutputLengthError",
    message: "MessageOutputLengthError: no error message provided",
  },
  {
    error: { name: "APIError", data: {}, message: "connection failed" },
    type: "APIError",
    message: "connection failed",
  },
])("session errors export source details or a fallback: %j", async ({ error, type, message }) => {
  const h = setup({ captureContent: false });
  await h.coordinator.message(user(), [text("u1", "question")]);

  await h.coordinator.event({ type: "session.error", properties: { sessionID: "s1", error } });

  const spans = await h.spans();
  expect(spans).toHaveLength(1);
  expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR, message });
  expect(spans[0]?.attributes).toMatchObject({ "error.type": type, "exception.message": message });
});

test("custom attributes allow user.id but cannot override other derived or error attributes", async () => {
  const h = setup({
    spanNamePrefix: "custom.",
    spanAttributes: {
      "tenant.id": "test",
      "session.id": "fake",
      "opencode.session.parent_id": "fake",
      "opencode.run.id": "fake",
      "error.type": "fake",
      "gen_ai.operation.name": "fake",
      "user.id": "configured-user",
      "openinference.span.kind": "CHAIN",
    },
  });

  await h.coordinator.message(user(), [text("u1", "question")]);
  await idle(h.coordinator);

  const span = (await h.spans())[0];

  expect(span?.name).toBe("custom.run");
  expect(span?.attributes).toMatchObject({
    "tenant.id": "test",
    "session.id": "s1",
    "opencode.run.id": "u1",
    "gen_ai.operation.name": "invoke_workflow",
  });
  expect(span?.attributes["user.id"]).toBe("configured-user");
  expect(span?.attributes["opencode.session.parent_id"]).toBeUndefined();
  expect(span?.attributes["error.type"]).toBeUndefined();
  expect(span?.attributes["openinference.span.kind"]).toBeUndefined();
});

test("dispose exports an unfinished run once and ignores later events", async () => {
  const h = setup();

  await h.coordinator.message(user(), [text("u1", "question")]);
  await h.coordinator.hooks.dispose();
  await h.coordinator.hooks.dispose();
  await h.coordinator.message(user("u2", 1500), [text("u2", "ignored")]);
  await idle(h.coordinator);

  const spans = await h.spans();

  expect(spans).toHaveLength(1);
  expect(spans[0]?.attributes["opencode.run.id"]).toBe("u1");
  expect(spans[0]?.endTime).toEqual([2, 0]);
  expect(spans[0]?.status).toEqual({
    code: SpanStatusCode.ERROR,
    message: "plugin disposed before run completed",
  });
});

test("idle uses the event observation time even when processing is delayed", async () => {
  const clock = { time: 1000 };
  const h = setup({ now: () => clock.time });

  await h.coordinator.message(user(), [text("u1", "question")]);
  clock.time = 2000;
  const idle = h.coordinator.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "s1" } },
  });
  clock.time = 9000;
  await idle;

  expect((await h.spans())[0]?.endTime).toEqual([2, 0]);
});
