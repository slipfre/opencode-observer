import { createGuard, reportError } from "../shared/guard.js";

export type FetchEndReason = "eof" | "empty" | "error" | "cancel";
export type FetchCapture = {
  active(): boolean;
  start(time: number): (time: number, reason: FetchEndReason) => void;
};
type Listener = {
  captures: Map<string, FetchCapture>;
  guard: ReturnType<typeof createGuard>;
  now: () => number;
};
type FetchBroker = { listeners: Set<Listener>; original: typeof fetch; wrapped: typeof fetch };

/** Observe only explicitly bound traceparents; leave authentication and provider options untouched. */
export function createFetchModelCapture(options: {
  log: (error: unknown) => unknown;
  now?: () => number;
}) {
  const root = globalThis as typeof globalThis & { __opencodeObserverFetchCapture?: FetchBroker };
  const listener: Listener = {
    captures: new Map(),
    guard: createGuard(options.log),
    now: options.now ?? Date.now,
  };
  const broker = (root.__opencodeObserverFetchCapture ??= createBroker());
  broker.listeners.add(listener);

  return {
    bind(traceparent: string, capture: FetchCapture) {
      listener.captures.forEach((value, key) => {
        if (!value.active()) {
          listener.captures.delete(key);
        }
      });
      listener.captures.set(traceparent, capture);
    },
    close() {
      listener.captures.clear();
      broker.listeners.delete(listener);
      if (broker.listeners.size) {
        return;
      }

      // Do not undo a wrapper installed by another plugin after ours.
      if (globalThis.fetch === broker.wrapped) {
        globalThis.fetch = broker.original;
      }
      if (root.__opencodeObserverFetchCapture === broker) {
        delete root.__opencodeObserverFetchCapture;
      }
    },
  };
}

function createBroker(): FetchBroker {
  const listeners = new Set<Listener>();
  const original = globalThis.fetch;
  const wrapped = new Proxy(original, {
    apply(target, receiver, args: Parameters<typeof fetch>) {
      const finishes: Array<(reason: FetchEndReason) => void> = [];
      listeners.forEach((listener) => {
        void listener.guard(() => {
          const headers =
            args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined);
          const id = new Headers(headers).get("traceparent");
          const capture = id ? listener.captures.get(id) : undefined;
          if (!capture?.active()) {
            return;
          }

          const ended = capture.start(listener.now());
          finishes.push((reason) => {
            void listener.guard(() => {
              if (listeners.has(listener) && capture.active()) {
                ended(listener.now(), reason);
              }
            });
          });
        });
      });
      if (!finishes.length) {
        return Reflect.apply(target, receiver, args);
      }

      const state = { ended: false };
      const finish = (reason: FetchEndReason) => {
        if (state.ended) {
          return;
        }
        state.ended = true;
        finishes.forEach((ended) => ended(reason));
      };
      return observeResponse(
        () => Reflect.apply(target, receiver, args),
        finish,
        (error) => {
          listeners.forEach(
            (listener) =>
              void listener.guard(() => {
                throw error;
              }),
          );
        },
      );
    },
  });
  globalThis.fetch = wrapped;
  return { listeners, original, wrapped };
}

async function observeResponse(
  send: () => Promise<Response>,
  finish: (reason: FetchEndReason) => void,
  log: (error: unknown) => unknown,
) {
  async function request() {
    try {
      return await send();
    } catch (error) {
      finish("error");
      throw error;
    }
  }
  const response = await request();
  if (!response.body) {
    finish("empty");
    return response;
  }

  // A single pull chain preserves backpressure. Never clone, decode, or drain a second branch.
  if (response.body.locked || response.bodyUsed) {
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish("eof");
            controller.close();
            reader.releaseLock();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          finish("error");
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        finish("cancel");
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  try {
    const observed = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Response construction cannot otherwise preserve these read-only transport properties.
    Object.defineProperties(observed, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return observed;
  } catch (error) {
    reader.releaseLock();
    reportError(error, log);
    return response;
  }
}
