import { expect, test } from "bun:test";
import type { AssistantMessage } from "@opencode-ai/sdk";
import type { LlmUpdate, Observer, RunReference } from "../src/contract/observer.js";
import { createLlmTracker } from "../src/adapter/trackers/llm.js";

function setup(summary = false) {
  const updates: LlmUpdate[] = [];
  const observer: Observer = {
    startRun() {},
    updateRun() {},
    finishRun() {},
    startInteraction() {},
    finishInteraction() {},
    startLlm() {},
    updateLlm(input) {
      updates.push(input);
    },
    finishLlm() {},
    llmTraceHeaders: () => undefined,
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
    flush: async () => {},
    shutdown: async () => {},
  };
  const tracker = createLlmTracker({ observer });
  const run = { sessionID: "s1", id: "r1" };

  function start(id = "a1", scope: RunReference = run) {
    const message: AssistantMessage = {
      id,
      sessionID: scope.sessionID,
      parentID: "u1",
      role: "assistant",
      time: { created: 1000 },
      providerID: "test",
      modelID: "test",
      mode: "build",
      summary,
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    tracker.open(scope);
    tracker.message(scope, message, 1000, {
      reference: { run: scope, id: "u1" },
      userInputText: undefined,
    });
    tracker.part(scope, {
      id: `step-${id}`,
      sessionID: scope.sessionID,
      messageID: id,
      type: "step-start",
    });
  }

  start();
  return { tracker, run, start, updates };
}

test.each([false, true])(
  "OpenCode retry count uses the reported attempt immediately, including summaries=%s",
  (summary) => {
    const h = setup(summary);
    const retry = { type: "retry" as const, attempt: 1, message: "rate limited", next: 1200 };
    h.tracker.status(h.run, { type: "busy" });
    h.tracker.status(h.run, retry);
    h.tracker.status(h.run, retry);

    expect(h.updates).toEqual([{ id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 1 }]);

    h.tracker.status(h.run, { type: "busy" });
    h.tracker.status(h.run, { type: "busy" });
    h.tracker.status(h.run, retry);
    h.tracker.status(h.run, { type: "busy" });

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toEqual({
      id: "a1",
      interaction: { id: "u1", run: h.run },
      retryCount: 1,
    });

    h.tracker.status(h.run, { ...retry, attempt: 2, message: "unavailable", next: 1500 });
    h.tracker.status(h.run, retry);
    h.tracker.status(h.run, { type: "busy" });

    expect(h.updates).toHaveLength(2);
    expect(h.updates[0]?.retryCount).toBe(1);
    expect(h.updates[1]).toEqual({
      id: "a1",
      interaction: { id: "u1", run: h.run },
      retryCount: 2,
    });
  },
);

test.each(["close", "remove", "fail"] as const)(
  "reported retry count survives %s during backoff without leaking into later calls",
  (terminal) => {
    const h = setup();
    h.tracker.status(h.run, { type: "retry", attempt: 1, message: "wait", next: 2000 });
    if (terminal === "remove") {
      h.tracker.remove(h.run, "a1", 1200);
    }
    if (terminal === "close") {
      h.tracker.close(h.run, 1200);
    }
    if (terminal === "fail") {
      h.tracker.fail(h.run, 1200, { type: "MessageAbortedError" });
    }
    h.tracker.status(h.run, { type: "busy" });
    h.start("a2");
    h.tracker.status(h.run, { type: "busy" });

    expect(h.updates).toEqual([{ id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 1 }]);

    h.tracker.status(h.run, { type: "retry", attempt: 1, message: "new call", next: 2500 });

    expect(h.updates).toHaveLength(2);
    expect(h.updates[1]).toEqual({
      id: "a2",
      interaction: { id: "u1", run: h.run },
      retryCount: 1,
    });
  },
);

test.each(["a1", "a2"])(
  "ambiguous retries remain unassigned when %s is removed later",
  (removed) => {
    const h = setup();
    h.tracker.status(h.run, { type: "retry", attempt: 1, message: "wait", next: 1500 });
    h.start("a2");
    h.tracker.status(h.run, { type: "busy" });
    h.tracker.status(h.run, { type: "retry", attempt: 2, message: "ambiguous", next: 1800 });
    h.tracker.remove(h.run, removed, 1700);
    h.tracker.status(h.run, { type: "busy" });
    if (removed === "a2") {
      h.tracker.status(h.run, { type: "retry", attempt: 1, message: "late", next: 1900 });
      h.tracker.status(h.run, { type: "busy" });
    }

    expect(h.updates).toEqual([{ id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 1 }]);
  },
);

test("retry counts are isolated by run and accept reported attempt gaps without busy events", () => {
  const h = setup();
  const next = { ...h.run, id: "r2" };
  const other = { ...h.run, sessionID: "s2" };
  h.start("a1", next);
  h.start("a1", other);
  const retry = { type: "retry" as const, attempt: 1, message: "wait", next: 1500 };
  h.tracker.status(h.run, retry);
  h.tracker.status(next, { type: "busy" });
  h.tracker.status(other, { type: "busy" });
  h.tracker.status(h.run, { ...retry, attempt: 3, next: 1800 });

  expect(h.updates).toEqual([
    { id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 1 },
    { id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 3 },
  ]);
});

test("invalid retry sequence numbers are ignored and unused metadata is never read", () => {
  const h = setup();
  [0, -1, 1.5, NaN, Infinity].forEach((attempt) => {
    h.tracker.status(h.run, { type: "retry", attempt, message: "bad", next: 1200 });
    h.tracker.status(h.run, { type: "busy" });
  });
  expect(h.updates).toEqual([]);

  h.tracker.status(h.run, {
    type: "retry",
    attempt: 1,
    get message(): string {
      throw new Error("retry reason must not be read");
    },
    get next(): number {
      throw new Error("retry schedule must not be read");
    },
  });
  expect(h.updates[0]).toEqual({ id: "a1", interaction: { id: "u1", run: h.run }, retryCount: 1 });
});
