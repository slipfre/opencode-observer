import type { ModelMessage, ModelPart } from "../../contract/messages.js";

export function encodeModelMessages(messages: ModelMessage[]) {
  return JSON.stringify(
    messages.map((message) => ({ role: message.role, parts: message.parts.map(encodeModelPart) })),
  );
}

export function encodeSystemInstructions(parts: ModelPart[]) {
  return JSON.stringify(parts.map(encodeModelPart));
}

function encodeModelPart(part: ModelPart) {
  if (part.type === "text" || part.type === "reasoning") {
    return { type: part.type, content: part.text };
  }

  if (part.type === "tool-call") {
    return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
  }

  if (part.type === "tool-result") {
    return { type: "tool_call_response", id: part.id, response: part.response };
  }

  if (part.type === "media") {
    return {
      modality: part.modality,
      mime_type: part.mimeType,
      ...(part.source.type === "uri"
        ? { type: "uri", uri: part.source.uri }
        : { type: "blob", content: part.source.data }),
    };
  }
}
