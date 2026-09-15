import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { OnStartEvent, OnStepStartEvent, OnStepFinishEvent } from "ai";
import { jsonSchema, Output, streamText, tool } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LlmFinish, LlmUpdate, Observer } from "../src/contract/observer.js";
import { createCoordinator } from "../src/adapter/opencode/coordinator.js";
import type { LlmRequest } from "../src/adapter/model/request.js";

const adapters: ReturnType<typeof createCoordinator>[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.hooks.dispose()));
});

async function setup(captureContent = true, log?: (error: unknown) => unknown) {
  const updates: LlmUpdate[] = [];
  const finishes: LlmFinish[] = [];
  const errors: unknown[] = [];
  const observer: Observer = {
    startTool() {},
    updateTool() {},
    finishTool() {},
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
    log(error) {
      errors.push(error);
      return log?.(error);
    },
  });
  adapters.push(adapter);
  await adapter.startModelMessageCapture();
  const input: LlmRequest[0] = {
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
    model: { id: "test", providerID: "test" } as LlmRequest[0]["model"],
    provider: {} as LlmRequest[0]["provider"],
  };
  await adapter.hooks["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: input.message,
      parts: [{ id: "text", sessionID: "s1", messageID: "u1", type: "text", text: "fallback" }],
    },
  );
  await adapter.hooks.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: {
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
        },
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
    async headers() {
      const output = { headers: { "X-Test": "kept" } };
      await adapter.hooks["chat.headers"]?.(input, output);

      // OpenCode merges headers into a new object before starting AI SDK.
      return { ...output.headers } as Record<string, string>;
    },
    async step(type: "step-start" | "step-finish") {
      await adapter.hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: {
            part:
              type === "step-start"
                ? { id: "start", sessionID: "s1", messageID: "a1", type }
                : {
                    id: "finish",
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
    messages: [{ role: "user", content: text }],
    system: "system",
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
      messages: [{ role: "user", parts: [{ type: "text", text: "full input" }] }],
      systemInstructions: [{ type: "text", text: "system" }],
    });

    if (outputFirst) {
      await integration().onStepFinish?.(outputEvent(metadata));
    }

    await h.step("step-finish");

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
  await second.step("step-start");
  await integration().onStepFinish?.(outputEvent({ sessionId: "s1" }, "unbound"));
  await integration().onStepFinish?.({
    ...outputEvent(metadata, "title"),
    functionId: "agent.title",
  });

  expect(first.updates).toHaveLength(1);
  expect(second.updates).toHaveLength(0);

  await integration().onStepFinish?.(outputEvent(metadata));
  expect(first.updates).toHaveLength(2);
  expect(second.updates).toHaveLength(0);
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
    await expect(h.adapter.hooks.dispose()).resolves.toBeUndefined();
    await h.adapter.hooks.dispose();
  } finally {
    cleanup.mockRestore();
  }

  expect(h.observer.shutdown).toHaveBeenCalledTimes(1);
  expect(h.errors).toEqual([failure]);
});

test("closing during SDK setup prevents late listener registration and restart", async () => {
  const active = await setup();
  const errors: unknown[] = [];
  const closing = createCoordinator({
    observer: active.observer,
    log: (error) => errors.push(error),
  });
  adapters.push(closing);

  const installation = closing.startModelMessageCapture();
  await closing.hooks.dispose();
  await installation;
  await closing.startModelMessageCapture();
  await integration().onStart?.(
    inputEvent({}, Object.freeze({ "x-opencode-observer-request": "unbound" })) as OnStartEvent &
      OnStepStartEvent,
  );

  expect(active.errors).toHaveLength(1);
  expect(active.errors[0]).toBeInstanceOf(TypeError);
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

  expect(h.finishes).toHaveLength(0);
  expect(h.updates.map((value) => value.input?.messages[0]?.parts)).toEqual([
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "retry" }],
  ]);

  await h.adapter.hooks.event?.({
    event: { type: "session.idle", properties: { sessionID: "s1" } },
  });
  await integration().onStepFinish?.(outputEvent(secondMetadata, "too late"));

  expect(h.finishes).toHaveLength(1);
  expect(h.finishes[0]?.error).toBeUndefined();
  expect(h.updates).toHaveLength(2);
});

test("unresolved settings never block callbacks or discard an observed response", async () => {
  const h = await setup();
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

  expect(h.finishes).toHaveLength(1);
  const count = h.updates.length;
  format.resolve({ type: "json" });
  await Bun.sleep(0);

  expect(h.updates).toHaveLength(count);
  expect(h.updates.at(-1)?.output?.[0]?.parts[0]).toEqual({ type: "text", text: "full output" });
  expect(h.updates.at(-1)?.responseHeaders).toEqual({ "x-response": ["kept"] });
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
  expect(h.updates.at(-1)?.input?.messages[0]?.parts[0]).toEqual({ type: "text", text: "retry" });
  await integration().onStepFinish?.(outputEvent(retry.metadata!, "retry response"));
  await h.step("step-finish");
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

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
    get response() {
      throw new Error("response must not be read");
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
  expect(disabled.updates[0]?.request).toEqual({});
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
  await h.step("step-start");
  await h.step("step-finish");

  expect(h.updates).toEqual([]);
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

  expect(h.updates[0]?.id).toBe("summary");
  expect(h.updates[0]?.input?.messages[0]?.parts).toEqual([
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
    await h.step("step-start");
    await h.step("step-finish");

    expect(h.updates).toEqual([]);
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

test.each([true, false])(
  "real AI SDK streaming captures settings with content=%s and strips the marker",
  async (captureContent) => {
    const h = await setup(captureContent);
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
      output: Output.json(),
      tools: {
        read: tool({
          description: "Read a file",
          inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } } }),
        }),
        unused: tool({ inputSchema: jsonSchema({ type: "object" }) }),
      },
      activeTools: ["read"],
      system: "actual system",
      messages: [
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
      }
    }

    expect(await response.text).toBe('{"answer":"real answer"}');
    expect(model.doStreamCalls[0]?.headers?.["x-opencode-observer-request"]).toBeUndefined();
    expect(model.doStreamCalls[0]?.headers?.["X-Test"]).toBe("kept");
    const request = h.updates.findLast((update) => update.request?.outputType)?.request;
    expect(request?.outputType).toBe("json");
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
    expect(request?.headers).toEqual(captureContent ? { "x-test": ["kept"] } : undefined);
    expect(h.updates.at(-1)?.responseHeaders).toEqual(
      captureContent
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
        { role: "user", parts: [{ type: "text", text: "previous question" }] },
        { role: "assistant", parts: [{ type: "text", text: "previous answer" }] },
        { role: "user", parts: [{ type: "text", text: "actual question" }] },
      ],
      systemInstructions: [{ type: "text", text: "actual system" }],
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
