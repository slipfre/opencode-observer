import { expect, mock, test } from "bun:test";
import type { AssistantMessage, Part, TextPart, UserMessage } from "@opencode-ai/sdk";
import type {
  InteractionFinish,
  InteractionStart,
  LlmStart,
  LlmFinish,
  LlmUpdate,
  Observer,
  RunFinish,
  RunStart,
  RunUpdate,
} from "../src/contract/observer.js";
import { createCoordinator } from "../src/adapter/opencode/coordinator.js";
import type { ChatParamsHookArgs } from "../src/adapter/model/request.js";
import { createCoordinatorHarness } from "./support/coordinator.js";

function recording() {
  const starts: RunStart[] = [];
  const updates: RunUpdate[] = [];
  const finishes: RunFinish[] = [];
  const interactions: InteractionStart[] = [];
  const completed: InteractionFinish[] = [];
  const llms: LlmStart[] = [];
  const llmFinishes: LlmFinish[] = [];
  const llmUpdates: LlmUpdate[] = [];
  const observer: Observer = {
    startTool() {},
    updateTool() {},
    finishTool() {},
    startCompaction() {},
    finishCompaction() {},
    startPermission() {},
    finishPermission() {},
    startRun(input) {
      starts.push(input);
    },
    updateRun(input) {
      updates.push(input);
    },
    finishRun(input) {
      finishes.push(input);
    },
    startInteraction(input) {
      interactions.push(input);
    },
    finishInteraction(input) {
      completed.push(input);
    },
    startLlm(input) {
      llms.push(input);
    },
    llmTraceHeaders: mock(() => undefined),
    updateLlm(input) {
      llmUpdates.push(input);
    },
    finishLlm(input) {
      llmFinishes.push(input);
    },
    flush: mock(async () => {}),
    shutdown: mock(async () => {}),
  };

  return {
    observer,
    starts,
    updates,
    finishes,
    interactions,
    completed,
    llms,
    llmFinishes,
    llmUpdates,
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

function text(messageID = "u1", content = "question"): TextPart {
  return { id: `${messageID}-text`, sessionID: "s1", messageID, type: "text", text: content };
}

async function reply(
  coordinator: ReturnType<typeof createCoordinatorHarness>,
  content = "answer",
  overrides: Partial<AssistantMessage> = {},
) {
  const info: AssistantMessage = {
    id: "a1",
    sessionID: "s1",
    parentID: "u1",
    role: "assistant",
    time: { created: 1100, completed: 1200 },
    modelID: "test",
    providerID: "test",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...overrides,
  };
  await coordinator.event({
    type: "message.part.updated",
    properties: { part: { ...text(info.id, content), sessionID: info.sessionID } },
  });
  await coordinator.event({ type: "message.updated", properties: { info } });
}

function modelMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "a1",
    sessionID: "s1",
    parentID: "u1",
    role: "assistant",
    time: { created: 1050 },
    modelID: "model-alias",
    providerID: "google",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function modelRequest(): ChatParamsHookArgs {
  const modalities = { text: true, audio: false, image: false, video: false, pdf: false };

  return [
    {
      sessionID: "s1",
      agent: "build",
      message: user(),
      provider: {
        source: "custom",
        info: { id: "google", name: "Google", source: "custom", env: [], options: {}, models: {} },
        options: {},
      },
      model: {
        id: "model-alias",
        providerID: "google",
        name: "model",
        api: { id: "gemini-request-model", url: "https://example.test", npm: "@ai-sdk/google" },
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: modalities,
          output: modalities,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 1000, output: 100 },
        status: "active",
        options: {},
        headers: {},
      },
    },
    {
      temperature: 0,
      topP: 0.9,
      topK: 8,
      maxOutputTokens: 100,
      options: { secret: "must not cross the contract" },
    },
  ];
}

test("chat.params observes compatible API settings without mutating the hook output", async () => {
  const h = recording();
  const failures: unknown[] = [];
  const adapter = createCoordinator({
    observer: h.observer,
    captureContent: true,
    log: (error) => failures.push(error),
  });
  const request = modelRequest();
  request[0].model.api.npm = "@ai-sdk/openai-compatible";
  request[1].topK = -1;
  request[1].maxOutputTokens = Number.POSITIVE_INFINITY;
  const before = structuredClone(request);

  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, { message: user(), parts: [text()] });
  await adapter.hooks["chat.params"]?.(...request);
  await adapter.hooks.event?.({
    event: { type: "message.updated", properties: { info: modelMessage() } },
  });
  await adapter.hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "start",
          sessionID: "s1",
          messageID: "a1",
          type: "step-start",
        },
      },
    },
  });

  expect(request).toEqual(before);
  expect(failures).toEqual([]);
  expect(h.llms[0]).toMatchObject({
    providerName: "gcp.gemini",
    operation: "chat",
    parameters: {
      temperature: 0,
      topP: 0.9,
      topK: undefined,
      maxOutputTokens: undefined,
    },
  });
  await adapter.hooks.dispose();
});

