import type { Plugin } from "@opencode-ai/plugin";

export const FailingObserverPlugin: Plugin = async (input, options) => {
  const { ObserverPlugin } = (await import(
    new URL("../../dist/index.js", import.meta.url).href
  )) as {
    ObserverPlugin: Plugin;
  };
  input.client.app.log = (): Promise<never> => {
    console.error("observer fixture: logging failed");

    if (options?.testLogFailure === "reject") {
      return Promise.reject(new Error("injected logging failure"));
    }

    throw new Error("injected logging failure");
  };
  const hooks = await ObserverPlugin(input, options);

  return {
    ...hooks,
    "chat.params": async (request, output) => {
      // Only the observer sees the fault; the host retains its original request parameters.
      await hooks["chat.params"]?.(
        request,
        new Proxy(output, {
          get(target, key, receiver) {
            if (key === "temperature") {
              console.error("observer fixture: parameter observation failed");
              throw new Error("injected parameter observation failure");
            }

            return Reflect.get(target, key, receiver);
          },
        }),
      );
    },
  };
};
