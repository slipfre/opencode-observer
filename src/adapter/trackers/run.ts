import type { Observer, RunFinish, RunReference, ToolReference } from "../../contract/observer.js";

export type RunOptions = {
  observer: Pick<Observer, "startRun" | "updateRun" | "finishRun">;
  captureContent?: boolean;
};

export function createRunTracker(options: RunOptions) {
  const runs = new Map<string, RunReference>();
  const seen = new Set<string>();

  return {
    userInput(input: {
      sessionID: string;
      id: string;
      createdAt: number;
      text: string | undefined;
      parent?: ToolReference;
      parentSessionID?: string;
    }) {
      const key = `${input.sessionID}:${input.id}`;

      if (seen.has(key)) {
        return;
      }

      const reference = runs.get(input.sessionID) ?? { sessionID: input.sessionID, id: input.id };

      if (!runs.has(input.sessionID)) {
        options.observer.startRun({
          ...reference,
          startedAt: input.createdAt,
          parent: input.parent,
          parentSessionID: input.parentSessionID,
        });
        runs.set(input.sessionID, reference);
      }

      const text = options.captureContent ? input.text : undefined;
      seen.add(key);
      options.observer.updateRun({ ...reference, input: { id: input.id, text } });
      return { reference, text };
    },
    finish(input: RunFinish) {
      if (runs.get(input.sessionID)?.id !== input.id) {
        return;
      }

      runs.delete(input.sessionID);
      options.observer.finishRun({
        ...input,
        output: options.captureContent ? input.output : undefined,
      });
    },
    release(run: RunReference) {
      if (runs.get(run.sessionID)?.id === run.id) {
        runs.delete(run.sessionID);
      }
    },
  };
}
