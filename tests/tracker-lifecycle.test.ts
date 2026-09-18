import { expect, mock, test } from "bun:test";
import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk";
import type { Observer, RunReference } from "../src/contract/observer.js";
import type { LlmRequest } from "../src/adapter/model/request.js";
import { createLlmTracker } from "../src/adapter/trackers/llm.js";
import { createToolTracker } from "../src/adapter/trackers/tool.js";
import { createCompactionTracker } from "../src/adapter/trackers/compaction.js";
import { createInteractionTracker } from "../src/adapter/trackers/interaction.js";
import { createPermissionTracker } from "../src/adapter/trackers/permission.js";

function recording() {
  return {
    startRun: mock(() => {}),
    updateRun: mock(() => {}),
    finishRun: mock(() => {}),
    startInteraction: mock(() => {}),
    finishInteraction: mock(() => {}),
    startLlm: mock(() => {}),
    updateLlm: mock(() => {}),
    finishLlm: mock(() => {}),
    llmTraceHeaders: mock(() => undefined),
    startTool: mock(() => {}),
    updateTool: mock(() => {}),
    finishTool: mock(() => {}),
    startCompaction: mock(() => {}),
    finishCompaction: mock(() => {}),
    startPermission: mock(() => {}),
    finishPermission: mock(() => {}),
    flush: async () => {},
    shutdown: async () => {},
  } satisfies Observer;
}

test("interaction ownership survives steer and late messages until its run is released", () => {
  const observer = recording();
  const tracker = createInteractionTracker({ observer, captureContent: true });
  const first = { sessionID: "s1", id: "r1" };
  const next = { sessionID: "s1", id: "r2" };
  const other = { sessionID: "s2", id: "r1" };
  const user: UserMessage = {
    id: "input",
    sessionID: "s1",
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: 1000 },
  };
  [first, next, other].forEach((run) => {
    tracker.open(run);
    tracker.start(run, { ...user, sessionID: run.sessionID }, "question", {});
  });

  tracker.open(first);
  tracker.start(first, { ...user, id: "steer", time: { created: 2000 } }, "follow-up", {});
  tracker.message(first, { ...user, id: "continuation", time: { created: 1500 } });
  tracker.message(first, { ...user, id: "continuation", time: { created: 2500 } });

  expect(tracker.resolve(first, "continuation")).toEqual({
    reference: { run: first, id: "input" },
    userInputText: "question",
    agentName: "build",
  });
  expect(tracker.resolve(first, "input")).toEqual(tracker.resolve(first, "continuation"));
  expect(tracker.at(first, 999)).toBeUndefined();
  expect(tracker.at(first, 1000)).toEqual(tracker.resolve(first, "input"));
  expect(tracker.at(first, 1999)).toEqual(tracker.resolve(first, "input"));
  expect(tracker.at(first, 2000)).toEqual(tracker.resolve(first, "steer"));
  expect(tracker.at(first, 2500)?.userInputText).toBe("follow-up");
  expect(tracker.resolve(next, "continuation")).toBeUndefined();
  expect(tracker.resolve(other, "continuation")).toBeUndefined();
  expect(observer.finishInteraction).toHaveBeenCalledTimes(1);
  expect(observer.finishInteraction).toHaveBeenCalledWith({
    run: first,
    id: "input",
    endedAt: 2000,
    status: "superseded",
  });

  tracker.release(first);
  tracker.release(first);
  tracker.start(first, user, "stale", {});
  tracker.message(first, { ...user, id: "late", time: { created: 3000 } });

  expect(tracker.resolve(first, "input")).toBeUndefined();
  expect(tracker.resolve(first, "continuation")).toBeUndefined();
  expect(tracker.resolve(first, "late")).toBeUndefined();
  expect(tracker.at(first, 3000)).toBeUndefined();
  expect(observer.startInteraction).toHaveBeenCalledTimes(4);
  [next, other].forEach((run) => {
    expect(tracker.resolve(run, "input")).toEqual({
      reference: { run, id: "input" },
      userInputText: "question",
      agentName: "build",
    });
  });

  tracker.open(first);
  expect(tracker.resolve(first, "input")).toBeUndefined();
  expect(tracker.resolve(first, "continuation")).toBeUndefined();
  expect(tracker.at(first, 3000)).toBeUndefined();
});

