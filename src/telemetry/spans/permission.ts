import { SpanKind, type Context, type Span } from "@opentelemetry/api";
import type {
  ObservationError,
  PermissionFinish,
  PermissionReference,
  PermissionStart,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";
import { endSpan, identityAttributes, operationKey, sameRun, type SpanOptions } from "./common.js";

export function createPermissionSpans(
  options: SpanOptions & {
    parentContext(reference: ToolReference): Context | undefined;
  },
) {
  const permissions = new Map<string, { reference: PermissionReference; span: Span }>();

  function finish(input: PermissionFinish) {
    const key = `${operationKey(input.tool)}:${input.requestID}`;
    const permission = permissions.get(key);

    if (!permission) {
      return;
    }

    permissions.delete(key);
    options.history.add(permission.reference.tool.interaction.run, "permission", key);

    if (input.reply !== undefined) {
      permission.span.setAttributes({
        "opencode.permission.reply": input.reply,
        "opencode.permission.granted": input.reply !== "reject",
      });
    }

    endSpan(permission.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: PermissionStart) {
      const key = `${operationKey(input.tool)}:${input.requestID}`;
      const parent = options.parentContext(input.tool);

      if (
        !parent ||
        permissions.has(key) ||
        options.history.has(input.tool.interaction.run, "permission", key)
      ) {
        return;
      }

      permissions.set(key, {
        reference: {
          requestID: input.requestID,
          tool: {
            callID: input.tool.callID,
            messageID: input.tool.messageID,
            interaction: { run: { ...input.tool.interaction.run }, id: input.tool.interaction.id },
          },
        },
        span: options.tracer.startSpan(
          `${options.tracePrefix}permission.check`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...identityAttributes(input.tool.interaction.run, input),
              "gen_ai.tool.call.id": input.tool.callID,
              "gen_ai.tool.name": input.toolName,
              "opencode.permission.name": input.name,
              "opencode.permission.patterns": [...input.patterns],
            },
          },
          parent,
        ),
      });
    },
    closeTool(tool: ToolReference, endedAt: number, error?: ObservationError) {
      permissions.forEach((permission) => {
        if (operationKey(permission.reference.tool) === operationKey(tool)) {
          finish({
            ...permission.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "tool ended before permission replied" },
          });
        }
      });
    },
    closeRun(run: RunReference, endedAt: number, error?: ObservationError) {
      permissions.forEach((permission) => {
        if (sameRun(permission.reference.tool.interaction.run, run)) {
          finish({
            ...permission.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
          });
        }
      });
    },
    close(endedAt: number) {
      permissions.forEach((permission) =>
        finish({
          ...permission.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before permission replied" },
        }),
      );
    },
  };
}
