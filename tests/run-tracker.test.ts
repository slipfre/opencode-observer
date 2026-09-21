import { expect, test } from "bun:test";
import { createRunTracker } from "../src/adapter/trackers/run.js";
import type { RunFinish, RunStart, RunUpdate } from "../src/contract/observer.js";

function setup(captureContent = true) {
  const starts: RunStart[] = [];
  const updates: RunUpdate[] = [];
  const finishes: RunFinish[] = [];
  const tracker = createRunTracker({
    captureContent,
    observer: {
      startRun: (input) => starts.push(input),
      updateRun: (input) => updates.push(input),
      finishRun: (input) => finishes.push(input),
    },
  });

  return { tracker, starts, updates, finishes };
}

test("run tracker accepts recognized inputs, deduplicates them and preserves session identity", () => {
  const h = setup();
  const input = { sessionID: "s1", id: "u1", createdAt: 1000, text: "question" };

  const first = h.tracker.observeUserInput(input);
  const duplicate = h.tracker.observeUserInput({ ...input, text: "replay" });
  const steer = h.tracker.observeUserInput({ ...input, id: "u2", createdAt: 1200, text: "steer" });
  const other = h.tracker.observeUserInput({ ...input, sessionID: "s2" });

  expect(first?.reference).toEqual({ sessionID: "s1", id: "u1" });
  expect(duplicate).toBeUndefined();
  expect(steer?.reference).toEqual(first?.reference);
  expect(other?.reference).toEqual({ sessionID: "s2", id: "u1" });
  expect(h.starts).toHaveLength(2);
  expect(h.starts.map((value) => value.startedAt)).toEqual([1000, 1000]);
  expect(h.updates.map((value) => value.input.text)).toEqual(["question", "steer", "question"]);
});

test("run tracker rejects stale finishes and replays across consecutive runs", () => {
  const h = setup();
  const input = { sessionID: "s1", id: "u1", createdAt: 1000, text: "question" };
  const finish = { sessionID: "s1", id: "u1", endedAt: 2000, output: "answer" };
  h.tracker.observeUserInput(input);
  h.tracker.finish(finish);
  h.tracker.finish(finish);

  expect(h.tracker.observeUserInput(input)).toBeUndefined();
  h.tracker.observeUserInput({ ...input, id: "u2", createdAt: 3000 });
  h.tracker.finish({ ...finish, endedAt: 3500 });
  h.tracker.finish({ ...finish, id: "u2", endedAt: 4000 });

  expect(h.starts.map((value) => value.id)).toEqual(["u1", "u2"]);
  expect(h.finishes.map((value) => value.endedAt)).toEqual([2000, 4000]);
});

test("run tracker enforces capture policy on recognized input and completion", () => {
  const h = setup(false);
  const accepted = h.tracker.observeUserInput({
    sessionID: "s1",
    id: "u1",
    createdAt: 1000,
    text: "secret",
  });
  h.tracker.finish({ sessionID: "s1", id: "u1", endedAt: 2000, output: "secret" });

  expect(accepted?.text).toBeUndefined();
  expect(h.updates[0]?.input.text).toBeUndefined();
  expect(h.finishes[0]?.output).toBeUndefined();
});

test("run release preserves input deduplication without affecting the next run", () => {
  const h = setup();
  const first = { sessionID: "s1", id: "u1", createdAt: 1000, text: "first" };
  const next = { ...first, id: "u2", createdAt: 2000 };
  h.tracker.observeUserInput(first);

  h.tracker.release(first);
  expect(h.tracker.observeUserInput(first)).toBeUndefined();
  h.tracker.observeUserInput(next);
  h.tracker.release(first);
  h.tracker.finish({ ...next, endedAt: 3000, output: undefined });
  expect(h.starts).toHaveLength(2);
  expect(h.finishes).toHaveLength(1);
});
