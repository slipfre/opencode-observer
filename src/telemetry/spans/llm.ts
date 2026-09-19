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
  const activeSpans = new Map<
    string,
    {
      reference: LlmReference;
      compactionID?: string;
      span: Span;
      spanStartedAt: number;
      timeToFirstChunkSeconds?: number;
      inputSnapshot?: { messagesJson: string; systemInstructionsJson: string | undefined };
      outputMessagesJson?: string;
      outputType?: string;
      toolDefinitionsJson?: string;
      requestHeaders?: ModelHeaders;
      responseHeaders?: ModelHeaders;
    }
  >();
  const propagator = new W3CTraceContextPropagator();

  function finish(input: LlmFinish) {
    const key = `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`;
    const spanState = activeSpans.get(key);

    if (!spanState || spanState.reference.interaction.id !== input.interaction.id) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(spanState.reference.interaction.run, "llm", key);
    spanState.span.setAttributes({
      "gen_ai.response.time_to_first_chunk": spanState.timeToFirstChunkSeconds,
      "opencode.llm.time_to_first_chunk.source":
        spanState.timeToFirstChunkSeconds === undefined ? undefined : "step-start",
      "gen_ai.output.type": spanState.outputType,
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
      spanState.span.setAttributes({
        "gen_ai.tool.definitions": spanState.toolDefinitionsJson,
        ...Object.fromEntries(
          Object.entries(spanState.requestHeaders ?? {}).map(([key, value]) => [
            `http.request.header.${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(input.responseHeaders ?? spanState.responseHeaders ?? {}).map(
            ([key, value]) => [`http.response.header.${key}`, value],
          ),
        ),
        "gen_ai.input.messages": spanState.inputSnapshot?.messagesJson,
        "gen_ai.system_instructions": spanState.inputSnapshot?.systemInstructionsJson,
        "gen_ai.output.messages":
          spanState.outputMessagesJson ??
          (input.fallbackOutputText !== undefined
            ? encodeTextMessage("assistant", input.fallbackOutputText)
            : undefined),
      });
    }

    if (input.error) {
      spanState.span.setAttribute("error.type", input.error.type);
      spanState.span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message });
    }

    spanState.span.end(new Date(input.endedAt));
  }

  return {
    finish,
    traceHeaders(input: LlmReference): TraceHeaders | undefined {
      const spanState = activeSpans.get(
        `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`,
      );

      if (!spanState || spanState.reference.interaction.id !== input.interaction.id) {
        return;
      }

      const headers: Record<string, string> = {};
      propagator.inject(
        trace.setSpan(options.rootContext, spanState.span),
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
      const spanState = activeSpans.get(
        `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`,
      );

      if (!spanState || spanState.reference.interaction.id !== input.interaction.id) {
        return;
      }

      if (input.firstChunkEstimate && spanState.timeToFirstChunkSeconds === undefined) {
        const elapsedMs =
          input.firstChunkEstimate.observedAt - input.firstChunkEstimate.firstSdkStepStartedAt;
        if (
          input.firstChunkEstimate.firstSdkStepStartedAt >= 0 &&
          Number.isFinite(elapsedMs) &&
          elapsedMs >= 0
        ) {
          spanState.timeToFirstChunkSeconds = elapsedMs / 1000;
        }
      }

      if (input.retries) {
        spanState.span.setAttributes({
          "opencode.llm.retry_count": input.retries.length,
          "opencode.llm.retry_history": JSON.stringify(
            input.retries.map((retry) => ({
              attempt: retry.attempt,
              reason: retry.reason,
              scheduled_start_offset_ms:
                retry.scheduledAt === undefined
                  ? undefined
                  : retry.scheduledAt - spanState.spanStartedAt,
              observed_start_offset_ms: retry.observedAt - spanState.spanStartedAt,
            })),
          ),
        });
      }

      if (input.request) {
        spanState.outputType = input.request.outputType;
        delete spanState.outputMessagesJson;
        delete spanState.responseHeaders;
      }

      if (!options.captureContent) {
        return;
      }

      if (input.request) {
        spanState.toolDefinitionsJson =
          input.request.toolDefinitions === undefined
            ? undefined
            : JSON.stringify(input.request.toolDefinitions);
        spanState.requestHeaders =
          input.request.headers === undefined ? undefined : structuredClone(input.request.headers);
      }

      if (input.responseHeaders !== undefined) {
        spanState.responseHeaders = structuredClone(input.responseHeaders);
      }

      if (input.input) {
        spanState.inputSnapshot = {
          messagesJson: encodeModelMessages(input.input.messages),
          systemInstructionsJson:
            input.input.systemInstructions === undefined
              ? undefined
              : encodeSystemInstructions(input.input.systemInstructions),
        };
        delete spanState.outputMessagesJson;
      }

      if (input.output !== undefined) {
        spanState.outputMessagesJson = encodeModelMessages(input.output);
      }
    },
    start(input: LlmStart) {
      const key = `${input.interaction.run.sessionID}:${input.interaction.run.id}:${input.id}`;
      const parent = options.parentContext(input);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.interaction.run, "llm", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        spanStartedAt: input.startedAt,
        compactionID: input.compactionID,
        reference: {
          id: input.id,
          interaction: {
            id: input.interaction.id,
            run: { ...input.interaction.run },
          },
        },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}llm`,
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
              "gen_ai.request.max_tokens": input.parameters?.maxOutputTokens,
              "opencode.llm.retry_count": 0,
              "opencode.llm.retry_history": "[]",
              ...(options.captureContent && input.fallbackInputText !== undefined
                ? { "gen_ai.input.messages": encodeTextMessage("user", input.fallbackInputText) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (
          spanState.reference.interaction.run.sessionID === run.sessionID &&
          spanState.reference.interaction.run.id === run.id
        ) {
          finish({
            ...spanState.reference,
            endedAt,
            fallbackOutputText: undefined,
            error: error ?? { type: "_OTHER", message: "session ended before message completed" },
          });
        }
      });
    },
    finishForCompaction(
      interaction: LlmReference["interaction"],
      compactionID: string,
      endedAt: number,
      error?: ObservationError,
    ) {
      activeSpans.forEach((spanState) => {
        if (
          spanState.compactionID === compactionID &&
          spanState.reference.interaction.id === interaction.id &&
          spanState.reference.interaction.run.id === interaction.run.id &&
          spanState.reference.interaction.run.sessionID === interaction.run.sessionID
        ) {
          finish({
            ...spanState.reference,
            endedAt,
            fallbackOutputText: undefined,
            error: error ?? {
              type: "_OTHER",
              message: "compaction ended before message completed",
            },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          fallbackOutputText: undefined,
          error: { type: "_OTHER", message: "plugin disposed before message completed" },
        }),
      );
    },
  };
}
