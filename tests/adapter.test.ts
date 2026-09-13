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
import { createOpenCodeAdapter } from "../src/adapter/opencode/hooks.js";
import { createCoordinator } from "../src/adapter/opencode/coordinator.js";
import type { LlmRequest } from "../src/adapter/model/request.js";

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

function reply(
  coordinator: ReturnType<typeof createCoordinator>,
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
  coordinator.event({
    type: "message.part.updated",
    properties: { part: { ...text(info.id, content), sessionID: info.sessionID } },
  });
  coordinator.event({ type: "message.updated", properties: { info } });
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

function modelRequest(): LlmRequest {
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
  const adapter = createOpenCodeAdapter({
    observer: h.observer,
    directory: "/test",
    captureContent: true,
    onDispose: h.observer.shutdown,
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
      maxTokens: undefined,
    },
  });
  adapter.close();
});

function modelPart(
  coordinator: ReturnType<typeof createCoordinator>,
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

  coordinator.event(
    { type: "message.part.updated", properties: { part: { ...part, ...overrides } as Part } },
    time,
  );
}

test("request preparation starts one logical LLM before steps and preserves its owner across steer", () => {
  const h = recording();
  const headers = {
    traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
    tracestate: "vendor=value",
  };
  h.observer.llmTraceHeaders = mock(() => headers);
  const coordinator = createCoordinator({ observer: h.observer, now: () => 1080 });
  const request = modelRequest();
  coordinator.userMessage(user(), [text()]);
  coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  coordinator.request(...request);
  expect(h.llms).toEqual([]);

  expect(coordinator.prepareModel(request[0])).toEqual(headers);
  coordinator.userMessage(user("u2", 1090), [text("u2", "steer")]);
  expect(coordinator.prepareModel(request[0])).toEqual(headers);
  modelPart(coordinator, "step-start", 1200);

  expect(h.llms).toHaveLength(1);
  expect(h.llms[0]).toMatchObject({
    id: "a1",
    interaction: { id: "u1", run: { sessionID: "s1", id: "u1" } },
    startedAt: 1080,
    model: "gemini-request-model",
    input: undefined,
    parameters: { temperature: 0, topP: 0.9, topK: 8, maxTokens: 100 },
  });
  expect(h.observer.llmTraceHeaders).toHaveBeenLastCalledWith({
    id: "a1",
    interaction: h.llms[0]!.interaction,
  });

  modelPart(coordinator, "step-finish", 1300);
  expect(h.llmFinishes).toHaveLength(1);
  expect(coordinator.prepareModel(request[0])).toBeUndefined();
  coordinator.close();
  expect(coordinator.prepareModel(request[0])).toBeUndefined();
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
])("request preparation omits propagation for %s without inventing a span", (scenario) => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer });
  const request = modelRequest()[0];
  coordinator.userMessage(user(), [text()]);
  coordinator.event({
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
    coordinator.event({
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
  expect(coordinator.prepareModel(input)).toBeUndefined();
  expect(h.llms).toEqual([]);
  expect(h.observer.llmTraceHeaders).not.toHaveBeenCalled();
  coordinator.close();
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
    const adapter = createOpenCodeAdapter({
      observer: h.observer,
      directory: "/test",
      captureContent,
      log: (error) => failures.push(error),
      onDispose: h.observer.shutdown,
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
    expect(h.llms[0]?.input).toBe(captureContent ? "question" : undefined);
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
    adapter.close();
  },
);

test("a propagation failure leaves the model headers usable and is contained by the hook", async () => {
  const h = recording();
  const failure = new Error("propagation failed");
  h.observer.llmTraceHeaders = () => {
    throw failure;
  };
  const failures: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    observer: h.observer,
    directory: "/test",
    captureContent: false,
    log: (error) => failures.push(error),
    onDispose: h.observer.shutdown,
  });
  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, { message: user(), parts: [text()] });
  await adapter.hooks.event?.({
    event: { type: "message.updated", properties: { info: modelMessage() } },
  });
  const output = { headers: { "X-Test": "kept" } };

  await expect(adapter.hooks["chat.headers"]?.(modelRequest()[0], output)).resolves.toBeUndefined();

  expect(output.headers).toEqual({ "X-Test": "kept" });
  expect(failures).toEqual([failure]);
  adapter.close();
});

test("source messages become run operations with explicit unsupported associations", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [text(), { ...text(), id: "synthetic", synthetic: true }]);
  coordinator.userMessage(user("u2", 1500), [text("u2", "steer")]);
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2500);

  expect(h.starts).toEqual([
    {
      sessionID: "s1",
      id: "u1",
      startedAt: 1000,
      userID: undefined,
      parent: undefined,
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

test("disabled capture never sends user or assistant bodies across the contract", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: false });

  coordinator.userMessage(user(), [text("u1", "secret input")]);
  reply(coordinator, "secret output");
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.updates[0]?.input.text).toBeUndefined();
  expect(h.finishes[0]?.output).toBeUndefined();
  expect(h.interactions[0]?.input).toBeUndefined();
  expect(
    JSON.stringify([h.starts, h.updates, h.finishes, h.interactions, h.completed]),
  ).not.toContain("secret");
});

