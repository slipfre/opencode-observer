import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";

export const TimingObserverPlugin: Plugin = async (input, options) => {
  const { ObserverPlugin } = (await import(
    new URL("../../dist/index.js", import.meta.url).href
  )) as { ObserverPlugin: Plugin };
  const hooks = await ObserverPlugin(input, options);
  const messages = new Map<string, { created: number; completed?: number }>();

  return {
    ...hooks,
    async event(event) {
      if (
        event.event.type === "message.updated" &&
        event.event.properties.info.role === "assistant"
      ) {
        const info = event.event.properties.info;
        messages.set(info.id, { ...info.time });
      }
      await hooks.event?.(event);
    },
    async dispose() {
      await hooks.dispose?.();
      await Bun.write(
        path.join(input.directory, "assistant-times.json"),
        JSON.stringify(Array.from(messages, ([id, time]) => ({ id, ...time }))),
      );
    },
  };
};
