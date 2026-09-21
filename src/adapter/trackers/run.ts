import type { Observer, RunFinish, RunReference, ToolReference } from "../../contract/observer.js";

export type RunOptions = {
  observer: Pick<Observer, "startRun" | "updateRun" | "finishRun">;
  captureContent?: boolean;
};

export function createRunTracker(options: RunOptions) {
  const activeRuns = new Map<string, RunReference>();
  const seenUserMessageKeys = new Set<string>();

  return {
    observeUserInput(input: {
      sessionID: string;
      id: string;
      createdAt: number;
      text: string | undefined;
      parentTool?: ToolReference;
      parentSessionID?: string;
    }) {
      const userMessageKey = `${input.sessionID}:${input.id}`;

      if (seenUserMessageKeys.has(userMessageKey)) {
        return;
      }

      const activeRun = activeRuns.get(input.sessionID);
      const reference = activeRun ?? { sessionID: input.sessionID, id: input.id };

      if (!activeRun) {
        options.observer.startRun({
          ...reference,
          startedAt: input.createdAt,
          parentTool: input.parentTool,
          parentSessionID: input.parentSessionID,
        });
        activeRuns.set(input.sessionID, reference);
      }

      const text = options.captureContent ? input.text : undefined;
      seenUserMessageKeys.add(userMessageKey);
      options.observer.updateRun({ ...reference, input: { id: input.id, text } });
      return { reference, text };
    },
    finish(input: RunFinish) {
      if (activeRuns.get(input.sessionID)?.id !== input.id) {
        return;
      }

      activeRuns.delete(input.sessionID);
      options.observer.finishRun({
        ...input,
        output: options.captureContent ? input.output : undefined,
      });
    },
    release(run: RunReference) {
      if (activeRuns.get(run.sessionID)?.id === run.id) {
        activeRuns.delete(run.sessionID);
      }
    },
  };
}
