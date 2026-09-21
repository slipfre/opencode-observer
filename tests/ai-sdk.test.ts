import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@opencode-ai/sdk";
import type { OnStartEvent, OnStepStartEvent, OnStepFinishEvent, OnToolCallStartEvent } from "ai";
import { jsonSchema, Output, streamText, tool } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LlmFinish, LlmUpdate, Observer } from "../src/contract/observer.js";
import { createCoordinator } from "../src/adapter/opencode/coordinator.js";
import type { ChatParamsHookArgs } from "../src/adapter/model/request.js";

const adapters: ReturnType<typeof createCoordinator>[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.hooks.dispose()));
});

async function setup(
  captureContent = true,
  log?: (error: unknown) => unknown,
  now?: () => number,
  captureHttpHeaders?: boolean,
) {
  const updates: LlmUpdate[] = [];
  const finishes: LlmFinish[] = [];
  const errors: unknown[] = [];
  const observer: Observer = {
    startTool() {},
    updateTool() {},
    finishTool() {},
    startSkill() {},
    updateSkill() {},
    finishSkill() {},
    startCompaction() {},
    finishCompaction() {},
    startPermission() {},
    finishPermission() {},
    startRun() {},
    updateRun() {},
    finishRun() {},
    startInteraction() {},
    finishInteraction() {},
    startLlm() {},
    llmTraceHeaders() {
      return undefined;
    },
    updateLlm(input) {
      updates.push(input);
    },
    finishLlm(input) {
      finishes.push(input);
    },
    flush: async () => {},
    shutdown: async () => {},
  };
  const adapter = createCoordinator({
    observer,
    captureContent,
    captureHttpHeaders,
    now,
    log(error) {
      errors.push(error);
      return log?.(error);
    },
  });
  adapters.push(adapter);
  await adapter.startSdkModelCapture();
  const input: ChatParamsHookArgs[0] = {
    sessionID: "s1",
    agent: "build",
    message: {
      id: "u1",
      sessionID: "s1",
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1000 },
    },
    model: { id: "test", providerID: "test" } as ChatParamsHookArgs[0]["model"],
    provider: {} as ChatParamsHookArgs[0]["provider"],
  };
  await adapter.hooks["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: input.message,
      parts: [{ id: "text", sessionID: "s1", messageID: "u1", type: "text", text: "fallback" }],
    },
  );
  const assistant: AssistantMessage = {
    id: "a1",
    sessionID: "s1",
    parentID: "u1",
    role: "assistant",
    time: { created: 1050 },
    modelID: "test",
    providerID: "test",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  await adapter.hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: assistant,
      },
    },
  });

  return {
    adapter,
    observer,
    input,
    updates,
    finishes,
    errors,
    async complete(overrides: Partial<AssistantMessage> = {}) {
      await adapter.hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              ...assistant,
              time: { created: 1050, completed: 1400 },
              finish: "stop",
              ...overrides,
            },
          },
        },
      });
    },
    async headers() {
      const output = { headers: { "X-Test": "kept" } };
      await adapter.hooks["chat.headers"]?.(input, output);

      // OpenCode merges headers into a new object before starting AI SDK.
      return { ...output.headers } as Record<string, string>;
    },
    async step(
      type: "step-start" | "step-finish",
      time?: number,
      id = type === "step-start" ? "start" : "finish",
    ) {
      await adapter.hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            ...(time === undefined ? {} : { time }),
            part:
              type === "step-start"
                ? { id, sessionID: "s1", messageID: "a1", type }
                : {
                    id,
                    sessionID: "s1",
                    messageID: "a1",
                    type,
                    reason: "stop",
                    cost: 0,
                    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                  },
          },
        },
      });
    },
  };
}

function integration() {
  const value = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS?.at(-1);

  if (!value) {
    throw new Error("Missing AI SDK integration");
  }

  return value;
}

function inputEvent(
  metadata: Record<string, unknown>,
  headers: Record<string, string>,
  text = "full input",
): OnStepStartEvent {
  return {
    functionId: "session.llm",
    metadata,
    headers,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: text },
    ],
    system: undefined,
    providerOptions: undefined,
    stepNumber: 0,
  } as OnStepStartEvent;
}

function outputEvent(metadata: Record<string, unknown>, text = "full output"): OnStepFinishEvent {
  return {
    functionId: "session.llm",
    metadata,
    content: [{ type: "text", text }],
    response: { messages: [] },
  } as unknown as OnStepFinishEvent;
}

function toolEvent(metadata: Record<string, unknown>, stepNumber = 0): OnToolCallStartEvent {
  return {
    functionId: "session.llm",
    metadata,
    stepNumber,
    toolCall: { type: "tool-call", toolCallId: "call1", toolName: "read", input: {} },
    messages: [],
    model: undefined,
    abortSignal: undefined,
    experimental_context: undefined,
  };
}

async function startReadTool(h: Awaited<ReturnType<typeof setup>>) {
  await h.adapter.hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: "tool-part",
          messageID: "a1",
          sessionID: "s1",
          callID: "call1",
          tool: "read",
          state: { status: "running", input: {}, time: { start: 1200 } },
        },
      },
    },
  });
}