test("request keys isolate separators and escapes in provider, model and agent names", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  const requests = [
    { providerID: "provider:region", modelID: "model", agent: "build" },
    { providerID: "provider", modelID: "region:model", agent: "build" },
    { providerID: "provider", modelID: "region", agent: "model:build" },
    { providerID: "provider%3Aregion", modelID: "model", agent: "build" },
  ].map((names, index) => {
    const request = modelRequest();
    request[0].model.providerID = names.providerID;
    request[0].model.id = names.modelID;
    request[0].model.api.id = `resolved-model-${index}`;
    request[0].agent = names.agent;
    request[1].temperature = index / 10;
    return request;
  });
  await coordinator.message(user(), [text()]);
  for (const request of requests) {
    await coordinator.params(...request);
  }

  for (const [index, request] of requests.entries()) {
    await coordinator.event({
      type: "message.updated",
      properties: {
        info: modelMessage({
          id: `a${index}`,
          providerID: request[0].model.providerID,
          modelID: request[0].model.id,
          mode: request[0].agent,
        }),
      },
    });
    await modelPart(coordinator, "step-start", 1100, `a${index}`);
    await modelPart(coordinator, "step-finish", 1200, `a${index}`);
  }

  expect(h.llms.map((call) => call.model)).toEqual(
    requests.map((request) => request[0].model.api.id),
  );
  expect(h.llms.map((call) => call.parameters?.temperature)).toEqual(
    requests.map((request) => request[1].temperature),
  );
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } });
});

async function modelPart(
  coordinator: ReturnType<typeof createCoordinatorHarness>,
  type: "step-start" | "step-finish",
  time: number,
  messageID = "a1",
  overrides: Partial<Part> = {},
) {
  const part =
    type === "step-start"
      ? { id: `${messageID}-start`, messageID, sessionID: "s1", type }
      : {
          id: `${messageID}-finish`,
          messageID,
          sessionID: "s1",
          type,
          reason: "stop",
          cost: 0.02,
          tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
        };

  await coordinator.event(
    { type: "message.part.updated", properties: { part: { ...part, ...overrides } as Part } },
    time,
  );
}

test("request preparation starts one logical LLM before steps and preserves its owner across steer", async () => {
  const h = recording();
  const headers = {
    traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
    tracestate: "vendor=value",
  };
  h.observer.llmTraceHeaders = mock(() => headers);
  const coordinator = createCoordinatorHarness({ observer: h.observer, now: () => 1080 });
  const request = modelRequest();
  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  await coordinator.params(...request);
  expect(h.llms).toEqual([]);

  expect(await coordinator.headers(request[0])).toEqual(headers);
  await coordinator.message(user("u2", 1090), [text("u2", "steer")]);
  expect(await coordinator.headers(request[0])).toEqual(headers);
  await modelPart(coordinator, "step-start", 1200);

  expect(h.llms).toHaveLength(1);
  expect(h.llms[0]).toMatchObject({
    id: "a1",
    interaction: { id: "u1", run: { sessionID: "s1", id: "u1" } },
    startedAt: 1050,
    model: "gemini-request-model",
    fallbackInputText: undefined,
    parameters: { temperature: 0, topP: 0.9, topK: 8, maxOutputTokens: 100 },
  });
  expect(h.observer.llmTraceHeaders).toHaveBeenLastCalledWith({
    id: "a1",
    interaction: h.llms[0]!.interaction,
  });

  await modelPart(coordinator, "step-finish", 1300);
  expect(h.llmFinishes).toHaveLength(0);
  await coordinator.event({
    type: "message.updated",
    properties: { info: modelMessage({ time: { created: 1050, completed: 1350 } }) },
  });
  expect(h.llmFinishes).toHaveLength(1);
  expect(await coordinator.headers(request[0])).toEqual({});
  await coordinator.hooks.dispose();
  expect(await coordinator.headers(request[0])).toEqual({});
});

test.each([
  "title",
  "ambiguous",
  "model",
  "provider",
  "user",
  "completed",
  "missing-parent",
  "summary",
])("request preparation omits propagation for %s without inventing a span", async (scenario) => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  const request = modelRequest()[0];
  await coordinator.message(user(), [text()]);
  await coordinator.event({
    type: "message.updated",
    properties: {
      info: modelMessage({
        ...(scenario === "completed" ? { time: { created: 1050, completed: 1100 } } : {}),
        ...(scenario === "missing-parent" ? { parentID: "unknown" } : {}),
        ...(scenario === "summary" ? { summary: true } : {}),
      }),
    },
  });

  if (scenario === "ambiguous") {
    await coordinator.event({
      type: "message.updated",
      properties: { info: modelMessage({ id: "a2" }) },
    });
  }

  const input = {
    ...request,
    agent: scenario === "title" ? "title" : request.agent,
    message: scenario === "user" ? user("unknown") : request.message,
    model: {
      ...request.model,
      id: scenario === "model" ? "unknown" : request.model.id,
      providerID: scenario === "provider" ? "unknown" : request.model.providerID,
    },
  };
  expect(await coordinator.headers(input)).toEqual({});
  expect(h.llms).toEqual([]);
  expect(h.observer.llmTraceHeaders).not.toHaveBeenCalled();
  await coordinator.hooks.dispose();
});

