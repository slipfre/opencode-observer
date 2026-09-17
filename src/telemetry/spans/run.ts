import { SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  RunFinish,
  RunReference,
  RunStart,
  RunUpdate,
  ToolReference,
} from "../../contract/observer.js";
import { encodeTextMessage, type SpanOptions } from "./common.js";

type Run = {
  reference: RunReference;
  span: Span;
  inputs: Map<string, string | undefined>;
};

export function createRunSpans(
  options: SpanOptions & {
    parentContext?(reference: ToolReference): Context | undefined;
  },
) {
  const runs = new Map<string, Run>();

  function finish(input: RunFinish) {
    const key = `${input.sessionID}:${input.id}`;
    const run = runs.get(key);

    if (!run) {
      return;
    }

    runs.delete(key);

    if (options.captureContent && run.inputs.size > 0) {
      const texts = Array.from(run.inputs.values());

      if (texts.every((text) => text !== undefined)) {
        run.span.setAttribute(
          "gen_ai.input.messages",
          JSON.stringify(
            texts.map((text) => ({ role: "user", parts: [{ type: "text", content: text }] })),
          ),
        );
      }
    }

    if (input.error) {
      run.span.setAttribute("error.type", input.error.type);
      run.span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message });
    }

    if (!input.error && options.captureContent && input.output !== undefined) {
      run.span.setAttribute("gen_ai.output.messages", encodeTextMessage("assistant", input.output));
    }

    run.span.end(new Date(input.endedAt));
  }

  return {
    finish,
    start(input: RunStart) {
      const key = `${input.sessionID}:${input.id}`;
      const parent = input.parent ? options.parentContext?.(input.parent) : options.rootContext;

      if (!parent || runs.has(key)) {
        return;
      }

      runs.set(key, {
        reference: { sessionID: input.sessionID, id: input.id },
        inputs: new Map(),
        span: options.tracer.startSpan(
          `${options.tracePrefix}run`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.sessionID,
              "gen_ai.conversation.id": input.sessionID,
              "gen_ai.operation.name": "invoke_workflow",
              "opencode.run.id": input.id,
              "opencode.session.parent_id": input.parentSessionID,
            },
          },
          parent,
        ),
      });
      return true;
    },
    update(input: RunUpdate) {
      const run = runs.get(`${input.sessionID}:${input.id}`);

      if (!run || run.inputs.has(input.input.id)) {
        return;
      }

      run.inputs.set(input.input.id, options.captureContent ? input.input.text : undefined);
    },
    context(reference: RunReference) {
      const run = runs.get(`${reference.sessionID}:${reference.id}`);
      return run ? trace.setSpan(options.rootContext, run.span) : undefined;
    },
    close(endedAt: number) {
      runs.forEach((run) =>
        finish({
          ...run.reference,
          endedAt,
          output: undefined,
          error: { type: "_OTHER", message: "plugin disposed before run completed" },
        }),
      );
    },
  };
}
