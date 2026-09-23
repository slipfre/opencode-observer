import { expect, mock, test } from "bun:test";
import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk";
import type { Observer, RunReference } from "../src/contract/observer.js";
import type { ChatParamsHookArgs } from "../src/adapter/model/request.js";
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
    startSkill: mock(() => {}),
    updateSkill: mock(() => {}),
    finishSkill: mock(() => {}),
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

  expect(tracker.resolveByUserMessage(first, "continuation")).toEqual({
    reference: { run: first, id: "input" },
    userInputText: "question",
    agentName: "build",
  });
  expect(tracker.resolveByUserMessage(first, "input")).toEqual(
    tracker.resolveByUserMessage(first, "continuation"),
  );
  expect(tracker.resolveAt(first, 999)).toBeUndefined();
  expect(tracker.resolveAt(first, 1000)).toEqual(tracker.resolveByUserMessage(first, "input"));
  expect(tracker.resolveAt(first, 1999)).toEqual(tracker.resolveByUserMessage(first, "input"));
  expect(tracker.resolveAt(first, 2000)).toEqual(tracker.resolveByUserMessage(first, "steer"));
  expect(tracker.resolveAt(first, 2500)?.userInputText).toBe("follow-up");
  expect(tracker.resolveByUserMessage(next, "continuation")).toBeUndefined();
  expect(tracker.resolveByUserMessage(other, "continuation")).toBeUndefined();
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

  expect(tracker.resolveByUserMessage(first, "input")).toBeUndefined();
  expect(tracker.resolveByUserMessage(first, "continuation")).toBeUndefined();
  expect(tracker.resolveByUserMessage(first, "late")).toBeUndefined();
  expect(tracker.resolveAt(first, 3000)).toBeUndefined();
  expect(observer.startInteraction).toHaveBeenCalledTimes(4);
  [next, other].forEach((run) => {
    expect(tracker.resolveByUserMessage(run, "input")).toEqual({
      reference: { run, id: "input" },
      userInputText: "question",
      agentName: "build",
    });
  });

  tracker.open(first);
  expect(tracker.resolveByUserMessage(first, "input")).toBeUndefined();
  expect(tracker.resolveByUserMessage(first, "continuation")).toBeUndefined();
  expect(tracker.resolveAt(first, 3000)).toBeUndefined();
});

test.each(["before-part", "before-owner", "after-start"])(
  "tool descriptions correlate by run, message, call and name with arrival=%s",
  (arrival) => {
    const observer = recording();
    const tracker = createToolTracker({
      observer,
      captureContent: true,
      onChildSessionObserved() {},
      onFinish() {},
    });
    const run = { sessionID: "s1", id: "r1" };
    const other = { sessionID: "s2", id: "r1" };
    const context = { reference: { run, id: "input" }, userInputText: undefined };
    const part: ToolPart = {
      type: "tool",
      id: "part",
      messageID: "assistant",
      sessionID: "s1",
      callID: "call",
      tool: "read",
      state: { status: "running", input: {}, time: { start: 1000 } },
    };
    const description = { callID: "call", name: "read", description: "Read a file" };
    tracker.open(run);
    tracker.open(other);
    tracker.describe(other, "assistant", { ...description, description: "Other session" });
    tracker.describe(run, "other-message", { ...description, description: "Other message" });
    tracker.describe(run, "assistant", {
      ...description,
      callID: "other-call",
      description: "Other call",
    });

    if (arrival !== "before-part") {
      tracker.part(run, part, 1000, arrival === "after-start" ? context : undefined);
    }
    if (arrival === "after-start") {
      tracker.part(
        run,
        {
          ...part,
          state: { status: "running", input: { path: "updated" }, time: { start: 1000 } },
        },
        1100,
        context,
      );
      observer.updateTool.mockClear();
    }
    tracker.describe(run, "assistant", description);
    if (arrival === "before-part") {
      tracker.part(run, part, 1000, context);
    }
    if (arrival === "before-owner") {
      tracker.associate(run, "assistant", "call", context);
    }
    expect(observer.updateTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interaction: context.reference,
        messageID: "assistant",
        callID: "call",
        description: "Read a file",
      }),
    );
    if (arrival === "after-start") {
      expect(observer.updateTool).not.toHaveBeenCalledWith(
        expect.objectContaining({ arguments: expect.anything() }),
      );
    }

    observer.updateTool.mockClear();
    tracker.describe(run, "assistant", {
      ...description,
      name: "write",
      description: "Wrong tool",
    });
    tracker.describe(run, "assistant", { ...description, description: "Duplicate" });
    tracker.remove(run, "assistant", 1200);
    tracker.describe(run, "assistant", { ...description, description: "Late" });
    expect(observer.updateTool).not.toHaveBeenCalled();
    expect(observer.finishTool).toHaveBeenCalledTimes(1);

    tracker.release(run);
    tracker.open(run);
    tracker.part(run, { ...part, callID: "other-call" }, 1300, context);
    expect(observer.startTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: undefined }),
    );
  },
);