test("replayed user hooks cannot reopen an ended run or attach old input to the next run", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [text()]);
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);
  coordinator.userMessage(user(), [text("u1", "replayed")]);
  coordinator.userMessage(user("u2", 3000), [text("u2", "next")]);
  coordinator.userMessage(user(), [text("u1", "late old input")]);
  coordinator.userMessage(user("u1", 1000, "s2"), [{ ...text(), sessionID: "s2" }]);

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

test("recoverable overflow is interpreted before submitting a terminal failure", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer });

  coordinator.userMessage(user(), [text()]);
  coordinator.event(
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

  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

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

test("hooks isolate recording and export failures and return before flush settles", async () => {
  const h = recording();
  const error = new Error("recording failed");
  const flushing = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    observer: {
      ...h.observer,
      startRun() {
        throw error;
      },
      flush() {
        return flushing.promise;
      },
    },
    directory: "/test",
    captureContent: true,
    onDispose: h.observer.shutdown,
    log(error) {
      failures.push(error);
    },
  });
  const output = { message: user(), parts: [text()] };

  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, output);

  expect(failures).toEqual([error]);
  expect(output).toEqual({ message: user(), parts: [text()] });

  await adapter.hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  flushing.reject(new Error("export failed"));
  await flushing.promise.catch(() => undefined);

  expect(failures).toHaveLength(2);
  expect(failures[1]).toEqual(new Error("export failed"));
  adapter.close();
});

test.each(["throw", "reject"])("hooks isolate %s from flush and disposal", async (mode) => {
  const h = recording();
  const exportError = new Error("export failed");
  const disposeError = new Error("disposal failed");
  const failures: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    observer: {
      ...h.observer,
      flush() {
        if (mode === "throw") {
          throw exportError;
        }

        return Promise.reject(exportError);
      },
    },
    directory: "/test",
    captureContent: false,
    log: (error) => failures.push(error),
    onDispose() {
      if (mode === "throw") {
        throw disposeError;
      }

      return Promise.reject(disposeError);
    },
  });

  await expect(
    adapter.hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } }),
  ).resolves.toBeUndefined();
  await expect(
    adapter.hooks.event?.({
      event: { type: "server.instance.disposed", properties: { directory: "/test" } },
    }),
  ).resolves.toBeUndefined();
  await expect(adapter.hooks.dispose?.()).resolves.toBeUndefined();
  await adapter.hooks["chat.message"]?.({ sessionID: "s1" }, { message: user(), parts: [text()] });

  expect(failures).toEqual([exportError, disposeError, disposeError]);
  expect(h.starts).toHaveLength(1);
  adapter.close();
});

test.each(["throw", "reject"])(
  "all hook boundaries contain input errors when logging %s",
  async (mode) => {
    const h = recording();
    const failures: unknown[] = [];
    const errors = ["message", "params", "headers", "event"].map((name) => new Error(name));
    const adapter = createOpenCodeAdapter({
      observer: h.observer,
      directory: "/test",
      captureContent: true,
      onDispose: h.observer.shutdown,
      log(error) {
        failures.push(error);

        if (mode === "throw") {
          throw new Error("logging failed");
        }

        return Promise.reject(new Error("logging failed"));
      },
    });
    await adapter.startModelMessageCapture();
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
    adapter.close();
  },
);

