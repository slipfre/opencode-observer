export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ModelPart =
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool-call"; id?: string; name: string; arguments?: JsonValue }
  | { type: "tool-result"; id?: string; response: JsonValue }
  | {
      type: "media";
      modality: "image" | "audio" | "video" | "document";
      mimeType?: string;
      source: { type: "uri"; uri: string } | { type: "base64"; data: string };
    };

export type ModelMessage = { role: string; parts: ModelPart[] };

export type ModelInput = {
  messages: ModelMessage[];
  /** Instructions supplied separately from chat history. */
  systemInstructions?: ModelPart[];
};
