import type { OnStepFinishEvent, OnStepStartEvent } from "ai";
import type { JsonValue, ModelInput, ModelMessage, ModelPart } from "../../contract/messages.js";
import { toJsonValue } from "../shared/json.js";

export function parseModelInput(
  event: Pick<OnStepStartEvent, "messages" | "system" | "providerOptions">,
): ModelInput {
  const messages = parseModelMessages(event.messages);
  const system =
    typeof event.system === "string"
      ? [{ type: "text" as const, text: event.system }]
      : event.system === undefined
        ? undefined
        : parseModelMessages(Array.isArray(event.system) ? event.system : [event.system]).flatMap(
            (message) => message.parts,
          );
  const instructions = isRecord(event.providerOptions)
    ? [event.providerOptions, ...Object.values(event.providerOptions)]
        .filter(isRecord)
        .find((options) => typeof options.instructions === "string")?.instructions
    : undefined;

  return {
    messages,
    systemInstructions:
      system ??
      (!messages.some((message) => message.role === "system") && typeof instructions === "string"
        ? [{ type: "text", text: instructions }]
        : undefined),
  };
}

export function parseModelOutput(
  event: Pick<OnStepFinishEvent, "content" | "response">,
): ModelMessage[] | undefined {
  // response.messages can include previous steps and tool execution results.
  // content is the current step's generated content, in generation order.
  if (Array.isArray(event.content)) {
    const parts = event.content
      .filter((part) => part.type !== "tool-result" && part.type !== "tool-error")
      .map(parseModelPart)
      .filter((part) => part !== undefined);
    return parts.length > 0
      ? [{ role: "assistant", parts }]
      : event.content.length === 0
        ? []
        : undefined;
  }

  if (!Array.isArray(event.response?.messages)) {
    return;
  }

  const assistant = parseModelMessages(event.response.messages).findLast(
    (message) => message.role === "assistant",
  );
  return assistant ? [assistant] : [];
}

function parseModelMessages(values: unknown): ModelMessage[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.flatMap((value) => {
    if (!isRecord(value) || typeof value.role !== "string") {
      return [];
    }

    if (typeof value.content === "string") {
      return [{ role: value.role, parts: [{ type: "text" as const, text: value.content }] }];
    }

    if (!Array.isArray(value.content)) {
      return [];
    }

    const parts = value.content.map(parseModelPart).filter((part) => part !== undefined);
    return parts.length > 0 || value.content.length === 0 ? [{ role: value.role, parts }] : [];
  });
}

function parseModelPart(value: unknown): ModelPart | undefined {
  if (!isRecord(value)) {
    return;
  }

  if ((value.type === "text" || value.type === "reasoning") && typeof value.text === "string") {
    return { type: value.type, text: value.text };
  }

  if (value.type === "tool-call" && typeof value.toolName === "string") {
    return {
      type: "tool-call",
      name: value.toolName,
      id: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
      arguments: parseToolArguments(value.input !== undefined ? value.input : value.args),
    };
  }

  if (value.type === "tool-result" || value.type === "tool-error") {
    const output =
      value.type === "tool-error"
        ? value.error
        : value.output !== undefined
          ? value.output
          : value.result;
    const response = toJsonValue(isRecord(output) && "value" in output ? output.value : output);

    return response === undefined
      ? undefined
      : {
          type: "tool-result",
          id: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
          response,
        };
  }

  if (value.type !== "image" && value.type !== "file") {
    return;
  }

  const file = isRecord(value.file) ? value.file : value;
  const data = value.image ?? file.data ?? file.uint8Array ?? file.base64 ?? file.url;
  const dataUri =
    typeof data === "string" ? /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data) : undefined;
  const mimeType = typeof file.mediaType === "string" ? file.mediaType : dataUri?.[1] || undefined;
  const modality =
    value.type === "image" || mimeType?.startsWith("image/")
      ? "image"
      : mimeType?.startsWith("audio/")
        ? "audio"
        : mimeType?.startsWith("video/")
          ? "video"
          : "document";
  const source = parseMediaSource(data, dataUri);

  return source ? { type: "media", modality, mimeType, source } : undefined;
}

function parseMediaSource(
  value: unknown,
  dataUri: RegExpExecArray | null | undefined,
): Extract<ModelPart, { type: "media" }>["source"] | undefined {
  if (dataUri) {
    if (dataUri[2]) {
      return { type: "base64", data: dataUri[3] ?? "" };
    }

    try {
      return {
        type: "base64",
        data: Buffer.from(decodeURIComponent(dataUri[3] ?? "")).toString("base64"),
      };
    } catch {
      return;
    }
  }

  if (value instanceof URL || (typeof value === "string" && /^[a-z][a-z0-9+.-]*:/i.test(value))) {
    return { type: "uri", uri: String(value) };
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return {
      type: "base64",
      data: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString(
        "base64",
      ),
    };
  }

  if (
    typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return { type: "base64", data: value };
  }
}

function parseToolArguments(value: unknown): JsonValue | undefined {
  if (typeof value === "string") {
    try {
      return toJsonValue(JSON.parse(value));
    } catch {
      return value;
    }
  }

  return toJsonValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