test.each([true, false])(
  "tool descriptions respect content=%s without waiting for parameter schemas",
  async (captureContent) => {
    const h = await setup(captureContent);
    const started = spyOn(h.observer, "startTool");
    const metadata = {};
    const read = tool({
      description: "Read a file",
      inputSchema: jsonSchema(() => new Promise<never>(() => {})),
    });
    if (!captureContent) {
      Object.defineProperty(read, "description", {
        get() {
          throw new Error("disabled content must not be read");
        },
      });
    }

    await integration().onStepStart?.({
      ...inputEvent(metadata, await h.headers()),
      tools: { read },
    });
    await integration().onToolCallStart?.(toolEvent(metadata));
    await startReadTool(h);

    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]?.[0].description).toBe(captureContent ? "Read a file" : undefined);
    expect(h.errors).toEqual([]);
  },
);

test("tool descriptions use the active step and binding and ignore excluded tools", async () => {
  const h = await setup();
  const updated = spyOn(h.observer, "updateTool");
  const metadata = {};
  const read = tool({ description: "Original description", inputSchema: jsonSchema({}) });
  await integration().onStepStart?.({
    ...inputEvent(metadata, await h.headers()),
    tools: { read },
    activeTools: [],
  });
  await startReadTool(h);
  updated.mockClear();
  await integration().onToolCallStart?.(toolEvent(metadata));
  expect(updated).not.toHaveBeenCalled();

  await integration().onStepStart?.({
    ...inputEvent(metadata, {}),
    stepNumber: 1,
    tools: { read },
  });
  read.description = "Changed after snapshot";
  await integration().onToolCallStart?.(toolEvent(metadata));
  await integration().onToolCallStart?.(toolEvent({}, 1));
  await integration().onToolCallStart?.({ ...toolEvent(metadata, 1), functionId: "session.title" });
  expect(updated).not.toHaveBeenCalled();

  await integration().onToolCallStart?.(toolEvent(metadata, 1));
  expect(updated).toHaveBeenCalledTimes(1);
  expect(updated.mock.calls[0]?.[0].description).toBe("Original description");
  await integration().onStepFinish?.(outputEvent(metadata));
  await integration().onToolCallStart?.(toolEvent(metadata, 1));
  await h.adapter.hooks.dispose();
  await integration().onToolCallStart?.(toolEvent(metadata, 1));
  expect(updated).toHaveBeenCalledTimes(1);
});

test("tool descriptions stay isolated between plugin bindings", async () => {
  const first = await setup();
  const second = await setup();
  const firstStart = spyOn(first.observer, "startTool");
  const secondStart = spyOn(second.observer, "startTool");
  const firstMetadata = {};
  const secondMetadata = {};
  await integration().onStepStart?.({
    ...inputEvent(firstMetadata, await first.headers()),
    tools: { read: tool({ description: "First instance", inputSchema: jsonSchema({}) }) },
  });
  await integration().onStepStart?.({
    ...inputEvent(secondMetadata, await second.headers()),
    tools: { read: tool({ description: "Second instance", inputSchema: jsonSchema({}) }) },
  });
  await integration().onToolCallStart?.(toolEvent(firstMetadata));
  await integration().onToolCallStart?.(toolEvent(secondMetadata));
  await startReadTool(first);
  await startReadTool(second);

  expect(firstStart.mock.calls[0]?.[0].description).toBe("First instance");
  expect(secondStart.mock.calls[0]?.[0].description).toBe("Second instance");
});

test.each([true, false])("response models are captured with content=%s", async (captureContent) => {
  const h = await setup(captureContent);
  const event = inputEvent({}, await h.headers());
  await integration().onStepStart?.(event);
  await h.step("step-start");
  await h.step("step-finish");
  await h.complete();
  expect(h.finishes).toHaveLength(0);

  await integration().onStepFinish?.({
    ...outputEvent(event.metadata!),
    response: { ...outputEvent(event.metadata!).response, modelId: "response-model" },
  });

  expect(h.updates.at(-1)?.responseModel).toBe("response-model");
  expect(h.finishes).toHaveLength(1);
  const updates = [...h.updates];
  await integration().onStepFinish?.({
    ...outputEvent(event.metadata!),
    response: { ...outputEvent(event.metadata!).response, modelId: "late-model" },
  });
  expect(h.updates).toEqual(updates);
  expect(h.errors).toEqual([]);
});