test.each([false, true])(
  "tool description capture=%s ignores disabled content and skill calls",
  (captureContent) => {
    const observer = recording();
    const tracker = createToolTracker({
      observer,
      captureContent,
      onChildSessionObserved() {},
      onFinish() {},
    });
    const run = { sessionID: "s1", id: "r1" };
    tracker.open(run);
    ["read", "skill"].forEach((name) => {
      tracker.describe(run, "assistant", {
        callID: name,
        name,
        description: "Private description",
      });
      tracker.part(
        run,
        {
          type: "tool",
          id: name,
          messageID: "assistant",
          sessionID: "s1",
          callID: name,
          tool: name,
          state: { status: "running", input: { name: "test" }, time: { start: 1000 } },
        },
        1000,
        { reference: { run, id: "input" }, userInputText: undefined },
      );
    });

    expect(observer.startTool).toHaveBeenCalledWith(
      expect.objectContaining({
        description: captureContent ? "Private description" : undefined,
      }),
    );
    expect(observer.startSkill).toHaveBeenCalledTimes(1);
    expect(observer.startSkill).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.anything() }),
    );
  },
);

test("pending tool descriptions are bounded, removed with messages and checked against tool names", () => {
  const observer = recording();
  const tracker = createToolTracker({
    observer,
    captureContent: true,
    onChildSessionObserved() {},
    onFinish() {},
  });
  const run = { sessionID: "s1", id: "r1" };
  tracker.open(run);
  Array.from({ length: 1025 }, (_, index) => {
    tracker.describe(run, `message-${index}`, {
      callID: "call",
      name: "read",
      description: `Description ${index}`,
    });
  });
  tracker.remove(run, "message-2", 1100);

  [0, 1, 2, 3].forEach((index) => {
    tracker.part(
      run,
      {
        type: "tool",
        id: `part-${index}`,
        messageID: `message-${index}`,
        sessionID: "s1",
        callID: "call",
        tool: index === 3 ? "write" : "read",
        state: { status: "running", input: {}, time: { start: 1000 } },
      },
      1200,
      { reference: { run, id: "input" }, userInputText: undefined },
    );
    expect(observer.startTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageID: `message-${index}`,
        description: index === 1 ? "Description 1" : undefined,
      }),
    );
  });
});

