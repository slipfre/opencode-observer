import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";

export const DisposalObserverPlugin: Plugin = async (input, options) => {
  const { ObserverPlugin } = (await import(
    new URL("../../dist/index.js", import.meta.url).href
  )) as {
    ObserverPlugin: Plugin;
  };
  const initial = snapshot();
  const hooks = await ObserverPlugin(input, options);
  const installed = snapshot();

  return {
    ...hooks,
    async config(config) {
      await hooks.config?.(config);
      Object.assign(installed, snapshot());
    },
    async dispose() {
      const before = snapshot();
      await hooks.dispose?.();
      const after = snapshot();
      await hooks.dispose?.();

      await Bun.write(
        path.join(input.directory, "observer-disposal.json"),
        JSON.stringify({ initial, installed, before, after, repeated: snapshot() }),
      );
    },
  };
};

function snapshot() {
  const root = globalThis as typeof globalThis & {
    __opencodeObserverModelCapture?: { listeners: Set<unknown> };
  };

  return {
    captures: root.__opencodeObserverModelCapture?.listeners.size ?? 0,
    exits: process.listenerCount("beforeExit"),
  };
}
