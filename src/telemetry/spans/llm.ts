import {
  defaultTextMapSetter,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type {
  LlmFinish,
  LlmReference,
  LlmStart,
  LlmUpdate,
  ModelHeaders,
  ObservationError,
  RunReference,
  TraceHeaders,
} from "../../contract/observer.js";
import { encodeTextMessage, type SpanOptions } from "./common.js";
import { encodeModelMessages, encodeSystemInstructions } from "./messages.js";

export function createLlmSpans(
  options: SpanOptions & {
    parentContext: (input: LlmStart) => Context | undefined;
  },
) {
  const calls = new Map<
    string,
    {
      reference: LlmReference;
      compactionID?: string;
      span: Span;
      messages?: { input: string; system: string | undefined };
      output?: string;
      outputType?: string;
      toolDefinitions?: string;
      requestHeaders?: ModelHeaders;
      responseHeaders?: ModelHeaders;
    }
  >();
  const propagator = new W3CTraceContextPropagator();

  function finish(input: LlmFinish) {
    const key = `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`;
    const call = calls.get(key);

    if (!call || call.reference.interaction.id !== input.interaction.id) {
      return;
    }

    calls.delete(key);
    options.history.add(call.reference.interaction.run, "llm", key);
    call.span.setAttributes({
      "gen_ai.output.type": call.outputType,
      "gen_ai.response.finish_reasons": input.finishReason
        ? [input.finishReason]
        : input.error
          ? ["error"]
          : undefined,
      ...(!input.error
        ? {
            "gen_ai.usage.input_tokens": input.usage?.inputTokens,
            "gen_ai.usage.output_tokens": input.usage?.outputTokens,
            "gen_ai.usage.reasoning.output_tokens": input.usage?.reasoningTokens,
            "gen_ai.usage.cache_read.input_tokens": input.usage?.cacheReadTokens,
            "gen_ai.usage.cache_write.input_tokens": input.usage?.cacheWriteTokens,
            "opencode.llm.cost.total": input.cost,
          }
        : {}),
    });

    if (options.captureContent) {
      call.span.setAttributes({
        "gen_ai.tool.definitions": call.toolDefinitions,
        ...Object.fromEntries(
          Object.entries(call.requestHeaders ?? {}).map(([key, value]) => [
            `http.request.header.${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(input.responseHeaders ?? call.responseHeaders ?? {}).map(
            ([key, value]) => [`http.response.header.${key}`, value],
          ),
        ),
        "gen_ai.input.messages": call.messages?.input,
        "gen_ai.system_instructions": call.messages?.system,
        "gen_ai.output.messages":
          call.output ??
          (input.output !== undefined ? encodeTextMessage("assistant", input.output) : undefined),
      });
    }

    if (input.error) {
      call.span.setAttribute("error.type", input.error.type);
      call.span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message });
    }

    call.span.end(new Date(input.endedAt));
  }

  return {
    finish,
    traceHeaders(input: LlmReference): TraceHeaders | undefined {
      const call = calls.get(
        `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`,
      );

      if (!call || call.reference.interaction.id !== input.interaction.id) {
        return;
      }

      const headers: Record<string, string> = {};
      propagator.inject(
        trace.setSpan(options.rootContext, call.span),
        headers,
        defaultTextMapSetter,
      );
      return headers.traceparent
        ? {
            traceparent: headers.traceparent,
            ...(headers.tracestate ? { tracestate: headers.tracestate } : {}),
          }
        : undefined;
    },
    update(input: LlmUpdate) {
      const call = calls.get(
        `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`,
      );

      if (!call || call.reference.interaction.id !== input.interaction.id) {
        return;
      }

      if (input.request) {
        call.outputType = input.request.outputType;
        delete call.output;
        delete call.responseHeaders;
      }

      if (!options.captureContent) {
        return;
      }

      if (input.request) {
        call.toolDefinitions =
          input.request.toolDefinitions === undefined
            ? undefined
            : JSON.stringify(input.request.toolDefinitions);
        call.requestHeaders =
          input.request.headers === undefined ? undefined : structuredClone(input.request.headers);
      }

      if (input.responseHeaders !== undefined) {
        call.responseHeaders = structuredClone(input.responseHeaders);
      }

      if (input.input) {
        call.messages = {
          input: encodeModelMessages(input.input.messages),
          system:
            input.input.systemInstructions === undefined
              ? undefined
              : encodeSystemInstructions(input.input.systemInstructions),
        };
        delete call.output;
      }

      if (input.output !== undefined) {
        call.output = encodeModelMessages(input.output);
      }
    },
    start(input: LlmStart) {
      const key = `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`;
      const parent = options.parentContext(input);

      if (!parent || calls.has(key) || options.history.has(input.interaction.run, "llm", key)) {
        return;
      }

      calls.set(key, {
        compactionID: input.compactionID,
        reference: {
          id: input.id,
          interaction: {
            id: input.interaction.id,
            run: { ...input.interaction.run },
          },
        },
        span: options.tracer.startSpan(
          `${options.tracePrefix}llm`,
          {
            kind: SpanKind.CLIENT,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.interaction.run.sessionID,
              "gen_ai.conversation.id": input.interaction.run.sessionID,
              "gen_ai.operation.name": input.operation,
              "gen_ai.provider.name": input.providerName,
              "opencode.provider.id": input.providerID,
              "gen_ai.request.model": input.model,
              "opencode.message.id": input.id,
              "gen_ai.agent.name": input.agentName,
              "opencode.agent.type": input.agentType,
              "opencode.session.parent_id": input.parentSessionID,
              "opencode.compaction.id": input.compactionID,
              "gen_ai.request.stream": input.stream,
              "gen_ai.request.temperature": input.parameters?.temperature,
              "gen_ai.request.top_p": input.parameters?.topP,
              "gen_ai.request.top_k": input.parameters?.topK,
              "gen_ai.request.max_tokens": input.parameters?.maxTokens,
              "opencode.llm.retry_count": 0,
              "opencode.llm.retry_history": "[]",
              ...(input.userID ? { "user.id": input.userID } : {}),
              ...(options.captureContent && input.input !== undefined
                ? { "gen_ai.input.messages": encodeTextMessage("user", input.input) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    closeRun(run: RunReference, endedAt: number, error?: ObservationError) {
      calls.forEach((call) => {
        if (
          call.reference.interaction.run.sessionID === run.sessionID &&
          call.reference.interaction.run.id === run.id
        ) {
          finish({
            ...call.reference,
            endedAt,
            output: undefined,
            error: error ?? { type: "_OTHER", message: "session ended before message completed" },
          });
        }
      });
    },
    closeCompaction(
      interaction: LlmReference["interaction"],
      id: string,
      endedAt: number,
      error?: ObservationError,
    ) {
      calls.forEach((call) => {
        if (
          call.compactionID === id &&
          call.reference.interaction.id === interaction.id &&
          call.reference.interaction.run.id === interaction.run.id &&
          call.reference.interaction.run.sessionID === interaction.run.sessionID
        ) {
          finish({
            ...call.reference,
            endedAt,
            output: undefined,
            error: error ?? {
              type: "_OTHER",
              message: "compaction ended before message completed",
            },
          });
        }
      });
    },
    close(endedAt: number) {
      calls.forEach((call) =>
        finish({
          ...call.reference,
          endedAt,
          output: undefined,
          error: { type: "_OTHER", message: "plugin disposed before message completed" },
        }),
      );
    },
  };
}
