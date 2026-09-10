import { expect, test } from "bun:test";
import { createRunTracker } from "../src/adapter/run.js";
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

  const first = h.tracker.userInput(input);
  const duplicate = h.tracker.userInput({ ...input, text: "replay" });
  const steer = h.tracker.userInput({ ...input, id: "u2", createdAt: 1200, text: "steer" });
  const other = h.tracker.userInput({ ...input, sessionID: "s2" });

  expect(first?.reference).toEqual({ sessionID: "s1", id: "u1" });
  expect(duplicate).toBeUndefined();
  expect(steer?.reference).toEqual(first?.reference);
  expect(other?.reference).toEqual({ sessionID: "s2", id: "u1" });
  expect(h.starts).toHaveLength(2);
  expect(h.starts.map((value) => value.startedAt)).toEqual([1000, 1000]);
  expect(h.updates.map((value) => value.input.text)).toEqual(["question", "steer", "question"]);
});

test("run tracker rejects stale finishes and replays across consecutive runs and closes silently", () => {
  const h = setup();
  const input = { sessionID: "s1", id: "u1", createdAt: 1000, text: "question" };
  const finish = { sessionID: "s1", id: "u1", endedAt: 2000, output: "answer" };
  h.tracker.userInput(input);
  h.tracker.finish(finish);
  h.tracker.finish(finish);

  expect(h.tracker.userInput(input)).toBeUndefined();
  h.tracker.userInput({ ...input, id: "u2", createdAt: 3000 });
  h.tracker.finish({ ...finish, endedAt: 3500 });
  h.tracker.finish({ ...finish, id: "u2", endedAt: 4000 });

  expect(h.starts.map((value) => value.id)).toEqual(["u1", "u2"]);
  expect(h.finishes.map((value) => value.endedAt)).toEqual([2000, 4000]);
  h.tracker.userInput({ ...input, id: "u3", createdAt: 5000 });
  h.tracker.close();
  h.tracker.close();
  h.tracker.finish({ ...finish, id: "u3" });

  expect(h.tracker.userInput({ ...input, id: "u4" })).toBeUndefined();
  expect(h.finishes).toHaveLength(2);
  expect(h.starts).toHaveLength(3);
});

test("run tracker enforces capture policy on recognized input and completion", () => {
  const h = setup(false);
  const accepted = h.tracker.userInput({
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