test("tool partitions isolate full run identities and release parts waiting for ownership", () => {
  const observer = recording();
  const tracker = createToolTracker({
    observer,
    captureContent: true,
    onChildSessionObserved() {},
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
  expect(tracker.activeStart(other, "assistant", "call")).toBeDefined();
});

test.each(["completed", "removed", "closed"])(
  "tool %s retires source identity and invokes lifecycle callbacks once",
  (terminal) => {
    const observer = recording();
    const onFinish = mock(() => {});
    const tracker = createToolTracker({ observer, onFinish, onChildSessionObserved() {} });
    const run = { sessionID: "s1", id: "r1" };
    const context = { reference: { run, id: "input" }, userInputText: undefined };
    const part: ToolPart = {
      type: "tool",
      id: "part",
      messageID: "assistant",
      sessionID: "s1",
      callID: "call",
      tool: "read",
      state: { status: "running", input: {}, time: { start: 1000 } },
    };
    const completed: ToolPart = {
      ...part,
      state: {
        status: "completed",
        input: {},
        output: "result",
        title: "read",
        metadata: {},
        time: { start: 1000, end: 1200 },
      },
    };
    tracker.open(run);
    tracker.part(run, part, 1000, context);

    if (terminal === "completed") {
      tracker.part(run, completed, 1200, context);
    }

    if (terminal === "removed") {
      tracker.remove(run, part.messageID, 1200, part.id);
    }

    if (terminal === "closed") {
      tracker.close(run, 1200);
    }

    const updates = observer.updateTool.mock.calls.length;
    tracker.part(run, part, 1300, context);
    tracker.part(run, completed, 1400, context);
    tracker.associate(run, part.messageID, part.callID, context);
    tracker.remove(run, part.messageID, 1500);
    tracker.close(run, 1600);

    expect(tracker.activeStart(run, part.messageID, part.callID)).toBeUndefined();
    expect(tracker.unresolved(run)).toEqual([]);
    expect(observer.startTool).toHaveBeenCalledTimes(1);
    expect(observer.updateTool).toHaveBeenCalledTimes(updates);
    expect(observer.finishTool).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(observer.finishTool).toHaveBeenCalledWith(
      expect.objectContaining({ interaction: context.reference, endedAt: 1200 }),
    );
  },
);

test.each(["removed", "closed"])(
  "unowned tool %s cannot be associated or recreated by late parts",
  (terminal) => {
    const observer = recording();
    const onFinish = mock(() => {});
    const tracker = createToolTracker({ observer, onFinish, onChildSessionObserved() {} });
    const run = { sessionID: "s1", id: "r1" };
    const context = { reference: { run, id: "input" }, userInputText: undefined };
    const part: ToolPart = {
      type: "tool",
      id: "part",
      messageID: "assistant",
      sessionID: "s1",
      callID: "call",
      tool: "read",
      state: { status: "running", input: {}, time: { start: 1000 } },
    };
    tracker.open(run);
    tracker.part(run, part, 1000);

    if (terminal === "removed") {
      tracker.remove(run, part.messageID, 1200, part.id);
    }

    if (terminal === "closed") {
      tracker.close(run, 1200);
    }

    tracker.associate(run, part.messageID, part.callID, context);
    tracker.part(run, part, 1300, context);
    tracker.close(run, 1400);

    expect(tracker.unresolved(run)).toEqual([]);
    expect(observer.startTool).not.toHaveBeenCalled();
    expect(observer.updateTool).not.toHaveBeenCalled();
    expect(observer.finishTool).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  },
);

test("skill loads whitelist metadata without reading or submitting content when capture is disabled", () => {
  const observer = recording();
  const tracker = createToolTracker({ observer, onFinish() {}, onChildSessionObserved() {} });
  const run = { sessionID: "s1", id: "r1" };
  const context = { reference: { run, id: "input" }, userInputText: undefined };
  const input = {
    name: "requested-skill",
    get secret() {
      throw new Error("unrelated skill arguments must not be read");
    },
  };
  const part: ToolPart = {
    type: "tool",
    id: "part",
    messageID: "assistant",
    sessionID: "s1",
    callID: "call",
    tool: "skill",
    state: { status: "running", input, time: { start: 1000 } },
  };
  tracker.open(run);
  tracker.part(run, part, 1000, context);

  expect(observer.startSkill).toHaveBeenCalledWith({
    interaction: context.reference,
    messageID: "assistant",
    callID: "call",
    startedAt: 1000,
    name: "requested-skill",
    agentName: undefined,
    agentType: undefined,
    parentSessionID: undefined,
  });
  expect(tracker.activeStart(run, "assistant", "call")?.name).toBe("skill");
  expect(tracker.activeStart(run, "assistant", "call")?.arguments).toBeUndefined();

  tracker.part(
    run,
    {
      ...part,
      state: {
        status: "completed",
        input,
        title: "loaded",
        get output(): string {
          throw new Error("skill output must not be read");
        },
        metadata: { name: "resolved-skill", dir: "/skills/resolved", truncated: false },
        time: { start: 1000, end: 1200 },
      },
    },
    1200,
    context,
  );

  expect(observer.updateSkill).toHaveBeenLastCalledWith({
    interaction: context.reference,
    messageID: "assistant",
    callID: "call",
    name: "resolved-skill",
    directory: "/skills/resolved",
    outputTruncated: false,
  });
  expect(observer.finishSkill).toHaveBeenCalledWith({
    interaction: context.reference,
    messageID: "assistant",
    callID: "call",
    endedAt: 1200,
    output: undefined,
    error: undefined,
  });
  expect(observer.startTool).not.toHaveBeenCalled();
  expect(observer.updateTool).not.toHaveBeenCalled();
  expect(observer.finishTool).not.toHaveBeenCalled();
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
      model: { id: "test", providerID: "test" } as ChatParamsHookArgs[0]["model"],
      provider: {} as ChatParamsHookArgs[0]["provider"],
    } satisfies ChatParamsHookArgs[0];
    const starts = observer.startLlm.mock.calls.length;
    tracker.open(run);
    tracker.message(run, { ...message, sessionID: run.sessionID }, 1000);
    tracker.prepareTraceHeaders(run, request);
    expect(tracker.bind(run, request)).toBeUndefined();
    expect(tracker.activeAssistant(run)).toBeUndefined();
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
    expect(tracker.activeAssistant(run)).toEqual({
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
  expect(tracker.activeAssistant(first)).toBeUndefined();
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
  expect(tracker.activeAssistant(next)).toBeUndefined();
  expect(tracker.activeAssistant(other)).toEqual({
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
  expect(tracker.activeMessageID(run)).toBe("marker");
  expect(tracker.resolveInteraction(run, "marker")).toBeUndefined();
  expect(tracker.unresolved(run)).toEqual([{ id: "marker", startedAt: 1200 }]);

  tracker.associate(run, "marker", context);
  tracker.associate(run, "marker", { ...context, reference: { run, id: "u2" } });
  tracker.completeActive(run, 1500);
  tracker.completeActive(run, 1600);
  expect(tracker.activeMessageID(run)).toBeUndefined();
  expect(observer.startCompaction).toHaveBeenCalledTimes(1);
  expect(observer.finishCompaction).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(tracker.unresolved(run)).toEqual([]);
  expect(tracker.resolveInteraction(run, "marker")).toEqual({
    ...context,
    userInputText: undefined,
  });

  tracker.release(run);
  tracker.associate(run, "marker", context);
  expect(tracker.resolveInteraction(run, "marker")).toBeUndefined();
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

  expect(tracker.activeMessageID(run)).toBe("marker2");
  expect(tracker.resolveInteraction(run, "marker1")).toEqual(context);
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
  tracker.completeActive(run, 1600);
  expect(tracker.activeMessageID(run)).toBeUndefined();
  expect(tracker.resolveInteraction(run, "marker2")).toEqual(context);
  expect(observer.finishCompaction).toHaveBeenCalledTimes(2);
  expect(onFinish).toHaveBeenCalledTimes(2);

  tracker.release(run);
  tracker.open(run);
  expect(tracker.activeMessageID(run)).toBeUndefined();
  expect(tracker.resolveInteraction(run, "marker1")).toBeUndefined();
  expect(tracker.resolveInteraction(run, "marker2")).toBeUndefined();
});

test("unmatched permissions share the capacity bound and evicted replies cannot be replayed", () => {
  const observer = recording();
  const tracker = createPermissionTracker({ observer });
  const run = { sessionID: "s1", id: "r1" };
  const tool = {
    interaction: { run, id: "u1" },
    messageID: "a1",
    callID: "call1",
    startedAt: 1000,
    name: "skill",
  };
  tracker.open(run);
  Array.from({ length: 1025 }, (_, index) => index).forEach((index) => {
    tracker.observeRequest(
      run,
      {
        id: `p${index}`,
        sessionID: "s1",
        permission: "skill",
        patterns: ["review"],
        metadata: {},
        always: [],
        tool: { messageID: "a1", callID: "call1" },
      },
      1100,
      undefined,
    );
  });
  tracker.observeReply(run, "p0", "reject", 1200);
  tracker.observeReply(run, "p1", "reject", 1200);
  expect(tracker.associate(tool)).toBe(true);
  tracker.close(run, 1300);
  expect(tracker.associate(tool)).toBe(false);

  expect(observer.startPermission).toHaveBeenCalledTimes(1024);
  expect(observer.finishPermission).toHaveBeenCalledTimes(1024);
  expect(observer.startPermission).not.toHaveBeenCalledWith(
    expect.objectContaining({ requestID: "p0" }),
  );
  expect(observer.finishPermission).toHaveBeenCalledWith(
    expect.objectContaining({ requestID: "p1", reply: "reject", endedAt: 1200 }),
  );
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
    tracker.observeRequest(
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

  tracker.finishPendingForTool(tool(first), 1200);
  tracker.release(first);
  ask(first);
  expect(tracker.observeReply(first, "permission", "reject", 1300)).toBeUndefined();
  tracker.close(next, 1400);
  tracker.close(next, 1500);
  ask(next);
  expect(observer.startPermission).toHaveBeenCalledTimes(3);
  expect(observer.finishPermission).toHaveBeenCalledTimes(2);

  expect(tracker.observeReply(other, "permission", "reject", 1600)).toEqual({
    interaction: { run: other, id: "input" },
    messageID: "assistant",
    callID: "call",
  });
  expect(observer.finishPermission).toHaveBeenCalledTimes(3);
  expect(tracker.observeReply(other, "permission", "reject", 1700)).toBeUndefined();

  tracker.open(first);
  ask(first);
  expect(observer.startPermission).toHaveBeenCalledTimes(4);
  tracker.observeReply(first, "permission", "once", 1800);
  expect(observer.finishPermission).toHaveBeenCalledTimes(4);
});