test.each([true, false])(
  "first chunk uses step publication time and survives retries with content=%s",
  async (captureContent) => {
    const clock = { time: 1100 };
    const h = await setup(captureContent, undefined, () => clock.time);
    const first = inputEvent({}, await h.headers());
    await integration().onStepStart?.(first);

    clock.time = 1400;
    await h.adapter.hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: { type: "retry", attempt: 1, message: "busy", next: 1600 },
        },
      },
    });
    clock.time = 1700;
    await h.adapter.hooks.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    });
    const retry = inputEvent({}, await h.headers());
    await integration().onStepStart?.(retry);
    clock.time = 2300;
    await h.step("step-start", 2100);

    expect(h.updates.flatMap((update) => update.firstChunkObservedAt ?? [])).toEqual([2100]);

    // Duplicate events, later steps, and old SDK bindings never replace the first observation.
    await h.step("step-start", 2200);
    await integration().onStepStart?.(inputEvent(first.metadata!, {}));
    await integration().onStepStart?.(inputEvent(retry.metadata!, {}));
    await h.step("step-start", 2400, "next-step");
    await integration().onStepFinish?.(outputEvent(retry.metadata!));
    await h.step("step-finish");
    await h.complete({ time: { created: 1050, completed: 2600 } });
    await h.step("step-start", 2800, "late-step");

    expect(h.updates.flatMap((update) => update.firstChunkObservedAt ?? [])).toEqual([2100]);
    expect(h.finishes).toHaveLength(1);
    expect(h.errors).toEqual([]);
  },
);

test.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "first chunk falls back to receipt time for unavailable publication time %s",
  async (time) => {
    const clock = { time: 1100 };
    const h = await setup(false, undefined, () => clock.time);
    await integration().onStepStart?.(inputEvent({}, await h.headers()));

    clock.time = 1500;
    await h.step("step-start", time);

    expect(h.updates.at(-1)?.firstChunkObservedAt).toBe(1500);
  },
);

test("a backwards first-step timestamp is preserved for final validation, never replaced", async () => {
  const h = await setup(false, undefined, () => 1100);
  await integration().onStepStart?.(inputEvent({}, await h.headers()));

  await h.step("step-start", 1000);
  await h.step("step-start", 1400, "next-step");

  expect(h.updates.flatMap((update) => update.firstChunkObservedAt ?? [])).toEqual([1000]);
});

test.each(["missing", "late", "retry"])(
  "first chunk observation does not require an SDK start: %s",
  async (mode) => {
    const h = await setup(false, undefined, () => 1100);
    if (mode === "retry") {
      await h.headers();
      await h.adapter.hooks.event({
        event: {
          type: "session.status",
          properties: {
            sessionID: "s1",
            status: { type: "retry", attempt: 1, message: "busy", next: 1200 },
          },
        },
      });
      await integration().onStepStart?.(inputEvent({}, await h.headers()));
    }

    await h.step("step-start", 1400);
    if (mode === "late") {
      await integration().onStepStart?.(inputEvent({}, await h.headers()));
      await h.step("step-start", 1500, "next-step");
    }

    expect(h.updates.flatMap((update) => update.firstChunkObservedAt ?? [])).toEqual([1400]);
  },
);

test.each([true, false])(
  "AI SDK snapshots survive callback ordering with output first=%s",
  async (outputFirst) => {
    const h = await setup();
    const headers = await h.headers();
    const metadata = { sessionId: "s1" };

    expect(headers["x-opencode-observer-request"]).toBeDefined();
    await integration().onStart?.(inputEvent(metadata, headers) as unknown as OnStartEvent);
    expect(headers).toEqual({ "X-Test": "kept" });
    await integration().onStepStart?.(inputEvent(metadata, headers));
    await h.step("step-start");

    expect(h.updates[0]?.input).toEqual({
      messages: [
        { role: "system", parts: [{ type: "text", text: "system" }] },
        { role: "user", parts: [{ type: "text", text: "full input" }] },
      ],
    });

    if (outputFirst) {
      await integration().onStepFinish?.(outputEvent(metadata));
    }

    await h.step("step-finish");
    await h.complete();

    if (!outputFirst) {
      expect(h.finishes).toHaveLength(0);
      await integration().onStepFinish?.(outputEvent(metadata));
    }

    expect(h.finishes).toHaveLength(1);
    expect(h.updates.at(-1)?.output).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "full output" }] },
    ]);
    const count = h.updates.length;
    await integration().onStepFinish?.(outputEvent(metadata, "late"));
    expect(h.updates).toHaveLength(count);
    expect(h.errors).toEqual([]);
  },
);

test("AI SDK bindings isolate identical sessions in different instances and ignore title or unbound callbacks", async () => {
  const first = await setup();
  const second = await setup();
  const firstHeaders = await first.headers();
  const secondHeaders = await second.headers();
  const metadata = { sessionId: "s1" };

  expect(firstHeaders["x-opencode-observer-request"]).not.toBe(
    secondHeaders["x-opencode-observer-request"],
  );
  await integration().onStepStart?.(inputEvent(metadata, firstHeaders));
  await first.step("step-start");
  await second.step("step-start", 1200);
  await integration().onStepFinish?.(outputEvent({ sessionId: "s1" }, "unbound"));
  await integration().onStepFinish?.({
    ...outputEvent(metadata, "title"),
    functionId: "agent.title",
  });

  expect(first.updates).toHaveLength(2);
  expect(second.updates).toEqual([
    {
      id: "a1",
      interaction: { id: "u1", run: { id: "u1", sessionID: "s1" } },
      firstChunkObservedAt: 1200,
    },
  ]);

  await integration().onStepFinish?.(outputEvent(metadata));
  expect(first.updates).toHaveLength(3);
  expect(second.updates).toHaveLength(1);
});