test.each([false, true])(
  "chat.headers propagates without SDK capture initialization, captureContent=%s",
  async (captureContent) => {
    const h = recording();
    const headers = {
      traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
      tracestate: "vendor=value",
    };
    h.observer.llmTraceHeaders = mock(() => headers);
    const failures: unknown[] = [];
    const adapter = createCoordinator({
      observer: h.observer,
      captureContent,
      log: (error) => failures.push(error),
    });
    const request = modelRequest();
    await adapter.hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: user(), parts: [text()] },
    );
    await adapter.hooks.event?.({
      event: { type: "message.updated", properties: { info: modelMessage() } },
    });
    await adapter.hooks["chat.params"]?.(...request);
    const output = { headers: { "X-Test": "kept" } };

    await adapter.hooks["chat.headers"]?.(request[0], output);

    expect(output.headers).toEqual({ "X-Test": "kept", ...headers });
    expect(h.llms).toHaveLength(1);
    expect(h.llms[0]?.fallbackInputText).toBe(captureContent ? "question" : undefined);
    expect(failures).toEqual([]);

    await adapter.hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "APIError", data: { message: "before first step", isRetryable: false } },
        },
      },
    });
    expect(h.llmFinishes).toHaveLength(1);
    expect(h.llmFinishes[0]?.error).toEqual({ type: "APIError", message: "before first step" });
    expect(h.llmFinishes[0]?.usage).toBeUndefined();
    await adapter.hooks.dispose();
  },
);

test.each([
  { enabled: true, id: "resolved-user", expected: "user_id=resolved-user,vendor=value" },
  { enabled: true, id: undefined, expected: "user_id=unknown,vendor=value" },
  { enabled: false, id: "resolved-user", expected: "vendor=value" },
  { enabled: false, id: undefined, expected: "vendor=value" },
])(
  "adapter adds the user snapshot only to correlated outgoing trace headers: %j",
  async (input) => {
    const h = recording();
    const headers = Object.freeze({
      traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
      tracestate: "vendor=value",
    });
    h.observer.llmTraceHeaders = () => headers;
    const identity: { enabled: boolean; id: string | undefined } = {
      enabled: input.enabled,
      id: input.id,
    };
    const failures: unknown[] = [];
    const adapter = createCoordinator({
      observer: h.observer,
      captureContent: false,
      userIdentity: identity,
      log: (error) => failures.push(error),
    });
    const request = modelRequest()[0];
    identity.enabled = !identity.enabled;
    identity.id = "changed-after-initialization";
    await adapter.hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: user(), parts: [text()] },
    );
    const unmatched = { headers: { "X-Test": "kept" } };
    await adapter.hooks["chat.headers"]?.(request, unmatched);
    expect(unmatched.headers).toEqual({ "X-Test": "kept" });
    await adapter.hooks.event?.({
      event: { type: "message.updated", properties: { info: modelMessage() } },
    });

    const output = { headers: { "X-Test": "kept" } };
    await adapter.hooks["chat.headers"]?.(request, output);
    await adapter.hooks["chat.headers"]?.(request, output);

    const expected = { ...headers, "X-Test": "kept", tracestate: input.expected };
    expect(output.headers).toEqual(expected);
    expect(headers.tracestate).toBe("vendor=value");
    expect(h.llms[0]).not.toHaveProperty("userID");
    expect(h.llms[0]?.fallbackInputText).toBeUndefined();
    expect(failures).toEqual([]);

    const title = { headers: {} };
    await adapter.hooks["chat.headers"]?.({ ...request, agent: "title" }, title);
    expect(title.headers).toEqual({});
    await adapter.hooks.dispose();
    const disposed = { headers: {} };
    await adapter.hooks["chat.headers"]?.(request, disposed);
    expect(disposed.headers).toEqual({});
  },
);

test("a propagation failure leaves the model headers usable and is contained by the hook", async () => {
  const h = recording();
  const failure = new Error("propagation failed");
  h.observer.llmTraceHeaders = () => {
    throw failure;
  };
  const failures: unknown[] = [];
  const adapter = createCoordinator({
    observer: h.observer,
    captureContent: false,
    log: (error) => failures.push(error),
  });
  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, { message: user(), parts: [text()] });
  await adapter.hooks.event?.({
    event: { type: "message.updated", properties: { info: modelMessage() } },
  });
  const output = { headers: { "X-Test": "kept" } };

  await expect(adapter.hooks["chat.headers"]?.(modelRequest()[0], output)).resolves.toBeUndefined();

  expect(output.headers).toEqual({ "X-Test": "kept" });
  expect(failures).toEqual([failure]);
  await adapter.hooks.dispose();
});

test("source messages become run operations with explicit unsupported associations", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [text(), { ...text(), id: "synthetic", synthetic: true }]);
  await coordinator.message(user("u2", 1500), [text("u2", "steer")]);
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2500);

  expect(h.starts).toEqual([
    {
      sessionID: "s1",
      id: "u1",
      startedAt: 1000,
      parentTool: undefined,
      parentSessionID: undefined,
    },
  ]);
  expect(h.updates).toEqual([
    { sessionID: "s1", id: "u1", input: { id: "u1", text: "question" } },
    { sessionID: "s1", id: "u1", input: { id: "u2", text: "steer" } },
  ]);
  expect(h.finishes).toEqual([
    { sessionID: "s1", id: "u1", endedAt: 2500, output: undefined, error: undefined },
  ]);
});

test("disabled capture never sends user or assistant bodies across the contract", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: false });

  await coordinator.message(user(), [text("u1", "secret input")]);
  await reply(coordinator, "secret output");
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.updates[0]?.input.text).toBeUndefined();
  expect(h.finishes[0]?.output).toBeUndefined();
  expect(h.interactions[0]?.input).toBeUndefined();
  expect(
    JSON.stringify([h.starts, h.updates, h.finishes, h.interactions, h.completed]),
  ).not.toContain("secret");
});

