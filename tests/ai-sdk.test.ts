import { afterEach, expect, test } from "bun:test";
import type { OnStartEvent, OnStepStartEvent, OnStepFinishEvent } from "ai";
import { streamText } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LlmFinish, LlmUpdate, Observer } from "../src/contract/observer.js";
import { createOpencodeAdapter } from "../src/adapter/opencode.js";
import type { LlmRequest } from "../src/adapter/llm.js";

const adapters: ReturnType<typeof createOpencodeAdapter>[] = [];

afterEach(() => adapters.splice(0).forEach((adapter) => adapter.close()));

async function setup(captureContent = true) {
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
    updateLlm(input) {
      updates.push(input);
    },
    finishLlm(input) {
      finishes.push(input);
    },
    flush: async () => {},
    shutdown: async () => {},
  };
  const adapter = createOpencodeAdapter({
    observer,
    captureContent,
    directory: "/test",
    onError: (error) => errors.push(error),
    onDispose: observer.shutdown,
  });
  adapters.push(adapter);
  await adapter.captureMessages();
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

test("capture disabled and disposed instances do not parse model bodies or retain request markers", async () => {
  const enabled = await setup();
  const disabled = await setup(false);
  const headers = await enabled.headers();
  enabled.adapter.close();
  expect(await disabled.headers()).toEqual({ "X-Test": "kept" });
  const event = inputEvent({}, headers);
  Object.defineProperty(event, "messages", {
    get() {
      throw new Error("body must not be read");
    },
  });
  await integration().onStepStart?.(event);

  expect(headers).toEqual({ "X-Test": "kept" });
  expect(enabled.updates).toEqual([]);
  expect(disabled.updates).toEqual([]);
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

test("native LLM runtime skips callback capture and sends no request marker", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM;
  process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "true";

  try {
    const h = await setup();
    expect(await h.headers()).toEqual({ "X-Test": "kept" });
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

test("real AI SDK streaming captures full step messages and removes the correlation header before doStream", async () => {
  const h = await setup();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "reason" },
        { type: "reasoning-delta", id: "reason", delta: "consider" },
        { type: "reasoning-end", id: "reason" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "real answer" },
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
    }),
  });
  const response = streamText({
    model,
    headers: await h.headers(),
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

  expect(await response.text).toBe("real answer");
  expect(model.doStreamCalls[0]?.headers?.["x-opencode-observer-request"]).toBeUndefined();
  expect(model.doStreamCalls[0]?.headers?.["X-Test"]).toBe("kept");
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
        { type: "text", text: "real answer" },
      ],
    },
  ]);
  expect(h.finishes).toHaveLength(1);
  expect(h.errors).toEqual([]);
});