test.each(["throw", "reject"])(
  "AI SDK continues other listeners when one listener and its logging %s",
  async (mode) => {
    const failure = new Error("model recording failed");
    const first = await setup(true, () => {
      if (mode === "throw") {
        throw new Error("logging failed");
      }

      return Promise.reject(new Error("logging failed"));
    });
    const second = await setup();
    const metadata = {};
    await integration().onStepStart?.(inputEvent(metadata, await first.headers()));
    await integration().onStepStart?.(inputEvent(metadata, await second.headers()));
    await first.step("step-start");
    await second.step("step-start");
    first.observer.updateLlm = () => {
      throw failure;
    };

    await integration().onStepFinish?.(outputEvent(metadata));
    await Bun.sleep(0);

    expect(first.errors).toEqual([failure]);
    expect(second.errors).toEqual([]);
    expect(second.updates.at(-1)?.output).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "full output" }] },
    ]);
  },
);

test("AI SDK removes headers synchronously despite input recording and diagnostic failures", async () => {
  const failure = new Error("model input recording failed");
  const h = await setup(true, () => Promise.reject(new Error("logging failed")));
  await h.step("step-start");
  const headers = await h.headers();
  h.observer.updateLlm = () => {
    throw failure;
  };

  const result = integration().onStepStart?.(inputEvent({}, headers));

  expect(headers).toEqual({ "X-Test": "kept" });
  await result;
  await Bun.sleep(0);
  expect(h.errors).toEqual([failure]);
});