test("replayed user hooks cannot reopen an ended run or attach old input to the next run", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);
  await coordinator.message(user(), [text("u1", "replayed")]);
  await coordinator.message(user("u2", 3000), [text("u2", "next")]);
  await coordinator.message(user(), [text("u1", "late old input")]);
  await coordinator.message(user("u1", 1000, "s2"), [{ ...text(), sessionID: "s2" }]);

  expect(h.starts.map((input) => [input.sessionID, input.id])).toEqual([
    ["s1", "u1"],
    ["s1", "u2"],
    ["s2", "u1"],
  ]);
  expect(h.updates.map((input) => input.input.text)).toEqual(["question", "next", "question"]);
  expect(h.finishes).toHaveLength(1);
  expect(h.interactions.map((input) => [input.run.sessionID, input.id])).toEqual([
    ["s1", "u1"],
    ["s1", "u2"],
    ["s2", "u1"],
  ]);
});

test("recoverable overflow is interpreted before submitting a terminal failure", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });

  await coordinator.message(user(), [text()]);
  await coordinator.event(
    {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "ContextOverflowError", data: { message: "full" } },
      },
    },
    1500,
  );

  expect(h.finishes).toHaveLength(0);
  expect(h.completed).toHaveLength(0);

  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.finishes).toEqual([
    {
      sessionID: "s1",
      id: "u1",
      endedAt: 2000,
      output: undefined,
      error: { type: "ContextOverflowError", message: "full" },
    },
  ]);
  expect(h.starts).toHaveLength(1);
  expect(h.completed[0]).toMatchObject({
    status: "failed",
    endedAt: 2000,
    error: { type: "ContextOverflowError" },
  });
});

test("event hooks record synchronously with the coordinator clock and wait for flush", async () => {
  const h = recording();
  const clock = { time: 1000 };
  const flushing = Promise.withResolvers<void>();
  const settled = { idle: false };
  h.observer.flush = mock(() => flushing.promise);
  const coordinator = createCoordinator({ observer: h.observer, now: () => clock.time });

  const message = coordinator.hooks["chat.message"]?.(
    { sessionID: "s1" },
    { message: user(), parts: [text()] },
  );

  expect(h.starts).toHaveLength(1);
  expect(h.interactions).toHaveLength(1);

  clock.time = 2000;
  const idle = coordinator.hooks
    .event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    .then(() => {
      settled.idle = true;
    });
  clock.time = 3000;

  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]?.endedAt).toBe(2000);
  expect(h.completed[0]?.endedAt).toBe(2000);
  expect(h.observer.flush).toHaveBeenCalledTimes(1);
  await message;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(settled.idle).toBe(false);
  flushing.resolve();
  await idle;

  expect(settled.idle).toBe(true);
  await coordinator.hooks.dispose();
});

test("dispose clears existing session state and waits for one shared shutdown", async () => {
  const h = recording();
  const shutdown = Promise.withResolvers<void>();
  const settled = { value: false };
  h.observer.shutdown = mock(() => shutdown.promise);
  const coordinator = createCoordinator({ observer: h.observer });
  const request = modelRequest();
  await coordinator.hooks["chat.message"](
    { sessionID: "s1" },
    { message: user(), parts: [text()] },
  );
  await coordinator.hooks.event({
    event: { type: "message.updated", properties: { info: modelMessage() } },
  });
  const disposal = coordinator.hooks.dispose();
  const repeated = coordinator.hooks.dispose();
  void disposal.then(() => {
    settled.value = true;
  });

  await coordinator.hooks["chat.message"](
    { sessionID: "s1" },
    { message: user("u2", 2000), parts: [text("u2")] },
  );
  await coordinator.hooks["chat.params"](...request);
  const output = { headers: { "X-Test": "kept" } };
  await coordinator.hooks["chat.headers"](request[0], output);
  await coordinator.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "s1" } },
  });

  expect(h.starts).toHaveLength(1);
  expect(h.interactions.map((input) => input.id)).toEqual(["u1"]);
  expect(h.llms).toHaveLength(0);
  expect(h.llmUpdates).toHaveLength(0);
  expect(h.finishes).toHaveLength(0);
  expect(h.observer.llmTraceHeaders).not.toHaveBeenCalled();
  expect(output.headers).toEqual({ "X-Test": "kept" });
  expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
  expect(repeated).toBe(disposal);
  expect(settled.value).toBe(false);

  shutdown.resolve();
  await Promise.all([disposal, repeated]);

  expect(settled.value).toBe(true);
  expect(coordinator.hooks.dispose()).toBe(disposal);
  expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
});

test("the outer hook guard isolates recording failures and awaited export failures", async () => {
  const h = recording();
  const error = new Error("recording failed");
  const flushing = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const adapter = createCoordinator({
    observer: {
      ...h.observer,
      startRun() {
        throw error;
      },
      flush() {
        return flushing.promise;
      },
    },
    captureContent: true,
    log(error) {
      failures.push(error);
    },
  });
  const output = { message: user(), parts: [text()] };

  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, output);

  expect(failures).toEqual([error]);
  expect(output).toEqual({ message: user(), parts: [text()] });

  const idle = adapter.hooks.event({
    event: { type: "session.idle", properties: { sessionID: "s1" } },
  });
  flushing.reject(new Error("export failed"));
  await expect(idle).resolves.toBeUndefined();

  expect(failures).toHaveLength(2);
  expect(failures[1]).toEqual(new Error("export failed"));
  await adapter.hooks.dispose();
});

