import type { AssistantMessage } from "@opencode-ai/sdk";
import type { LlmFinish } from "../../contract/observer.js";
import { nonNegativeInteger } from "../shared/number.js";

export function parseModelUsage(
  tokens: AssistantMessage["tokens"] | undefined,
): NonNullable<LlmFinish["usage"]> {
  const input = nonNegativeInteger(tokens?.input);
  const output = nonNegativeInteger(tokens?.output);
  const reasoning = nonNegativeInteger(tokens?.reasoning);
  const read = nonNegativeInteger(tokens?.cache?.read);
  const write = nonNegativeInteger(tokens?.cache?.write);

  return {
    inputTokens:
      input !== undefined && read !== undefined && write !== undefined
        ? nonNegativeInteger(input + read + write)
        : undefined,
    outputTokens:
      output !== undefined && reasoning !== undefined
        ? nonNegativeInteger(output + reasoning)
        : undefined,
    reasoningTokens: reasoning,
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}