test("interaction uses the owner agent and assistant completion time while run uses idle observation", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage({ ...user(), agent: "review" }, [text()]);
  reply(coordinator, "final");
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2500);

  expect(h.interactions).toEqual([
    {
      run: { sessionID: "s1", id: "u1" },
      id: "u1",
      startedAt: 1000,
      input: "question",
      agentName: "review",
      userID: undefined,
      agentType: undefined,
      parentSessionID: undefined,
    },
  ]);
  expect(h.completed).toEqual([
    {
      run: { sessionID: "s1", id: "u1" },
      id: "u1",
      endedAt: 1200,
      status: "completed",
      output: "final",
    },
  ]);
  expect(h.finishes[0]).toMatchObject({ endedAt: 2500, output: "final" });
});

test("steer supersedes the old interaction exactly at the next input and ignores late old output", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [text()]);
  reply(coordinator, "intermediate");
  coordinator.userMessage(user("u2", 1500), [text("u2", "steer")]);
  coordinator.event({ type: "message.updated", properties: { info: user("continue", 1400) } });
  reply(coordinator, "final", {
    id: "a2",
    parentID: "u2",
    time: { created: 1600, completed: 1700 },
  });
  reply(coordinator, "late old", {
    id: "old",
    parentID: "continue",
    time: { created: 1800, completed: 1900 },
  });
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2500);
  reply(coordinator, "late after idle");
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 3000);

  expect(h.completed).toEqual([
    { run: { sessionID: "s1", id: "u1" }, id: "u1", endedAt: 1500, status: "superseded" },
    {
      run: { sessionID: "s1", id: "u1" },
      id: "u2",
      endedAt: 1700,
      status: "completed",
      output: "final",
    },
  ]);
  expect(h.interactions.map((item) => item.id)).toEqual(["u1", "u2"]);
  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]?.output).toBe("final");
});

test("synthetic and compaction messages retain the interaction through successful recovery", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [{ ...text(), synthetic: true }]);
  coordinator.userMessage(user(), [
    { id: "c", sessionID: "s1", messageID: "u1", type: "compaction", auto: true },
  ]);

  expect(h.interactions).toHaveLength(0);

  coordinator.userMessage(user(), [
    { ...text(), ignored: true },
    { ...text("u1", "real"), id: "real" },
  ]);
  coordinator.event(
    {
      type: "session.error",
      properties: { sessionID: "s1", error: { name: "ContextOverflowError" } },
    },
    1200,
  );
  coordinator.event({ type: "message.updated", properties: { info: user("compact", 1300) } });
  coordinator.event({
    type: "message.part.updated",
    properties: {
      part: { id: "c", sessionID: "s1", messageID: "compact", type: "compaction", auto: true },
    },
  });
  reply(coordinator, "summary", {
    id: "summary",
    parentID: "compact",
    summary: true,
    time: { created: 1300, completed: 1350 },
  });
  coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } });
  coordinator.userMessage(user("continue", 1400), [
    { ...text("continue", "continue"), synthetic: true },
  ]);

  expect(h.completed).toHaveLength(0);

  reply(coordinator, "recovered", {
    id: "a2",
    parentID: "continue",
    time: { created: 1500, completed: 1600 },
  });
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.interactions).toHaveLength(1);
  expect(h.interactions[0]?.input).toBe("real");
  expect(h.completed[0]).toMatchObject({ status: "completed", endedAt: 1600, output: "recovered" });
});

test("latest unfinished assistant causes observed-time cleanup instead of a fabricated completion", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [text()]);
  reply(coordinator, "earlier answer");
  reply(coordinator, "unfinished", { id: "a2", time: { created: 1500 } });
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.completed[0]).toMatchObject({
    status: "failed",
    endedAt: 2000,
    error: { type: "_OTHER", message: "session ended before interaction completed" },
  });
  expect(h.finishes[0]).toMatchObject({ output: undefined, error: undefined });
});