test.each(["throw", "reject"])("hooks isolate %s from flush and disposal", async (mode) => {
  const h = recording();
  const exportError = new Error("export failed");
  const disposeError = new Error("disposal failed");
  const failures: unknown[] = [];
  h.observer.shutdown = mock(() => {
    if (mode === "throw") {
      throw disposeError;
    }

    return Promise.reject(disposeError);
  });
  const adapter = createCoordinator({
    observer: {
      ...h.observer,
      flush() {
        if (mode === "throw") {
          throw exportError;
        }

        return Promise.reject(exportError);
      },
    },
    captureContent: false,
    log: (error) => failures.push(error),
  });

  await expect(
    adapter.hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } }),
  ).resolves.toBeUndefined();
  await expect(
    adapter.hooks.event?.({
      event: { type: "server.instance.disposed", properties: { directory: "/test" } },
    }),
  ).resolves.toBeUndefined();

  expect(failures).toEqual([exportError]);

  await expect(adapter.hooks.dispose?.()).resolves.toBeUndefined();
  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, { message: user(), parts: [text()] });
  await adapter.hooks.dispose();

  expect(failures).toEqual([exportError, disposeError]);
  expect(h.starts).toHaveLength(0);
  expect(h.interactions).toHaveLength(0);
  expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
});

test.each(["throw", "reject"])(
  "all hook boundaries contain input errors when logging %s",
  async (mode) => {
    const h = recording();
    const failures: unknown[] = [];
    const errors = ["message", "params", "headers", "event"].map((name) => new Error(name));
    const adapter = createCoordinator({
      observer: h.observer,
      captureContent: true,
      log(error) {
        failures.push(error);

        if (mode === "throw") {
          throw new Error("logging failed");
        }

        return Promise.reject(new Error("logging failed"));
      },
    });
    await adapter.startSdkModelCapture();
    const output = { message: user(), parts: [text()] };
    await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, output);
    const request = modelRequest();

    await expect(
      adapter.hooks["chat.message"]?.(
        { sessionID: "s1" },
        {
          message: user("broken"),
          get parts(): never {
            throw errors[0];
          },
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      adapter.hooks["chat.params"]?.(request[0], {
        ...request[1],
        get temperature(): never {
          throw errors[1];
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.hooks["chat.headers"]?.(request[0], {
        get headers(): never {
          throw errors[2];
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.hooks.event?.({
        get event(): never {
          throw errors[3];
        },
      }),
    ).resolves.toBeUndefined();
    await Bun.sleep(0);

    expect(failures).toEqual(errors);
    expect(output).toEqual({ message: user(), parts: [text()] });
    expect(h.starts).toHaveLength(1);
    await adapter.hooks.dispose();
  },
);

test.each([true, false])(
  "interaction and run end at idle with captureContent=%s",
  async (captureContent) => {
    const h = recording();
    const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent });

    await coordinator.message({ ...user(), agent: "review" }, [text()]);
    await reply(coordinator, "final");
    await coordinator.event(
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      },
      2000,
    );

    expect(h.completed).toHaveLength(0);

    await coordinator.event(
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      },
      2500,
    );
    await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 3000);

    expect(h.interactions).toEqual([
      {
        run: { sessionID: "s1", id: "u1" },
        id: "u1",
        startedAt: 1000,
        input: captureContent ? "question" : undefined,
        agentName: "review",
        agentType: undefined,
        parentSessionID: undefined,
      },
    ]);
    expect(h.completed).toEqual([
      {
        run: { sessionID: "s1", id: "u1" },
        id: "u1",
        endedAt: 2500,
        status: "completed",
        output: captureContent ? "final" : undefined,
      },
    ]);
    expect(h.finishes).toHaveLength(1);
    expect(h.finishes[0]).toMatchObject({
      endedAt: 2500,
      output: captureContent ? "final" : undefined,
    });
  },
);

test("steer supersedes the old interaction exactly at the next input and ignores late old output", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [text()]);
  await reply(coordinator, "intermediate");
  await coordinator.message(user("u2", 1500), [text("u2", "steer")]);
  await coordinator.event({
    type: "message.updated",
    properties: { info: user("continue", 1400) },
  });
  await reply(coordinator, "final", {
    id: "a2",
    parentID: "u2",
    time: { created: 1600, completed: 1700 },
  });
  await reply(coordinator, "late old", {
    id: "old",
    parentID: "continue",
    time: { created: 1800, completed: 1900 },
  });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2500);
  await reply(coordinator, "late after idle");
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 3000);

  expect(h.completed).toEqual([
    { run: { sessionID: "s1", id: "u1" }, id: "u1", endedAt: 1500, status: "superseded" },
    {
      run: { sessionID: "s1", id: "u1" },
      id: "u2",
      endedAt: 2500,
      status: "completed",
      output: "final",
    },
  ]);
  expect(h.interactions.map((item) => item.id)).toEqual(["u1", "u2"]);
  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]?.output).toBe("final");
});

