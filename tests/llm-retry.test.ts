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
  "OpenCode retry history confirms busy once, including summaries=%s",
  (summary) => {
    const h = setup(summary);
    const retry = { type: "retry" as const, attempt: 1, message: "rate limited", next: 1200 };
    h.tracker.status(h.run, { type: "busy" }, 1050);
    h.tracker.status(h.run, retry, 1100);
    h.tracker.status(h.run, retry, 1150);

    expect(h.updates).toEqual([]);

    h.tracker.status(h.run, { type: "busy" }, 1240);
    h.tracker.status(h.run, { type: "busy" }, 1250);
    h.tracker.status(h.run, retry, 1260);
    h.tracker.status(h.run, { type: "busy" }, 1270);

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.retries).toEqual([
      { attempt: 1, reason: "rate limited", scheduledAt: 1200, observedAt: 1240 },
    ]);

    h.tracker.status(h.run, { ...retry, attempt: 2, message: "unavailable", next: 1500 }, 1300);
    h.tracker.status(h.run, retry, 1350);
    h.tracker.status(h.run, { type: "busy" }, 1490);

    expect(h.updates[0]?.retries).toHaveLength(1);
    expect(h.updates[1]?.retries).toEqual([
      { attempt: 1, reason: "rate limited", scheduledAt: 1200, observedAt: 1240 },
      { attempt: 2, reason: "unavailable", scheduledAt: 1500, observedAt: 1490 },
    ]);
  },
);

test.each(["close", "remove", "fail"] as const)(
  "pending retries do not survive %s or leak into later calls",
  (terminal) => {
    const h = setup();
    h.tracker.status(h.run, { type: "retry", attempt: 1, message: "wait", next: 2000 }, 1100);
    if (terminal === "remove") {
      h.tracker.remove(h.run, "a1", 1200);
    }
    if (terminal === "close") {
      h.tracker.close(h.run, 1200);
    }
    if (terminal === "fail") {
      h.tracker.fail(h.run, 1200, { type: "MessageAbortedError" });
    }
    h.tracker.status(h.run, { type: "busy" }, 2000);
    h.start("a2");
    h.tracker.status(h.run, { type: "busy" }, 2100);

    expect(h.updates).toEqual([]);
  },
);

test.each(["a1", "a2"])(
  "ambiguous status discards pending retries when %s is removed later",
  (removed) => {
    const h = setup();
    h.tracker.status(h.run, { type: "retry", attempt: 1, message: "wait", next: 1500 }, 1100);
    h.start("a2");
    h.tracker.status(h.run, { type: "busy" }, 1500);
    h.tracker.status(h.run, { type: "retry", attempt: 2, message: "ambiguous", next: 1800 }, 1600);
    h.tracker.remove(h.run, removed, 1700);
    h.tracker.status(h.run, { type: "busy" }, 1800);
    if (removed === "a2") {
      h.tracker.status(h.run, { type: "retry", attempt: 1, message: "late", next: 1900 }, 1850);
      h.tracker.status(h.run, { type: "busy" }, 1900);
    }

    expect(h.updates).toEqual([]);
  },
);

test("retry observations are isolated by run and missing busy events do not invent executions", () => {
  const h = setup();
  const next = { ...h.run, id: "r2" };
  const other = { ...h.run, sessionID: "s2" };
  h.start("a1", next);
  h.start("a1", other);
  const retry = { type: "retry" as const, attempt: 1, message: "wait", next: 1500 };
  h.tracker.status(h.run, retry, 1100);
  h.tracker.status(next, { type: "busy" }, 1500);
  h.tracker.status(other, { type: "busy" }, 1500);
  h.tracker.status(h.run, { ...retry, attempt: 3, next: 1800 }, 1600);
  h.tracker.status(h.run, { type: "busy" }, 1820);

  expect(h.updates).toHaveLength(1);
  expect(h.updates[0]).toMatchObject({
    interaction: { run: h.run },
    retries: [{ attempt: 3, reason: "wait", scheduledAt: 1800, observedAt: 1820 }],
  });
});

test("invalid retry sequence numbers are ignored and invalid schedules are omitted", () => {
  const h = setup();
  [0, -1, 1.5, NaN, Infinity].forEach((attempt) => {
    h.tracker.status(h.run, { type: "retry", attempt, message: "bad", next: 1200 }, 1100);
    h.tracker.status(h.run, { type: "busy" }, 1300);
  });
  expect(h.updates).toEqual([]);

  h.tracker.status(h.run, { type: "retry", attempt: 1, message: "wait", next: NaN }, 1400);
  h.tracker.status(h.run, { type: "busy" }, 1500);
  expect(h.updates[0]?.retries).toEqual([
    { attempt: 1, reason: "wait", scheduledAt: undefined, observedAt: 1500 },
  ]);
});