test("terminal assistant error fails its interaction without inventing a run-level failure", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });

  coordinator.userMessage(user(), [text()]);
  reply(coordinator, "partial", {
    error: { name: "UnknownError", data: { message: "generation failed" } },
  });
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.completed[0]).toMatchObject({
    status: "failed",
    error: { type: "UnknownError", message: "generation failed" },
  });
  expect(h.finishes[0]?.error).toBeUndefined();
  expect(h.finishes[0]?.output).toBeUndefined();
});

test("new interactions resolve user identity independently without altering the existing run", () => {
  const h = recording();
  const identity: { value?: string } = {};
  const coordinator = createCoordinator({ observer: h.observer, userID: () => identity.value });

  coordinator.userMessage(user(), [text()]);
  identity.value = "alice";
  coordinator.userMessage(user("u2", 1500), [text("u2", "steer")]);

  expect(h.starts[0]?.userID).toBeUndefined();
  expect(h.interactions.map((item) => item.userID)).toEqual([undefined, "alice"]);
});

test("LLM steps establish observed boundaries, request metadata and normalized usage", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });
  const request = modelRequest();
  coordinator.userMessage(user(), [text()]);
  coordinator.request(...request);
  coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1060);

  expect(h.llms).toHaveLength(0);

  modelPart(coordinator, "step-start", 1100);
  coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "partial") } },
    1150,
  );
  coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "answer") } },
    1200,
  );
  modelPart(coordinator, "step-finish", 1300);

  expect(h.llms[0]).toMatchObject({
    id: "a1",
    interaction: { id: "u1", run: { sessionID: "s1", id: "u1" } },
    startedAt: 1100,
    providerName: "gcp.gemini",
    providerID: "google",
    model: "gemini-request-model",
    operation: "generate_content",
    stream: true,
    input: "question",
    agentName: "build",
    parameters: { temperature: 0, topP: 0.9, topK: 8, maxTokens: 100 },
    agentType: undefined,
    parentSessionID: undefined,
    compactionID: undefined,
  });
  expect(h.llmFinishes[0]).toMatchObject({
    endedAt: 1300,
    output: "answer",
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

  coordinator.event(
    {
      type: "message.updated",
      properties: {
        info: modelMessage({ time: { created: 1050, completed: 3000 }, finish: "stop" }),
      },
    },
    3500,
  );
  modelPart(coordinator, "step-finish", 4000);
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 4500);

  expect(h.llms).toHaveLength(1);
  expect(h.llmFinishes).toHaveLength(1);
  expect(h.llmFinishes[0]?.endedAt).toBe(1300);
  expect(h.completed[0]?.endedAt).toBe(3000);
});

test("LLM spans omit fabricated assistants, unmatched parents, summaries and finish-only observations", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });
  coordinator.userMessage(user(), [text()]);
  reply(coordinator);
  coordinator.event(
    {
      type: "message.updated",
      properties: { info: modelMessage({ id: "summary", summary: true }) },
    },
    1100,
  );
  modelPart(coordinator, "step-start", 1200, "summary");
  coordinator.event(
    {
      type: "message.updated",
      properties: { info: modelMessage({ id: "orphan", parentID: "unknown" }) },
    },
    1100,
  );
  modelPart(coordinator, "step-start", 1200, "orphan");
  coordinator.event(
    { type: "message.updated", properties: { info: modelMessage({ id: "finish-only" }) } },
    1100,
  );
  modelPart(coordinator, "step-finish", 1300, "finish-only");
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);

  expect(h.llms).toEqual([]);
  expect(h.llmFinishes).toEqual([]);
});