test.each(["synthetic", "ignored"] as const)(
  "%s prompt hooks and message events keep the original interaction",
  async (flag) => {
    const h = recording();
    const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });
    const info = user("continue", 1400);
    const part = { ...text("continue", "internal input"), [flag]: true };
    await coordinator.message(user(), [text()]);

    await coordinator.message(info, [part]);

    expect(h.interactions).toHaveLength(1);
    expect(h.completed).toHaveLength(0);

    await coordinator.event({ type: "message.updated", properties: { info } });
    await coordinator.event({ type: "message.part.updated", properties: { part } });
    await coordinator.event({
      type: "message.updated",
      properties: { info: modelMessage({ parentID: info.id, time: { created: 1500 } }) },
    });
    await modelPart(coordinator, "step-start", 1500);
    await modelPart(coordinator, "step-finish", 1600);
    await reply(coordinator, "continued answer", {
      parentID: info.id,
      time: { created: 1500, completed: 1600 },
    });
    await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

    expect(h.starts).toHaveLength(1);
    expect(h.interactions).toHaveLength(1);
    expect(h.interactions[0]?.input).toBe("question");
    expect(h.llms).toHaveLength(1);
    expect(h.llms[0]).toMatchObject({ interaction: { id: "u1" }, fallbackInputText: "question" });
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]).toMatchObject({
      id: "u1",
      status: "completed",
      output: "continued answer",
    });
    expect(h.finishes[0]?.output).toBe("continued answer");
  },
);

test("compaction and continuation events retain the interaction through successful recovery", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [
    { ...text(), ignored: true },
    { ...text("u1", "real"), id: "real" },
  ]);
  await coordinator.event(
    {
      type: "session.error",
      properties: { sessionID: "s1", error: { name: "ContextOverflowError" } },
    },
    1200,
  );
  await coordinator.event({ type: "message.updated", properties: { info: user("compact", 1300) } });
  await coordinator.event({
    type: "message.part.updated",
    properties: {
      part: { id: "c", sessionID: "s1", messageID: "compact", type: "compaction", auto: true },
    },
  });
  await reply(coordinator, "summary", {
    id: "summary",
    parentID: "compact",
    summary: true,
    time: { created: 1300, completed: 1350 },
  });
  await coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } });
  await coordinator.event({
    type: "message.updated",
    properties: { info: user("continue", 1400) },
  });
  await coordinator.event({
    type: "message.part.updated",
    properties: { part: { ...text("continue", "continue"), synthetic: true } },
  });

  expect(h.completed).toHaveLength(0);

  await reply(coordinator, "recovered", {
    id: "a2",
    parentID: "continue",
    time: { created: 1500, completed: 1600 },
  });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.interactions).toHaveLength(1);
  expect(h.interactions[0]?.input).toBe("real");
  expect(h.completed[0]).toMatchObject({ status: "completed", endedAt: 2000, output: "recovered" });
});

test("latest unfinished assistant causes observed-time cleanup instead of a fabricated completion", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [text()]);
  await reply(coordinator, "earlier answer");
  await reply(coordinator, "unfinished", { id: "a2", time: { created: 1500 } });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.completed[0]).toMatchObject({
    status: "failed",
    endedAt: 2000,
    error: { type: "_OTHER", message: "session ended before interaction completed" },
  });
  expect(h.finishes[0]).toMatchObject({ output: undefined, error: undefined });
});

test("terminal assistant error fails its interaction without inventing a run-level failure", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });

  await coordinator.message(user(), [text()]);
  await reply(coordinator, "partial", {
    error: { name: "UnknownError", data: { message: "generation failed" } },
  });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.completed[0]).toMatchObject({
    status: "failed",
    error: { type: "UnknownError", message: "generation failed" },
  });
  expect(h.finishes[0]?.error).toBeUndefined();
  expect(h.finishes[0]?.output).toBeUndefined();
});

test("LLM spans use assistant timestamps while steps supply evidence and normalized usage", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });
  const request = modelRequest();
  await coordinator.message(user(), [text()]);
  await coordinator.params(...request);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1060);

  expect(h.llms).toHaveLength(0);

  await modelPart(coordinator, "step-start", 1100);
  await coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "partial") } },
    1150,
  );
  await coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "answer") } },
    1200,
  );
  await modelPart(coordinator, "step-finish", 1300);

  expect(h.llmFinishes).toHaveLength(0);
  await coordinator.event(
    {
      type: "message.updated",
      properties: {
        info: modelMessage({ time: { created: 1050, completed: 1350 }, finish: "stop" }),
      },
    },
    1500,
  );

  expect(h.llms[0]).toMatchObject({
    id: "a1",
    interaction: { id: "u1", run: { sessionID: "s1", id: "u1" } },
    startedAt: 1050,
    providerName: "gcp.gemini",
    providerID: "google",
    model: "gemini-request-model",
    operation: "generate_content",
    stream: true,
    fallbackInputText: "question",
    agentName: "build",
    parameters: { temperature: 0, topP: 0.9, topK: 8, maxOutputTokens: 100 },
    agentType: undefined,
    parentSessionID: undefined,
    compactionID: undefined,
  });
  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: 1350,
    fallbackOutputText: "answer",
    finishReason: "stop",
    cost: 0.02,
    usage: {
      inputTokens: 13,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  });
  expect(h.llmFinishes[0]?.error).toBeUndefined();
  expect(JSON.stringify(h.llms)).not.toContain("secret");

  await coordinator.event(
    {
      type: "message.updated",
      properties: {
        info: modelMessage({ time: { created: 1050, completed: 3000 }, finish: "stop" }),
      },
    },
    3500,
  );
  await modelPart(coordinator, "step-finish", 4000);
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 4500);

  expect(h.llms).toHaveLength(1);
  expect(h.llmFinishes).toHaveLength(1);
  expect(h.llmFinishes[0]?.endedAt).toBe(1350);
  expect(h.completed[0]?.endedAt).toBe(4500);
});

