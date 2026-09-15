import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  InteractionReference,
  ObservationError,
  RunReference,
  ToolFinish,
  ToolReference,
  ToolStart,
  ToolUpdate,
} from "../../contract/observer.js";
import { endSpan, identityAttributes, operationKey, sameRun, type SpanOptions } from "./common.js";

export function createToolSpans(
  options: SpanOptions & {
    parentContext(reference: InteractionReference): Context | undefined;
  },
) {
  const tools = new Map<string, { reference: ToolReference; name: string; span: Span }>();
  const finished = new Set<string>();

  function finish(input: ToolFinish) {
    const key = operationKey(input);
    const tool = tools.get(key);

    if (!tool) {
      return;
    }

    tools.delete(key);
    finished.add(key);

    if (options.captureContent && !input.error && input.output !== undefined) {
      tool.span.setAttribute("gen_ai.tool.call.result", toolResult(input.output));
    }

    endSpan(tool.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: ToolStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input.interaction);

      if (!parent || tools.has(key) || finished.has(key)) {
        return;
      }

      tools.set(key, {
        reference: {
          interaction: { run: { ...input.interaction.run }, id: input.interaction.id },
          messageID: input.messageID,
          callID: input.callID,
        },
        name: input.name,
        span: options.tracer.startSpan(
          `${options.tracePrefix}tool.${input.name}`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...identityAttributes(input.interaction.run, input),
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.call.id": input.callID,
              "gen_ai.tool.name": input.name,
              ...(options.captureContent && input.arguments !== undefined
                ? { "gen_ai.tool.call.arguments": JSON.stringify(input.arguments) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    update(input: ToolUpdate) {
      const tool = tools.get(operationKey(input));

      if (tool && options.captureContent && input.arguments !== undefined) {
        tool.span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(input.arguments));
      }
    },
    context(reference: ToolReference, taskOnly = false) {
      const tool = tools.get(operationKey(reference));
      return tool && (!taskOnly || tool.name === "task")
        ? trace.setSpan(options.rootContext, tool.span)
        : undefined;
    },
    closeRun(run: RunReference, endedAt: number, error?: ObservationError) {
      tools.forEach((tool) => {
        if (sameRun(tool.reference.interaction.run, run)) {
          finish({
            ...tool.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "session ended before tool completed" },
          });
        }
      });
    },
    close(endedAt: number) {
      tools.forEach((tool) =>
        finish({
          ...tool.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before tool completed" },
        }),
      );
      finished.clear();
    },
  };
}

function toolResult(output: string) {
  try {
    const value: unknown = JSON.parse(output);

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return JSON.stringify(value);
    }
  } catch {
    // Plain text and non-object JSON use the schema's result object wrapper.
  }

  return JSON.stringify({ content: output });
}
