import { asSchema, type OnStepStartEvent } from "ai";
import type { ModelRequestMetadata, ToolDefinition } from "../../contract/observer.js";
import { toJsonValue } from "../shared/json.js";

export async function parseModelSettings(
  event: Pick<OnStepStartEvent, "output" | "tools" | "activeTools">,
  captureContent: boolean,
  log: (error: unknown) => void,
): Promise<Pick<ModelRequestMetadata, "outputType" | "toolDefinitions">> {
  const [outputFormatResult, toolDefinitionsResult] = await Promise.allSettled([
    event.output === undefined ? { type: "text" } : event.output.responseFormat,
    captureContent && event.tools
      ? Promise.all(
          Object.entries(event.tools)
            .filter(([name]) => event.activeTools === undefined || event.activeTools.includes(name))
            .map(async ([name, tool]): Promise<ToolDefinition> => {
              if (tool.type === "provider") {
                return { type: tool.id, name };
              }

              const definition: ToolDefinition = {
                type: "function",
                name,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
              };
              const schema = await Promise.resolve()
                .then(() => asSchema(tool.inputSchema).jsonSchema)
                .catch((error) => {
                  log(error);
                });

              return { ...definition, parameters: toJsonValue(schema) };
            }),
        )
      : undefined,
  ]);
  [outputFormatResult, toolDefinitionsResult].forEach((result) => {
    if (result.status === "rejected") {
      log(result.reason);
    }
  });

  return {
    outputType:
      outputFormatResult.status === "fulfilled" &&
      (outputFormatResult.value?.type === "text" || outputFormatResult.value?.type === "json")
        ? outputFormatResult.value.type
        : undefined,
    toolDefinitions:
      toolDefinitionsResult.status === "fulfilled" ? toolDefinitionsResult.value : undefined,
  };
}
