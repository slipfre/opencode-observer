import type { Observer, RunFinish, RunReference, ToolReference } from "../../contract/observer.js";

export type RunOptions = {
  observer: Pick<Observer, "startRun" | "updateRun" | "finishRun">;
  captureContent?: boolean;
  userID?: () => string | undefined;
};

export function createRunTracker(options: RunOptions) {
  const runs = new Map<string, RunReference>();
  const seen = new Set<string>();
  const state = { closed: false };

  return {
    userInput(input: {
      sessionID: string;
      id: string;
      createdAt: number;
      text: string | undefined;
      parent?: ToolReference;
      parentSessionID?: string;
    }) {
      const key = JSON.stringify([input.sessionID, input.id]);

      if (state.closed || seen.has(key)) {
        return;
      }

      const userID = options.userID?.();
      const reference = runs.get(input.sessionID) ?? { sessionID: input.sessionID, id: input.id };

      if (!runs.has(input.sessionID)) {
        options.observer.startRun({
          ...reference,
          startedAt: input.createdAt,
          userID,
          parent: input.parent,
          parentSessionID: input.parentSessionID,
        });
        runs.set(input.sessionID, reference);
      }

      const text = options.captureContent ? input.text : undefined;
      seen.add(key);
      options.observer.updateRun({ ...reference, input: { id: input.id, text } });
      return { reference, text, userID };
    },
    finish(input: RunFinish) {
      if (state.closed || runs.get(input.sessionID)?.id !== input.id) {
        return;
      }

      runs.delete(input.sessionID);
      options.observer.finishRun({
        ...input,
        output: options.captureContent ? input.output : undefined,
      });
    },
    close() {
      state.closed = true;
    },
  };
}