test("LLM spans omit fabricated assistants, unmatched parents, summaries and finish-only observations", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });
  await coordinator.message(user(), [text()]);
  await reply(coordinator);
  await coordinator.event(
    {
      type: "message.updated",
      properties: { info: modelMessage({ id: "summary", summary: true }) },
    },
    1100,
  );
  await modelPart(coordinator, "step-start", 1200, "summary");
  await coordinator.event(
    {
      type: "message.updated",
      properties: { info: modelMessage({ id: "orphan", parentID: "unknown" }) },
    },
    1100,
  );
  await modelPart(coordinator, "step-start", 1200, "orphan");
  await coordinator.event(
    { type: "message.updated", properties: { info: modelMessage({ id: "finish-only" }) } },
    1100,
  );
  await modelPart(coordinator, "step-finish", 1300, "finish-only");
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.llms).toEqual([]);
  expect(h.llmFinishes).toEqual([]);
});

test("assistant completion can precede step results without losing source time or usage", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  await coordinator.message(user(), [text()]);
  await modelPart(coordinator, "step-start", 1400);
  await coordinator.event(
    {
      type: "message.updated",
      properties: { info: modelMessage({ time: { created: 1050, completed: 1350 } }) },
    },
    1500,
  );

  expect(h.llms[0]?.startedAt).toBe(1050);
  expect(h.llmFinishes).toHaveLength(0);

  await modelPart(coordinator, "step-finish", 1600);

  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: 1350,
    usage: { inputTokens: 13, outputTokens: 7 },
  });
});

test.each([true, false])("assistant error uses completion when available=%s", async (completed) => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1100);
  await modelPart(coordinator, "step-start", 1150);
  await coordinator.event(
    {
      type: "message.updated",
      properties: {
        info: modelMessage({
          time: { created: 1050, ...(completed ? { completed: 1250 } : {}) },
          error: { name: "MessageAbortedError", data: { message: "cancelled" } },
        }),
      },
    },
    1400,
  );

  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: completed ? 1250 : 1400,
    error: { type: "MessageAbortedError", message: "cancelled" },
  });

  await coordinator.event({
    type: "message.updated",
    properties: { info: modelMessage({ time: { created: 1050, completed: 1450 } }) },
  });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 1500);

  expect(h.llmFinishes).toHaveLength(1);
  expect(h.llmFinishes[0]?.endedAt).toBe(completed ? 1250 : 1400);
});

test.each([undefined, Number.NaN, 1000])(
  "step success without a valid assistant completion (%s) is closed as incomplete",
  async (completed) => {
    const h = recording();
    const coordinator = createCoordinatorHarness({ observer: h.observer });
    await coordinator.message(user(), [text()]);
    await coordinator.event({
      type: "message.updated",
      properties: { info: modelMessage({ time: { created: 1050, completed } }) },
    });
    await modelPart(coordinator, "step-start", 1100);
    await modelPart(coordinator, "step-finish", 1200);

    expect(h.llmFinishes).toHaveLength(0);

    await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 1400);

    expect(h.llmFinishes[0]).toMatchObject({
      endedAt: 1400,
      error: { type: "_OTHER", message: "session ended before message completed" },
    });
  },
);

test("a completed assistant with a prepared request needs no fabricated step usage at cleanup", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } });
  await coordinator.headers(modelRequest()[0]);
  await coordinator.event({
    type: "message.updated",
    properties: {
      info: modelMessage({ time: { created: 1050, completed: 1250 }, finish: "stop" }),
    },
  });
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 1400);

  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: 1250,
    finishReason: "stop",
  });
  expect(h.llmFinishes[0]?.error).toBeUndefined();
  expect(h.llmFinishes[0]?.usage).toBeUndefined();
});

test.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
  "LLM spans omit invalid assistant creation time %s",
  async (created) => {
    const h = recording();
    const coordinator = createCoordinatorHarness({ observer: h.observer });
    await coordinator.message(user(), [text()]);
    await coordinator.event({
      type: "message.updated",
      properties: { info: modelMessage({ time: { created } }) },
    });
    await modelPart(coordinator, "step-start", 1100);
    await modelPart(coordinator, "step-finish", 1200);
    await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 1400);

    expect(h.llms).toHaveLength(0);
    expect(h.llmFinishes).toHaveLength(0);
  },
);