test("tool partitions isolate full run identities and release parts waiting for ownership", () => {
  const observer = recording();
  const tracker = createToolTracker({
    observer,
    captureContent: true,
    onTask() {},
    onFinish() {},
  });
  function associate(run: RunReference) {
    tracker.unresolved(run).forEach((call) => {
      tracker.associate(run, call.messageID, call.callID, {
        reference: { run, id: "input" },
        userInputText: undefined,
      });
    });
  }
  const first = { sessionID: "s1", id: "r1" };
  const next = { sessionID: "s1", id: "r2" };
  const other = { sessionID: "s2", id: "r1" };
  const part: ToolPart = {
    type: "tool",
    id: "part",
    messageID: "assistant",
    sessionID: "s1",
    callID: "call",
    tool: "read",
    state: { status: "running", input: { path: "private" }, time: { start: 1000 } },
  };
  [first, next, other].forEach((run) => {
    tracker.open(run);
    tracker.part(run, { ...part, sessionID: run.sessionID }, 1000);
  });
  expect(observer.startTool).not.toHaveBeenCalled();
  expect(tracker.unresolved(next)).toEqual([{ messageID: "assistant", callID: "call" }]);

  tracker.close(first, 1100);
  tracker.release(first);
  associate(first);
  tracker.part(first, part, 1200);
  associate(next);
  associate(other);

  expect(observer.startTool).toHaveBeenCalledTimes(2);
  expect(observer.startTool).toHaveBeenCalledWith(
    expect.objectContaining({ interaction: { run: next, id: "input" } }),
  );
  expect(observer.startTool).toHaveBeenCalledWith(
    expect.objectContaining({ interaction: { run: other, id: "input" } }),
  );

  // Explicitly registering an empty partition cannot revive its old unowned parts.
  tracker.open(first);
  associate(first);
  tracker.close(next, 1300);
  tracker.release(next);
  tracker.release(next);
  tracker.part(next, part, 1400);
  expect(observer.startTool).toHaveBeenCalledTimes(2);
  expect(observer.finishTool).toHaveBeenCalledTimes(1);
  expect(tracker.active(other, "assistant", "call")).toBeDefined();
});

