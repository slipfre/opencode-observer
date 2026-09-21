import type { Hooks } from "@opencode-ai/plugin";
import type { LlmStart } from "../../contract/observer.js";
import { nonNegativeInteger, nonNegativeNumber } from "../shared/number.js";

export type ChatParamsHookArgs = Parameters<NonNullable<Hooks["chat.params"]>>;

export function parseChatParams(
  input: ChatParamsHookArgs[0],
  output: ChatParamsHookArgs[1],
): Pick<LlmStart, "model" | "providerName" | "operation" | "parameters"> {
  return {
    model: input.model.api.id,
    providerName: providerName(input.model.providerID, input.model.api.npm),
    operation: ["@ai-sdk/google", "@ai-sdk/google-vertex"].includes(input.model.api.npm)
      ? "generate_content"
      : "chat",
    parameters: {
      temperature: nonNegativeNumber(output.temperature),
      topP: nonNegativeNumber(output.topP),
      topK: nonNegativeInteger(output.topK),
      maxOutputTokens: nonNegativeInteger(output.maxOutputTokens),
    },
  };
}

export function providerName(id: string, npm?: string) {
  const names: Record<string, string> = {
    openai: "openai",
    anthropic: "anthropic",
    "@ai-sdk/openai": "openai",
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/amazon-bedrock": "aws.bedrock",
    "@ai-sdk/azure": "azure.ai.openai",
    "@ai-sdk/google": "gcp.gemini",
    "@ai-sdk/google-vertex": "gcp.vertex_ai",
    "amazon-bedrock": "aws.bedrock",
    azure: "azure.ai.openai",
    google: "gcp.gemini",
    "google-vertex": "gcp.vertex_ai",
  };

  // An OpenAI-compatible transport does not establish that OpenAI is the provider.
  return names[id] ?? (npm ? names[npm] : undefined) ?? id;
}
