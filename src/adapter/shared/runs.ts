import type { RunReference } from "../../contract/observer.js";

// Each tracker owns its store. Only explicit run registration allocates state.
export function createRunStore<T>(create: () => T) {
  const records = new Map<string, T>();

  return {
    open(run: RunReference) {
      const key = runKey(run);

      if (!records.has(key)) {
        records.set(key, create());
      }
    },
    get(run: RunReference) {
      return records.get(runKey(run));
    },
    release(run: RunReference) {
      records.delete(runKey(run));
    },
  };
}

function runKey(run: RunReference) {
  return `${run.sessionID}:${run.id}`;
}