test("LLM bindings expire on release even when the same run and message are registered again", () => {
  const observer = recording();
  const tracker = createLlmTracker({
    observer,
    captureContent: true,
  });
  const first = { sessionID: "s1", id: "r1" };
  const next = { sessionID: "s1", id: "r2" };
  const other = { sessionID: "s2", id: "r1" };
  const message: AssistantMessage = {
    id: "assistant",
    sessionID: "s1",
    parentID: "input",
    role: "assistant",
    mode: "build",
    modelID: "test",
    providerID: "test",
    path: { cwd: "/test", root: "/test" },
    time: { created: 1000 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  function bind(run: RunReference) {
    const request = {
      sessionID: run.sessionID,
      agent: "build",
      message: {
        id: "input",
        sessionID: run.sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        time: { created: 900 },
      },
      model: { id: "test", providerID: "test" } as LlmRequest[0]["model"],
      provider: {} as LlmRequest[0]["provider"],
    } satisfies LlmRequest[0];
    const starts = observer.startLlm.mock.calls.length;
    tracker.open(run);
    tracker.message(run, { ...message, sessionID: run.sessionID }, 1000);
    tracker.prepare(run, request);
    expect(tracker.bind(run, request)).toBeUndefined();
    expect(tracker.activeRequest(run)).toBeUndefined();
    expect(observer.startLlm).toHaveBeenCalledTimes(starts);
    expect(tracker.unresolved(run)).toEqual([
      { id: "assistant", parentID: "input", summary: undefined },
    ]);

    tracker.part(run, {
      type: "step-start",
      id: "step",
      messageID: "assistant",
      sessionID: run.sessionID,
    });
    tracker.associate(run, "assistant", {
      reference: { run, id: "input" },
      userInputText: undefined,
    });
    tracker.associate(run, "assistant", {
      reference: { run, id: "different" },
      userInputText: "must not replace the established owner",
    });
    expect(observer.startLlm).toHaveBeenCalledTimes(starts + 1);
    expect(tracker.activeRequest(run)).toEqual({
      messageID: "assistant",
      parentMessageID: "input",
    });
    expect(observer.startLlm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interaction: { run, id: "input" },
        startedAt: 1000,
      }),
    );
    const capture = tracker.bind(run, request);
    expect(capture).toBeDefined();
    return capture!;
  }
  const old = bind(first);
  const second = bind(next);
  const concurrent = bind(other);

  tracker.release(first);
  expect(tracker.activeRequest(first)).toBeUndefined();
  const replacement = bind(first);
  old.input({ input: { messages: [{ role: "user", parts: [{ type: "text", text: "stale" }] }] } });
  old.output({ output: [{ role: "assistant", parts: [{ type: "text", text: "stale" }] }] });

  expect(old.active()).toBe(false);
  expect(replacement.active()).toBe(true);
  expect(second.active()).toBe(true);
  expect(concurrent.active()).toBe(true);
  expect(observer.updateLlm).not.toHaveBeenCalled();

  tracker.close(next, 1200);
  tracker.release(next);
  expect(second.active()).toBe(false);
  expect(concurrent.active()).toBe(true);
  expect(observer.finishLlm).toHaveBeenCalledTimes(1);
  expect(tracker.activeRequest(next)).toBeUndefined();
  expect(tracker.activeRequest(other)).toEqual({
    messageID: "assistant",
    parentMessageID: "input",
  });
  expect(observer.finishLlm).toHaveBeenCalledWith(
    expect.objectContaining({ interaction: { run: next, id: "input" } }),
  );
});

test("compaction waits for resolved ownership and retains it for summary queries until release", () => {
  const observer = recording();
  const onFinish = mock(() => {});
  const tracker = createCompactionTracker({ observer, onFinish });
  const run = { sessionID: "s1", id: "u1" };
  const context = { reference: { run, id: "u1" }, userInputText: "private", agentName: "build" };
  tracker.open(run);
  tracker.part(
    run,
    { type: "compaction", id: "part", messageID: "marker", sessionID: "s1", auto: true },
    1200,
  );

  expect(observer.startCompaction).not.toHaveBeenCalled();
  expect(tracker.active(run)).toBe("marker");
  expect(tracker.resolve(run, "marker")).toBeUndefined();
  expect(tracker.unresolved(run)).toEqual([{ id: "marker", startedAt: 1200 }]);

  tracker.associate(run, "marker", context);
  tracker.associate(run, "marker", { ...context, reference: { run, id: "u2" } });
  tracker.completed(run, 1500);
  tracker.completed(run, 1600);
  expect(tracker.active(run)).toBeUndefined();
  expect(observer.startCompaction).toHaveBeenCalledTimes(1);
  expect(observer.finishCompaction).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(tracker.unresolved(run)).toEqual([]);
  expect(tracker.resolve(run, "marker")).toEqual({ ...context, userInputText: undefined });

  tracker.release(run);
  tracker.associate(run, "marker", context);
  expect(tracker.resolve(run, "marker")).toBeUndefined();
  expect(observer.startCompaction).toHaveBeenCalledTimes(1);
});

