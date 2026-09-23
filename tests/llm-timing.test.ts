import { expect, mock, test } from "bun:test";
import type { AssistantMessage } from "@opencode-ai/sdk";
import type { Observer } from "../src/contract/observer.js";
import type { ChatParamsHookArgs } from "../src/adapter/model/request.js";
import { createLlmTracker } from "../src/adapter/trackers/llm.js";

function setup(llmTimingMode: "message" | "fetch" = "fetch") {
  const observer = {
    startLlm: mock<Observer["startLlm"]>(() => {}),
    updateLlm: mock<Observer["updateLlm"]>(() => {}),
    finishLlm: mock<Observer["finishLlm"]>(() => {}),
    llmTraceHeaders: mock(() => ({ traceparent: "test-trace" })),
  };
  const tracker = createLlmTracker({ observer: observer as unknown as Observer, llmTimingMode });
  const run = { sessionID: "s1", id: "u1" };
  const message: AssistantMessage = {
    id: "a1",
    sessionID: "s1",
    parentID: "u1",
    role: "assistant",
    mode: "build",
    modelID: "test",
    providerID: "test",
    time: { created: 1000 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    path: { cwd: "/test", root: "/test" },
  };
  const context = { reference: { run, id: "u1" }, userInputText: undefined };
  const input = {
    sessionID: "s1",
    agent: "build",
    model: { id: "test", providerID: "test" },
    message: { id: "u1" },
  } as ChatParamsHookArgs[0];
  tracker.open(run);
  tracker.message(run, message, 1000, context);
  tracker.prepareTraceHeaders(run, input);
  const capture = tracker.bindFetch(run, input)!;
  return {
    tracker,
    observer,
    run,
    input,
    capture,
    message,
    context,
    complete() {
      tracker.part(
        run,
        {
          type: "step-finish",
          id: "finish",
          sessionID: "s1",
          messageID: "a1",
          reason: "stop",
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
        1900,
      );
      tracker.message(
        run,
        { ...message, time: { created: 1000, completed: 2000 }, finish: "stop" },
        2000,
        context,
      );
      return observer.finishLlm.mock.calls.at(-1)?.[0];
    },
  };
}

test("message mode keeps assistant times even if a transport observation is supplied", () => {
  const h = setup("message");
  h.capture.start(1200)(1300, "eof");
  expect(h.complete()).toMatchObject({ endedAt: 2000 });
  expect(h.observer.startLlm.mock.calls[0]?.[0].startedAt).toBe(1000);
  expect(h.observer.finishLlm.mock.calls[0]?.[0].timing).toBeUndefined();
});

test("a first step preceding assistant association survives duplicate and retry steps", () => {
  const h = setup();
  const part = { type: "step-start" as const, id: "first", sessionID: "s1", messageID: "a2" };
  h.tracker.part(h.run, part, 1350);
  h.tracker.part(h.run, part, 1400);
  expect(h.observer.updateLlm).not.toHaveBeenCalled();

  h.tracker.message(h.run, { ...h.message, id: "a2" }, 1450, h.context);
  h.tracker.part(h.run, { ...part, id: "retry" }, 1500);
  h.tracker.close(h.run, 1600);
  h.tracker.part(h.run, { ...part, id: "late" }, 1700);

  expect(h.observer.updateLlm.mock.calls.map(([update]) => update)).toEqual([
    { id: "a2", interaction: h.context.reference, firstChunkObservedAt: 1350 },
  ]);
});

test("fetch mode stores the network end and still waits for SDK output and message completion", () => {
  const h = setup();
  const sdk = h.tracker.bind(h.run, h.input)!;
  sdk.input({});
  h.capture.start(1200)(1300, "eof");
  expect(h.observer.finishLlm).not.toHaveBeenCalled();
  expect(h.complete()).toBeUndefined();
  sdk.output({});
  expect(h.observer.finishLlm.mock.calls[0]?.[0]).toMatchObject({
    endedAt: 2000,
    timing: { source: "fetch", startedAt: 1200, endedAt: 1300, endReason: "eof" },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
});

test("first fetch start survives retries and a rebound capture, and latest end wins", () => {
  const h = setup();
  h.capture.start(1200)(1250, "error");
  const retry = h.tracker.bindFetch(h.run, h.input)!;
  const end = retry.start(1500);
  end(1600, "eof");
  end(1800, "cancel");
  expect(h.complete()?.timing).toEqual({
    source: "fetch",
    startedAt: 1200,
    endedAt: 1600,
    endReason: "eof",
  });
  expect(retry.active()).toBe(false);
  retry.start(2100)(2200, "eof");
  expect(h.observer.finishLlm).toHaveBeenCalledTimes(1);
});

test.each(["unobserved", "pending", "retry-unobserved", "first-unobserved", "invalid"])(
  "fetch %s falls back explicitly",
  (state) => {
    const h = setup();
    if (state === "pending") {
      h.capture.start(1200);
    }
    if (state === "retry-unobserved") {
      h.capture.start(1200)(1250, "error");
      h.tracker.bindFetch(h.run, h.input);
    }
    if (state === "first-unobserved") {
      h.tracker.bindFetch(h.run, h.input)!.start(1500)(1600, "eof");
    }
    if (state === "invalid") {
      h.capture.start(1200)(1199, "eof");
    }
    expect(h.complete()?.timing).toEqual({
      source: "message",
      fallbackReason: state === "unobserved" ? "fetch-unobserved" : "fetch-incomplete",
    });
  },
);

test("overlapping requests wait for all observed bodies and preserve cancel as a transport outcome", () => {
  const h = setup();
  const first = h.capture.start(1200);
  const second = h.capture.start(1250);
  second(1300, "eof");
  first(1400, "cancel");
  const result = h.complete();
  expect(result?.timing).toEqual({
    source: "fetch",
    startedAt: 1200,
    endedAt: 1400,
    endReason: "cancel",
  });
  expect(result?.error).toBeUndefined();
});

test("terminal failure preserves observed fetch timing while incomplete disposal falls back", () => {
  const h = setup();
  h.capture.start(1200)(1300, "error");
  h.tracker.close(h.run, 1400, { type: "APIError" });
  expect(h.observer.finishLlm.mock.calls[0]?.[0]).toMatchObject({
    timing: { source: "fetch", startedAt: 1200, endedAt: 1300, endReason: "error" },
    error: { type: "APIError" },
  });
  const pending = setup();
  const late = pending.capture.start(1200);
  pending.tracker.close(pending.run, 1400);
  late(1500, "cancel");
  expect(pending.observer.finishLlm.mock.calls[0]?.[0].timing).toEqual({
    source: "message",
    fallbackReason: "fetch-incomplete",
  });
  expect(pending.observer.finishLlm).toHaveBeenCalledTimes(1);
});
