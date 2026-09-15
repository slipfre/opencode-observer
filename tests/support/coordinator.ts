import { expect } from "bun:test";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import {
  createCoordinator,
  type CoordinatorOptions,
  type OpenCodeEvent,
} from "../../src/adapter/opencode/coordinator.js";
import type { LlmRequest } from "../../src/adapter/model/request.js";

export function createCoordinatorHarness(options: CoordinatorOptions) {
  const clock: { observedAt?: number } = {};
  const failures: unknown[] = [];
  const coordinator = createCoordinator({
    ...options,
    now: () => clock.observedAt ?? options.now?.() ?? Date.now(),
    log(error) {
      failures.push(error);
      return options.log?.(error);
    },
  });

  async function observe(pending: Promise<void>) {
    await pending;
    // A guarded recording failure must still fail the behavior test.
    expect(failures).toEqual([]);
  }

  return {
    ...coordinator,
    message(message: UserMessage, parts: Part[]) {
      return observe(
        coordinator.hooks["chat.message"]({ sessionID: message.sessionID }, { message, parts }),
      );
    },
    event(event: OpenCodeEvent, time?: number) {
      // Hooks read the observation time synchronously; scope the override to this event.
      clock.observedAt = time;
      const pending = coordinator.hooks.event({ event });
      delete clock.observedAt;
      return observe(pending);
    },
    params(...request: LlmRequest) {
      return observe(coordinator.hooks["chat.params"](...request));
    },
    async headers(input: LlmRequest[0]) {
      const output = { headers: {} as Record<string, string> };
      await observe(coordinator.hooks["chat.headers"](input, output));
      return output.headers;
    },
  };
}