test("compaction replacement ignores old markers and removals while retaining their context", () => {
  const observer = recording();
  const onFinish = mock(() => {});
  const tracker = createCompactionTracker({ observer, onFinish });
  const run = { sessionID: "s1", id: "run" };
  const context = { reference: { run, id: "input" }, userInputText: undefined };
  const marker = {
    type: "compaction" as const,
    id: "part1",
    messageID: "marker1",
    sessionID: "s1",
    auto: true,
  };
  tracker.open(run);
  tracker.part(run, marker, 1000);
  tracker.associate(run, "marker1", context);

  tracker.part(run, { ...marker, id: "part2", messageID: "marker2" }, 1200);
  tracker.associate(run, "marker2", context);
  tracker.part(run, marker, 1300);
  tracker.remove(run, "marker1", 1400);
  tracker.remove(run, "marker2", 1400, "part1");

  expect(tracker.active(run)).toBe("marker2");
  expect(tracker.resolve(run, "marker1")).toEqual(context);
  expect(observer.startCompaction).toHaveBeenCalledTimes(2);
  expect(observer.finishCompaction).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledWith(
    run,
    "marker1",
    1200,
    expect.objectContaining({
      message: "a new compaction started before the previous compaction completed",
    }),
  );

  tracker.remove(run, "marker2", 1500, "part2");
  tracker.completed(run, 1600);
  expect(tracker.active(run)).toBeUndefined();
  expect(tracker.resolve(run, "marker2")).toEqual(context);
  expect(observer.finishCompaction).toHaveBeenCalledTimes(2);
  expect(onFinish).toHaveBeenCalledTimes(2);

  tracker.release(run);
  tracker.open(run);
  expect(tracker.active(run)).toBeUndefined();
  expect(tracker.resolve(run, "marker1")).toBeUndefined();
  expect(tracker.resolve(run, "marker2")).toBeUndefined();
});

test("permission requests and deduplication remain isolated across run release and cleanup", () => {
  const observer = recording();
  const tracker = createPermissionTracker({ observer });
  const first = { sessionID: "s1", id: "r1" };
  const next = { sessionID: "s1", id: "r2" };
  const other = { sessionID: "s2", id: "r1" };
  function tool(run: RunReference) {
    return {
      interaction: { run, id: "input" },
      messageID: "assistant",
      callID: "call",
      name: "read",
      startedAt: 1000,
    };
  }
  function ask(run: RunReference) {
    tracker.asked(
      run,
      {
        id: "permission",
        sessionID: run.sessionID,
        permission: "read",
        patterns: ["src/*"],
        metadata: {},
        always: [],
        tool: { messageID: "assistant", callID: "call" },
      },
      1100,
      tool(run),
    );
  }
  [first, next, other].forEach((run) => {
    tracker.open(run);
    ask(run);
    ask(run);
  });
  expect(observer.startPermission).toHaveBeenCalledTimes(3);

  tracker.closeTool(tool(first), 1200);
  tracker.release(first);
  ask(first);
  expect(tracker.replied(first, "permission", "reject", 1300)).toBeUndefined();
  tracker.close(next, 1400);
  tracker.close(next, 1500);
  ask(next);
  expect(observer.startPermission).toHaveBeenCalledTimes(3);
  expect(observer.finishPermission).toHaveBeenCalledTimes(2);

  expect(tracker.replied(other, "permission", "reject", 1600)).toEqual({
    interaction: { run: other, id: "input" },
    messageID: "assistant",
    callID: "call",
  });
  expect(observer.finishPermission).toHaveBeenCalledTimes(3);
  expect(tracker.replied(other, "permission", "reject", 1700)).toBeUndefined();

  tracker.open(first);
  ask(first);
  expect(observer.startPermission).toHaveBeenCalledTimes(4);
  tracker.replied(first, "permission", "once", 1800);
  expect(observer.finishPermission).toHaveBeenCalledTimes(4);
});