test.each(["throw", "reject"])(
  "failed model settings preserve other fields when logging %s",
  async (mode) => {
    const failure = new Error("schema unavailable");
    const log = mock(() => {
      if (mode === "throw") {
        throw new Error("logging failed");
      }

      return Promise.reject(new Error("logging failed"));
    });
    const h = await setup(true, log);
    const metadata = {};

    await integration().onStepStart?.({
      ...inputEvent(metadata, await h.headers()),
      output: Output.json(),
      tools: {
        broken: tool({ inputSchema: jsonSchema(() => Promise.reject(failure)) }),
        working: tool({ inputSchema: jsonSchema({ type: "object" }) }),
      },
    });
    await Bun.sleep(0);

    expect(h.errors).toEqual([failure]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(failure);
    expect(h.updates.at(-1)?.request?.outputType).toBe("json");
    expect(h.updates.at(-1)?.request?.toolDefinitions).toEqual([
      { type: "function", name: "broken", parameters: undefined },
      { type: "function", name: "working", parameters: { type: "object" } },
    ]);

    await integration().onStepFinish?.(outputEvent(metadata));
    await h.step("step-finish");
    await h.complete();

    expect(h.finishes).toHaveLength(1);
    expect(h.errors).toEqual([failure]);
  },
);

test.each(["onStart", "onStepStart"] as const)(
  "AI SDK %s contains header cleanup failures and only logs to active instances",
  async (callback) => {
    const disposed = await setup();
    await disposed.adapter.hooks.dispose();
    const first = await setup(true, () => {
      throw new Error("logging failed");
    });
    const second = await setup(true, () => Promise.reject(new Error("logging failed")));
    const headers = Object.freeze({ "x-opencode-observer-request": "unbound", "X-Test": "kept" });
    const event = inputEvent({}, headers) as OnStartEvent & OnStepStartEvent;

    await expect(integration()[callback]?.(event)).resolves.toBeUndefined();
    await Bun.sleep(0);

    expect(disposed.errors).toEqual([]);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toBeInstanceOf(TypeError);
    expect(second.errors).toEqual(first.errors);
    expect(headers["X-Test"]).toBe("kept");

    await first.adapter.hooks.dispose();
    await second.adapter.hooks.dispose();
    await expect(integration()[callback]?.(event)).resolves.toBeUndefined();
    expect(first.errors).toHaveLength(1);
    expect(second.errors).toHaveLength(1);
  },
);

test("dispose continues observer shutdown when capture cleanup fails", async () => {
  const h = await setup();
  const failure = new Error("capture cleanup failed");
  h.observer.shutdown = mock(async () => {});
  const root = globalThis as typeof globalThis & {
    __opencodeObserverModelCapture: { listeners: Set<unknown> };
  };
  const listeners = root.__opencodeObserverModelCapture.listeners;
  const cleanup = spyOn(listeners, "delete").mockImplementation((listener) => {
    Set.prototype.delete.call(listeners, listener);
    throw failure;
  });

  try {
    const disposal = h.adapter.hooks.dispose();
    expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
    await expect(disposal).resolves.toBeUndefined();
    await h.adapter.hooks.dispose();
  } finally {
    cleanup.mockRestore();
  }

  expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
  expect(h.errors).toEqual([failure]);
});

test("closing during SDK setup prevents late listener registration and restart", async () => {
  const active = await setup();
  const shutdown = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  const closing = createCoordinator({
    observer: { ...active.observer, shutdown: () => shutdown.promise },
    log: (error) => errors.push(error),
  });
  adapters.push(closing);

  const installation = closing.startSdkModelCapture();
  const disposal = closing.hooks.dispose();

  try {
    await installation;
    await closing.startSdkModelCapture();
    await integration().onStart?.(
      inputEvent({}, Object.freeze({ "x-opencode-observer-request": "unbound" })) as OnStartEvent &
        OnStepStartEvent,
    );

    expect(active.errors).toHaveLength(1);
    expect(active.errors[0]).toBeInstanceOf(TypeError);
    expect(errors).toEqual([]);
  } finally {
    shutdown.resolve();
    await disposal;
  }

  await closing.startSdkModelCapture();
  await integration().onStart?.(
    inputEvent({}, Object.freeze({ "x-opencode-observer-request": "unbound" })) as OnStartEvent &
      OnStepStartEvent,
  );

  expect(active.errors).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("retry bindings discard old callbacks and session end releases a missing SDK output", async () => {
  const h = await setup();
  const firstMetadata = {};
  await integration().onStepStart?.(inputEvent(firstMetadata, await h.headers(), "first"));
  await h.step("step-start");
  const secondMetadata = {};
  await integration().onStepStart?.(inputEvent(secondMetadata, await h.headers(), "retry"));
  await integration().onStepFinish?.(outputEvent(firstMetadata, "stale attempt"));
  await h.step("step-finish");
  await h.complete();

  expect(h.finishes).toHaveLength(0);
  expect(
    h.updates.filter((value) => value.input).map((value) => value.input?.messages.at(-1)?.parts),
  ).toEqual([[{ type: "text", text: "first" }], [{ type: "text", text: "retry" }]]);

  await h.adapter.hooks.event?.({
    event: { type: "session.idle", properties: { sessionID: "s1" } },
  });
  await integration().onStepFinish?.(outputEvent(secondMetadata, "too late"));

  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]?.error).toBeUndefined();
  expect(h.finishes[0]?.endedAt).toBe(1400);
  expect(h.updates).toHaveLength(3);
});

test.each(["dispose", "remove"] as const)(
  "%s preserves assistant completion while SDK output is still pending",
  async (termination) => {
    const h = await setup();
    await integration().onStepStart?.(inputEvent({}, await h.headers()));
    await h.step("step-start");
    await h.step("step-finish");
    await h.complete();

    expect(h.finishes).toHaveLength(0);

    if (termination === "dispose") {
      await h.adapter.hooks.dispose();
    }
    if (termination === "remove") {
      await h.adapter.hooks.event({
        event: { type: "message.removed", properties: { sessionID: "s1", messageID: "a1" } },
      });
    }

    expect(h.finishes).toHaveLength(1);
    expect(h.finishes[0]?.endedAt).toBe(1400);
    expect(h.finishes[0]?.error).toBeUndefined();
  },
);

test("a late step cannot clear completed results while SDK output is pending", async () => {
  const h = await setup();
  const metadata = {};
  await integration().onStepStart?.(inputEvent(metadata, await h.headers()));
  await h.step("step-start");
  await h.step("step-finish");
  await h.complete();
  await h.adapter.hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: "late-step", sessionID: "s1", messageID: "a1", type: "step-start" },
      },
    },
  });
  await integration().onStepFinish?.(outputEvent(metadata));

  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]).toMatchObject({
    endedAt: 1400,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

test.each([false, true])(
  "run cleanup invalidates SDK callbacks before the next run, observer failure=%s",
  async (failure) => {
    const h = await setup();
    const old = inputEvent({}, await h.headers(), "first run");
    await integration().onStepStart?.(old);
    await h.step("step-start");
    const error = new Error("finish failed");
    if (failure) {
      spyOn(h.observer, "finishLlm").mockImplementationOnce(() => {
        throw error;
      });
    }

    await h.adapter.hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    const next = { ...h.input, message: { ...h.input.message, id: "u2", time: { created: 2000 } } };
    await h.adapter.hooks["chat.message"](
      { sessionID: "s1" },
      {
        message: next.message,
        parts: [
          { id: "text2", sessionID: "s1", messageID: "u2", type: "text", text: "second run" },
        ],
      },
    );
    await h.adapter.hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "a1",
            sessionID: "s1",
            parentID: "u2",
            role: "assistant",
            mode: "build",
            modelID: "test",
            providerID: "test",
            path: { cwd: "/test", root: "/test" },
            time: { created: 2100 },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });
    const output = { headers: {} };
    await h.adapter.hooks["chat.headers"](next, output);
    const current = inputEvent({}, { ...output.headers }, "second run");
    await integration().onStepStart?.(current);
    const count = h.updates.length;

    await integration().onStepFinish?.(outputEvent(old.metadata!, "late first run"));
    expect(h.updates).toHaveLength(count);
    await integration().onStepFinish?.(outputEvent(current.metadata!, "second response"));
    await h.step("step-finish");
    await h.complete({ parentID: "u2", time: { created: 2100, completed: 2200 } });

    expect(h.finishes.at(-1)?.interaction.run.id).toBe("u2");
    expect(h.updates.at(-1)?.output?.[0]?.parts[0]).toEqual({
      type: "text",
      text: "second response",
    });
    expect(h.errors).toEqual(failure ? [error] : []);
  },
);

