export function createGuard(log: (error: unknown) => unknown) {
  return async function guard(action: () => unknown): Promise<void> {
    try {
      // Invoke immediately to preserve source event ordering and observation times.
      await action();
    } catch (error) {
      try {
        // Diagnostics are best effort and must not delay the host callback.
        void Promise.resolve(log(error)).catch(() => undefined);
      } catch {
        // A logging failure must not escape or trigger another logging attempt.
      }
    }
  };
}