test("LLM step events can precede metadata and late synthetic ownership stays with the old interaction", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });
  coordinator.userMessage(user(), [text()]);
  coordinator.userMessage(user("u2", 1500), [text("u2", "steer")]);
  modelPart(coordinator, "step-start", 1600);
  coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "old answer") } },
    1650,
  );
  modelPart(coordinator, "step-finish", 1700);
  coordinator.event(
    { type: "message.updated", properties: { info: modelMessage({ parentID: "continuation" }) } },
    1800,
  );

  expect(h.llms).toHaveLength(0);

  coordinator.event(
    { type: "message.updated", properties: { info: user("continuation", 1400) } },
    1900,
  );

  expect(h.llms[0]).toMatchObject({
    startedAt: 1600,
    interaction: { id: "u1" },
    input: "question",
  });
  expect(h.llmFinishes[0]).toMatchObject({ endedAt: 1700, output: "old answer" });
});

test("LLM retries retain one span, reset attempt text and ignore scheduled retry time", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer, captureContent: true });
  coordinator.userMessage(user(), [text()]);
  coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  modelPart(coordinator, "step-start", 1100);
  coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "failed partial") } },
    1150,
  );
  coordinator.event(
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

  modelPart(coordinator, "step-start", 1600, "a1", { id: "retry-step" });
  coordinator.event(
    {
      type: "message.part.updated",
      properties: { part: { ...text("a1", "recovered"), id: "retry-text" } },
    },
    1650,
  );
  coordinator.event(
    { type: "message.part.updated", properties: { part: text("a1", "late failed partial") } },
    1675,
  );
  modelPart(coordinator, "step-start", 1700, "a1", { id: "retry-step" });
  modelPart(coordinator, "step-finish", 1800);
  modelPart(coordinator, "step-start", 1900, "a1", { id: "late-step" });

  expect(h.llms).toHaveLength(1);
  expect(h.llms[0]?.startedAt).toBe(1100);
  expect(h.llmFinishes).toHaveLength(1);
  expect(h.llmFinishes[0]).toMatchObject({ endedAt: 1800, output: "recovered" });
  expect(h.llmFinishes[0]?.error).toBeUndefined();
});

test("recoverable overflow fails only the active model call and idle cleans unfinished calls", () => {
  const h = recording();
  const coordinator = createCoordinator({ observer: h.observer });
  coordinator.userMessage(user(), [text()]);
  coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
  modelPart(coordinator, "step-start", 1100);
  coordinator.event(
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

  coordinator.event(
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
  coordinator.event({ type: "session.compacted", properties: { sessionID: "s1" } }, 1400);
  coordinator.event(
    { type: "message.updated", properties: { info: modelMessage({ id: "a2" }) } },
    1450,
  );
  modelPart(coordinator, "step-start", 1500, "a2");
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2000);
  coordinator.event({ type: "session.idle", properties: { sessionID: "s1" } }, 2100);

  expect(h.llmFinishes).toHaveLength(2);
  expect(h.llmFinishes[1]).toMatchObject({
    endedAt: 2000,
    error: { type: "_OTHER", message: "session ended before message completed" },
  });
  expect(h.finishes[0]?.error).toBeUndefined();
});

test.each([true, false])(
  "LLM text snapshots respect removal and capture=%s without fabricating token data",
  (captureContent) => {
    const h = recording();
    const coordinator = createCoordinator({ observer: h.observer, captureContent });
    coordinator.userMessage(user(), [text("u1", "secret")]);
    coordinator.event({ type: "message.updated", properties: { info: modelMessage() } }, 1050);
    modelPart(coordinator, "step-start", 1100);
    coordinator.event(
      { type: "message.part.updated", properties: { part: text("a1", "removed") } },
      1150,
    );
    coordinator.event(
      {
        type: "message.part.removed",
        properties: { sessionID: "s1", messageID: "a1", partID: "a1-text" },
      },
      1175,
    );
    coordinator.event(
      { type: "message.part.updated", properties: { part: { ...text("a1", ""), id: "empty" } } },
      1200,
    );
    modelPart(coordinator, "step-finish", 1300, "a1", {
      tokens: {
        input: Number.NaN,
        output: -1,
        reasoning: 0,
        cache: { read: 0, write: Number.POSITIVE_INFINITY },
      },
      cost: Number.NaN,
    });

    expect(h.llms[0]?.input).toBe(captureContent ? "secret" : undefined);
    expect(h.llmFinishes[0]?.output).toBe(captureContent ? "" : undefined);
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