test.each([true, false])(
  "default text output is captured before pending tool schemas with content=%s",
  async (captureContent) => {
    const h = await setup(captureContent);
    const schema = Promise.withResolvers<{ type: "object" }>();
    const event = {
      ...inputEvent({}, await h.headers()),
      tools: { read: tool({ inputSchema: jsonSchema(() => schema.promise) }) },
    };
    await integration().onStepStart?.(event);
    await h.step("step-start");

    expect(h.updates.findLast((update) => update.request)?.request?.outputType).toBe("text");

    await integration().onStepFinish?.(outputEvent(event.metadata!));
    await h.step("step-finish");
    await h.complete();
    const count = h.updates.length;
    schema.resolve({ type: "object" });
    await Bun.sleep(0);

    expect(h.updates).toHaveLength(count);
    expect(h.finishes).toHaveLength(1);
    expect(h.errors).toEqual([]);
  },
);

test("unresolved settings never block callbacks or discard an observed response", async () => {
  const h = await setup(true, undefined, undefined, true);
  const format = Promise.withResolvers<{ type: "json" }>();
  const event = {
    ...inputEvent({}, await h.headers()),
    output: { ...Output.text(), responseFormat: format.promise },
  };
  await integration().onStepStart?.(event);
  await h.step("step-start");
  await integration().onStepFinish?.({
    ...outputEvent(event.metadata!),
    response: { ...outputEvent(event.metadata!).response, headers: { "x-response": "kept" } },
  });
  await h.step("step-finish");
  await h.complete();

  expect(h.finishes).toHaveLength(1);
  const count = h.updates.length;
  format.resolve({ type: "json" });
  await Bun.sleep(0);

  expect(h.updates).toHaveLength(count);
  expect(h.updates.at(-1)?.output?.[0]?.parts[0]).toEqual({ type: "text", text: "full output" });
  expect(h.updates.at(-1)?.responseHeaders).toEqual({ "x-response": ["kept"] });
  expect(h.updates.every((update) => update.request?.outputType === undefined)).toBe(true);
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test("late async settings cannot replace a retry's request snapshot", async () => {
  const h = await setup();
  const format = Promise.withResolvers<{ type: "json" }>();
  const first = {
    ...inputEvent({}, await h.headers(), "old"),
    output: { ...Output.text(), responseFormat: format.promise },
  };
  await integration().onStepStart?.(first);
  await h.step("step-start");
  await integration().onStepFinish?.(outputEvent(first.metadata!, "old response"));
  const retry = inputEvent({}, await h.headers(), "retry");
  await integration().onStepStart?.(retry);
  const count = h.updates.length;
  format.resolve({ type: "json" });
  await Bun.sleep(0);

  expect(h.updates).toHaveLength(count);
  expect(h.updates.at(-1)?.input?.messages.at(-1)?.parts[0]).toEqual({
    type: "text",
    text: "retry",
  });
  expect(h.updates.at(-1)?.request?.outputType).toBe("text");
  await integration().onStepFinish?.(outputEvent(retry.metadata!, "retry response"));
  await h.step("step-finish");
  await h.complete();
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test.each(["session end", "dispose"])("%s invalidates pending async settings", async (boundary) => {
  const h = await setup();
  const format = Promise.withResolvers<{ type: "json" }>();
  await integration().onStepStart?.({
    ...inputEvent({}, await h.headers()),
    output: { ...Output.text(), responseFormat: format.promise },
  });
  await h.step("step-start");
  expect(h.updates).toHaveLength(2);

  await (boundary === "dispose"
    ? h.adapter.hooks.dispose()
    : h.adapter.hooks.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      }));
  const updates = structuredClone(h.updates);
  const finishes = structuredClone(h.finishes);

  format.resolve({ type: "json" });
  await Bun.sleep(0);

  expect(h.updates).toEqual(updates);
  expect(h.finishes).toEqual(finishes);
  expect(h.errors).toEqual([]);
});

test.each([
  [true, false],
  [true, undefined],
  [false, true],
] as const)(
  "SDK headers are not parsed with content=%s headers=%s",
  async (captureContent, captureHttpHeaders) => {
    const h = await setup(captureContent, undefined, undefined, captureHttpHeaders);
    const headers = await h.headers();
    Object.defineProperty(headers, "x-secret", {
      enumerable: true,
      get() {
        throw new Error("request headers must not be read");
      },
    });
    const event = inputEvent({}, headers);

    await integration().onStepStart?.(event);
    await integration().onStepFinish?.({
      ...outputEvent(event.metadata!),
      response: {
        ...outputEvent(event.metadata!).response,
        get headers(): never {
          throw new Error("response headers must not be read");
        },
      },
    });

    expect(h.updates).toHaveLength(2);
    expect(h.updates[0]?.request?.headers).toBeUndefined();
    expect(h.updates[1]?.responseHeaders).toBeUndefined();
    expect(h.updates[0]?.input !== undefined).toBe(captureContent);
    expect(h.updates[1]?.output !== undefined).toBe(captureContent);
    expect(h.errors).toEqual([]);
  },
);

test.each(
  (
    [
      [true, true],
      [true, false],
      [true, undefined],
      [false, true],
    ] as const
  ).flatMap(([content, headers]) =>
    (["message", "session"] as const).map((source) => [content, headers, source] as const),
  ),
)(
  "API error headers require content=%s headers=%s via %s",
  async (captureContent, captureHttpHeaders, source) => {
    const h = await setup(captureContent, undefined, undefined, captureHttpHeaders);
    await h.headers();
    const error = {
      name: "APIError" as const,
      data: {
        message: "request failed",
        isRetryable: false,
        get responseHeaders() {
          if (!captureContent || !captureHttpHeaders) {
            throw new Error("error response headers must not be read");
          }
          return { "X-Error": "terminal" };
        },
      },
    };

    if (source === "message") {
      await h.complete({ error });
    }
    if (source === "session") {
      await h.adapter.hooks.event({
        event: { type: "session.error", properties: { sessionID: "s1", error } },
      });
    }

    expect(h.finishes).toHaveLength(1);
    expect(h.finishes[0]?.responseHeaders).toEqual(
      captureContent && captureHttpHeaders ? { "x-error": ["terminal"] } : undefined,
    );
    expect(h.errors).toEqual([]);
  },
);

test("capture disabled and disposed instances do not parse content and remove request markers", async () => {
  const enabled = await setup();
  const disabled = await setup(false);
  const headers = await enabled.headers();
  await enabled.adapter.hooks.dispose();
  expect(await enabled.headers()).toEqual({ "X-Test": "kept" });
  const disabledHeaders = await disabled.headers();
  const event = inputEvent({}, headers);
  Object.defineProperty(event, "messages", {
    get() {
      throw new Error("body must not be read");
    },
  });
  await integration().onStepStart?.(event);
  const disabledEvent = inputEvent({}, disabledHeaders);
  ["messages", "system", "providerOptions", "tools", "activeTools"].forEach((key) => {
    Object.defineProperty(disabledEvent, key, {
      get() {
        throw new Error("content must not be read");
      },
    });
  });
  await integration().onStepStart?.(disabledEvent);
  await disabled.step("step-start");
  await integration().onStepFinish?.({
    metadata: disabledEvent.metadata,
    functionId: "session.llm",
    get content() {
      throw new Error("output must not be read");
    },
    response: {
      modelId: "response-model",
      get headers() {
        throw new Error("response headers must not be read");
      },
      get messages() {
        throw new Error("response messages must not be read");
      },
    },
  } as unknown as OnStepFinishEvent);

  expect(headers).toEqual({ "X-Test": "kept" });
  expect(enabled.updates).toEqual([]);
  expect(disabledHeaders).toEqual({ "X-Test": "kept" });
  expect(
    disabled.updates.every(
      (update) =>
        update.input === undefined &&
        update.output === undefined &&
        update.responseHeaders === undefined,
    ),
  ).toBe(true);
  expect(disabled.updates[0]?.request).toEqual({ outputType: "text" });
  expect(disabled.updates.at(-1)?.responseModel).toBe("response-model");
  expect(enabled.errors).toEqual([]);
  expect(disabled.errors).toEqual([]);
});

test("unmatched and ambiguous assistant requests keep the event fallback without adding markers", async () => {
  const h = await setup();
  const unmatched = { headers: {} };
  await h.adapter.hooks["chat.headers"]?.({ ...h.input, agent: "title" }, unmatched);
  expect(unmatched.headers).toEqual({});
  await h.adapter.hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a2",
          sessionID: "s1",
          parentID: "u1",
          role: "assistant",
          time: { created: 1060 },
          modelID: "test",
          providerID: "test",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });

  expect(await h.headers()).toEqual({ "X-Test": "kept" });
  await h.step("step-start", 1200);
  await h.step("step-finish");
  await h.complete();

  expect(h.updates).toEqual([
    {
      id: "a1",
      interaction: { id: "u1", run: { id: "u1", sessionID: "s1" } },
      firstChunkObservedAt: 1200,
    },
  ]);
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test("summary LLMs use the same SDK snapshot channel once their compaction parent exists", async () => {
  const h = await setup();
  const marker = { ...h.input.message, id: "compact", time: { created: 1200 } };
  await h.adapter.hooks.event?.({
    event: { type: "message.updated", properties: { info: marker } },
  });
  await h.adapter.hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "marker",
          messageID: "compact",
          sessionID: "s1",
          type: "compaction",
          auto: true,
        },
      },
    },
  });
  await h.adapter.hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "summary",
          sessionID: "s1",
          parentID: "compact",
          role: "assistant",
          time: { created: 1250 },
          modelID: "test",
          providerID: "test",
          mode: "compaction",
          summary: true,
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  const output = { headers: {} };
  await h.adapter.hooks["chat.headers"]?.(
    { ...h.input, message: marker, agent: "compaction" },
    output,
  );
  const metadata = {};
  await integration().onStepStart?.(inputEvent(metadata, output.headers, "summary history"));
  await h.adapter.hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "summary-start",
          messageID: "summary",
          sessionID: "s1",
          type: "step-start",
        },
      },
    },
  });
  await integration().onStepFinish?.(outputEvent(metadata, "captured summary"));
  await h.adapter.hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "summary-finish",
          messageID: "summary",
          sessionID: "s1",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });

  await h.complete({
    id: "summary",
    parentID: "compact",
    mode: "compaction",
    summary: true,
    time: { created: 1250, completed: 1400 },
  });

  expect(h.updates[0]?.id).toBe("summary");
  expect(h.updates[0]?.input?.messages.at(-1)?.parts).toEqual([
    { type: "text", text: "summary history" },
  ]);
  expect(h.updates.at(-1)?.output?.[0]?.parts).toEqual([
    { type: "text", text: "captured summary" },
  ]);
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test("native LLM runtime prepares trace headers without callback capture or a request marker", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM;
  process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "true";

  try {
    const h = await setup();
    const headers = {
      traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
      tracestate: "vendor=value",
    };
    h.observer.llmTraceHeaders = () => headers;

    expect(await h.headers()).toEqual({ "X-Test": "kept", ...headers });
    await h.step("step-start", 1200);
    await h.step("step-finish");
    await h.complete();

    expect(h.updates).toEqual([
      {
        id: "a1",
        interaction: { id: "u1", run: { id: "u1", sessionID: "s1" } },
        firstChunkObservedAt: 1200,
      },
    ]);
    expect(h.finishes).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM;
    }

    if (previous !== undefined) {
      process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = previous;
    }
  }
});