test("LLM step events can precede metadata and late synthetic ownership stays with the old interaction", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });
  await coordinator.message(user(), [text()]);
  await coordinator.message(user("u2", 1500), [text("u2", "steer")]);
  await modelPart(coordinator, "step-start", 1600);
  await coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "old answer") } },
    1650,
  );
  await modelPart(coordinator, "step-finish", 1700);
  await coordinator.event(
    {
      type: "message.updated",
      properties: {
        info: modelMessage({ parentID: "continuation", time: { created: 1550, completed: 1750 } }),
      },
    },
    1800,
  );

  expect(h.llms).toHaveLength(0);

  await coordinator.event(
    { type: "message.updated", properties: { info: user("continuation", 1400) } },
    1900,
  );

  expect(h.llms[0]).toMatchObject({
    startedAt: 1550,
    interaction: { id: "u1" },
    fallbackInputText: "question",
  });
  expect(h.llmFinishes[0]).toMatchObject({ endedAt: 1750, fallbackOutputText: "old answer" });
});

test("OpenCode retries retain one span and distinguish scheduled and observed execution", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent: true });
  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  await modelPart(coordinator, "step-start", 1100);
  await coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "failed partial") } },
    1150,
  );
  await coordinator.event(
    {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 1, message: "busy", next: 1500 },
      },
    },
    1200,
  );

  expect(h.llmFinishes).toHaveLength(0);
  expect(h.llmUpdates).toHaveLength(0);

  await coordinator.event(
    { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    1540,
  );

  expect(h.llmUpdates.at(-1)?.retries).toEqual([
    { attempt: 1, reason: "busy", scheduledAt: 1500, observedAt: 1540 },
  ]);

  await modelPart(coordinator, "step-start", 1600, "a1", { id: "retry-step" });
  await coordinator.event(
    {
      type: "message.part.updated",
      properties: { part: { ...text("a1", "recovered"), id: "retry-text" } },
    },
    1650,
  );
  await coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "late failed partial") } },
    1675,
  );
  await modelPart(coordinator, "step-start", 1700, "a1", { id: "retry-step" });
  await modelPart(coordinator, "step-finish", 1800);
  await coordinator.event({
    type: "message.updated",
    properties: { info: modelMessage({ time: { created: 1050, completed: 1850 } }) },
  });
  await modelPart(coordinator, "step-start", 1900, "a1", { id: "late-step" });

  expect(h.llms).toHaveLength(1);
  expect(h.llms[0]?.startedAt).toBe(1050);
  expect(h.llmFinishes).toHaveLength(1);
  expect(h.llmFinishes[0]).toMatchObject({ endedAt: 1850, fallbackOutputText: "recovered" });
  expect(h.llmFinishes[0]?.error).toBeUndefined();
});

test("recoverable overflow fails only the active model call and idle cleans unfinished calls", async () => {
  const h = recording();
  const coordinator = createCoordinatorHarness({ observer: h.observer });
  await coordinator.message(user(), [text()]);
  await coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  await modelPart(coordinator, "step-start", 1100);
  await coordinator.event(
    {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "ContextOverflowError", data: { message: "full" } },
      },
    },
    1200,
  );

  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: 1200,
    error: { type: "ContextOverflowError", message: "full" },
  });
  expect(h.completed).toHaveLength(0);
  expect(h.finishes).toHaveLength(0);

  await coordinator.event(
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "compact",
          sessionID: "s1",
          messageID: "compact-user",
          type: "compaction",
          auto: true,
        },
      },
    },
    1250,
  );
  await coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1400);
  await coordinator.event(
    { type: "message.updated", properties: { info: modelMessage({ id: "a2" }) } },
    1450,
  );
  await modelPart(coordinator, "step-start", 1500, "a2");
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);
  await coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2100);

  expect(h.llmFinishes).toHaveLength(2);
  expect(h.llmFinishes[1]).toMatchObject({
    endedAt: 2000,
    error: { type: "_OTHER", message: "session ended before message completed" },
  });
  expect(h.finishes[0]?.error).toBeUndefined();
});

test.each([true, false])(
  "LLM text snapshots respect removal and capture=%s without fabricating token data",
  async (captureContent) => {
    const h = recording();
    const coordinator = createCoordinatorHarness({ observer: h.observer, captureContent });
    await coordinator.message(user(), [text("u1", "secret")]);
    await coordinator.event(
      { type: "message.updated", properties: { info: modelMessage() } },
      1050,
    );
    await modelPart(coordinator, "step-start", 1100);
    await coordinator.event(
      { type: "message.part.updated", properties: { part: text("a1", "removed") } },
      1150,
    );
    await coordinator.event(
      {
        type: "message.part.removed",
        properties: { sessionID: "s1", messageID: "a1", partID: "a1-text" },
      },
      1175,
    );
    await coordinator.event(
      { type: "message.part.updated", properties: { part: { ...text("a1", ""), id: "empty" } } },
      1200,
    );
    await modelPart(coordinator, "step-finish", 1300, "a1", {
      tokens: {
        input: Number.NaN,
        output: -1,
        reasoning: 0,
        cache: { read: 0, write: Number.POSITIVE_INFINITY },
      },
      cost: Number.NaN,
    });
    await coordinator.event({
      type: "message.updated",
      properties: { info: modelMessage({ time: { created: 1050, completed: 1350 } }) },
    });

    expect(h.llms[0]?.fallbackInputText).toBe(captureContent ? "secret" : undefined);
    expect(h.llmFinishes[0]?.fallbackOutputText).toBe(captureContent ? "" : undefined);
    expect(h.llmFinishes[0]?.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: undefined,
    });
    expect(h.llmFinishes[0]?.cost).toBeUndefined();
    expect(JSON.stringify(h.llmFinishes)).not.toContain("removed");
  },
);
