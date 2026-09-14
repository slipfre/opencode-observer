import { asSchema, type OnStepStartEvent } from "ai";
import type { ModelRequest, ToolDefinition } from "../../contract/observer.js";
import { jsonValue } from "../shared/json.js";

export async function parseModelSettings(
  event: Pick<OnStepStartEvent, "output" | "tools" | "activeTools">,
  captureContent: boolean,
  log: (error: unknown) => void,
): Promise<Pick<ModelRequest, "outputType" | "toolDefinitions">> {
  const [output, tools] = await Promise.allSettled([
    event.output?.responseFormat,
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

              return { ...definition, parameters: jsonValue(schema) };
            }),
        )
      : undefined,
  ]);
  [output, tools].forEach((result) => {
    if (result.status === "rejected") {
      log(result.reason);
    }
  });

  return {
    outputType:
      output.status === "fulfilled" &&
      (output.value?.type === "text" || output.value?.type === "json")
        ? output.value.type
        : undefined,
    toolDefinitions: tools.status === "fulfilled" ? tools.value : undefined,
  };
}
