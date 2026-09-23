import path from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";

/** Record source event times alongside controlled preparation and tool execution delays. */
export const TimingPlugin: Plugin = async (input, options) => {
  const originalFetch = globalThis.fetch;
  const { ObserverPlugin } = (await import(
    new URL("../../dist/index.js", import.meta.url).href
  )) as { ObserverPlugin: Plugin };
  const hooks = await ObserverPlugin(input, options);
  const messages = new Map<string, { created: number; completed?: number }>();
  const firstSteps = new Map<string, number>();
  return {
    ...hooks,
    async config(config) {
      await hooks.config?.(config);
      if (options?.bypassTimingFetch && config.provider?.test?.options) {
        config.provider.test.options.fetch = originalFetch;
      }
    },
    tool: {
      timing_wait: tool({
        description: "Wait for a controlled duration in an observer integration test.",
        args: { delay: tool.schema.number() },
        async execute(args) {
          if (args.delay) {
            await Bun.sleep(args.delay);
          }
          return "timing tool complete";
        },
      }),
    },
    async "experimental.chat.messages.transform"(request, output) {
      await hooks["experimental.chat.messages.transform"]?.(request, output);
      await Bun.sleep(100);
    },
    async event(event) {
      if (
        event.event.type === "message.part.updated" &&
        event.event.properties.part.type === "step-start" &&
        !firstSteps.has(event.event.properties.part.messageID)
      ) {
        firstSteps.set(
          event.event.properties.part.messageID,
          "time" in event.event.properties && typeof event.event.properties.time === "number"
            ? event.event.properties.time
            : Date.now(),
        );
      }
      if (
        event.event.type === "message.updated" &&
        event.event.properties.info.role === "assistant"
      ) {
        messages.set(event.event.properties.info.id, { ...event.event.properties.info.time });
      }
      await hooks.event?.(event);
    },
    async dispose() {
      await hooks.dispose?.();
      await Bun.write(
        path.join(input.directory, "timing-messages.json"),
        JSON.stringify(
          Object.fromEntries(
            Array.from(messages, ([id, time]) => [id, { ...time, firstStep: firstSteps.get(id) }]),
          ),
        ),
      );
    },
  };
};