test.each([
  [true, true, "json"],
  [true, true, "text"],
  [true, false, "json"],
  [true, undefined, "text"],
  [false, true, "json"],
  [false, undefined, "text"],
] as const)(
  "real AI SDK streaming captures settings with content=%s headers=%s output=%s and strips the marker",
  async (captureContent, captureHttpHeaders, outputType) => {
    const h = await setup(captureContent, undefined, undefined, captureHttpHeaders);
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "reason" },
          { type: "reasoning-delta", id: "reason", delta: "consider" },
          { type: "reasoning-end", id: "reason" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: '{"answer":"real answer"}' },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
        response: {
          headers: { "content-type": "text/event-stream", "x-model-request": "request-1" },
        },
      }),
    });
    const response = streamText({
      model,
      headers: await h.headers(),
      output: outputType === "json" ? Output.json() : undefined,
      tools: {
        read: tool({
          description: "Read a file",
          inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
        }),
        unused: tool({ inputSchema: jsonSchema({ type: "object" }) }),
      },
      activeTools: ["read"],
      messages: [
        { role: "system", content: "actual system" },
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "actual question" },
      ],
      experimental_telemetry: {
        isEnabled: false,
        functionId: "session.llm",
        metadata: { sessionId: "s1" },
      },
    });

    for await (const part of response.fullStream) {
      if (part.type === "start-step") {
        await h.step("step-start");
      }

      if (part.type === "finish-step") {
        await h.step("step-finish");
        await h.complete();
      }
    }

    expect(await response.text).toBe('{"answer":"real answer"}');
    expect(model.doStreamCalls[0]?.headers?.["x-opencode-observer-request"]).toBeUndefined();
    expect(model.doStreamCalls[0]?.headers?.["X-Test"]).toBe("kept");
    const request = h.updates.findLast((update) => update.request?.outputType)?.request;
    expect(request?.outputType).toBe(outputType);
    expect(request?.toolDefinitions).toEqual(
      captureContent
        ? [
            {
              type: "function",
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ]
        : undefined,
    );
    expect(request?.headers).toEqual(
      captureContent && captureHttpHeaders ? { "x-test": ["kept"] } : undefined,
    );
    // Without provider response metadata, the SDK supplies the request model ID.
    expect(h.updates.at(-1)?.responseModel).toBe(model.modelId);
    expect(h.updates.at(-1)?.responseHeaders).toEqual(
      captureContent && captureHttpHeaders
        ? {
            "content-type": ["text/event-stream"],
            "x-model-request": ["request-1"],
          }
        : undefined,
    );

    if (!captureContent) {
      expect(
        h.updates.every((update) => update.input === undefined && update.output === undefined),
      ).toBe(true);
      expect(h.finishes).toHaveLength(1);
      expect(h.errors).toEqual([]);
      return;
    }
    expect(h.updates.find((value) => value.input)?.input).toEqual({
      messages: [
        { role: "system", parts: [{ type: "text", text: "actual system" }] },
        { role: "user", parts: [{ type: "text", text: "previous question" }] },
        { role: "assistant", parts: [{ type: "text", text: "previous answer" }] },
        { role: "user", parts: [{ type: "text", text: "actual question" }] },
      ],
    });
    expect(h.updates.at(-1)?.output).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "consider" },
          { type: "text", text: '{"answer":"real answer"}' },
        ],
      },
    ]);
    expect(h.finishes).toHaveLength(1);
    expect(h.errors).toEqual([]);
  },
);
