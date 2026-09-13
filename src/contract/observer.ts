import type { JsonValue, ModelInput, ModelMessage } from "./messages.js";

export type AgentIdentity = {
  agentName?: string;
  agentType?: "primary" | "subagent";
  parentSessionID?: string;
  userID?: string;
};

export type RunReference = { sessionID: string; id: string };

export type ObservationError = { type: string; message?: string };

export type RunStart = RunReference & {
  /** Source creation time, in Unix epoch milliseconds. */
  startedAt: number;
  userID?: string;
  /** Exact task tool association, when known before the run starts. */
  parent: ToolReference | undefined;
  parentSessionID: string | undefined;
};

export type RunUpdate = RunReference & {
  /** Append once per input ID; repeated IDs retain the first snapshot. */
  input: { id: string; text: string | undefined };
};

export type RunFinish = RunReference & {
  /** Source termination observation time, in Unix epoch milliseconds. */
  endedAt: number;
  /** Final answer snapshot: undefined is unknown; an empty string is known empty. */
  output: string | undefined;
  error?: ObservationError;
};

export type InteractionReference = { run: RunReference; id: string };

export type InteractionStart = InteractionReference & {
  /** Owner user message creation time, in Unix epoch milliseconds. */
  startedAt: number;
  input: string | undefined;
  agentName: string;
  userID?: string;
  agentType: AgentIdentity["agentType"];
  parentSessionID: string | undefined;
};

export type InteractionFinish = InteractionReference & {
  /** Assistant completion, steer creation, or terminal observation time in epoch milliseconds. */
  endedAt: number;
} & (
    | { status: "completed"; output: string | undefined }
    | { status: "superseded" }
    | { status: "failed"; error: ObservationError }
  );

export type LlmReference = { interaction: InteractionReference; id: string };

export type TraceHeaders = {
  traceparent: string;
  tracestate?: string;
};

export type LlmParameters = {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
};

export type LlmStart = LlmReference & {
  /** Request preparation time, or first model step observation as fallback, in Unix epoch milliseconds. */
  startedAt: number;
  providerID: string;
  providerName: string;
  model: string;
  operation: "chat" | "generate_content" | "text_completion";
  stream: boolean;
  agentName?: string;
  userID?: string;
  /** Owner text fallback; this is not the full model request. */
  input: string | undefined;
  parameters?: LlmParameters;
  agentType: AgentIdentity["agentType"];
  parentSessionID: string | undefined;
  compactionID: string | undefined;
};

export type LlmFinish = LlmReference & {
  /** Model step completion or terminal event observation time in epoch milliseconds. */
  endedAt: number;
  /** Observed assistant text snapshot, with undefined distinct from known empty text. */
  output: string | undefined;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cost?: number;
  error?: ObservationError;
};

export type LlmUpdate = LlmReference & {
  /** Replace the request snapshot and clear the previous attempt's output. */
  input?: ModelInput;
  /** Replace generated candidates; [] means a confirmed empty response. */
  output?: ModelMessage[];
};

export type ToolReference = {
  interaction: InteractionReference;
  messageID: string;
  callID: string;
};

export type ToolStart = ToolReference &
  AgentIdentity & {
    name: string;
    startedAt: number;
    arguments?: { [key: string]: JsonValue };
  };

export type ToolUpdate = ToolReference & { arguments?: { [key: string]: JsonValue } };

export type ToolFinish = ToolReference & {
  endedAt: number;
  output?: string;
  error?: ObservationError;
};

export type CompactionReference = { interaction: InteractionReference; id: string };

export type CompactionStart = CompactionReference &
  AgentIdentity & {
    startedAt: number;
    auto: boolean;
    overflow: boolean;
    triggerMessageID?: string;
  };

export type CompactionFinish = CompactionReference & {
  endedAt: number;
  promptTokens?: number;
  summaryTokens?: number;
  /** Mirrors the completed summary model's normalized usage. */
  usage?: LlmFinish["usage"];
  error?: ObservationError;
};

export type PermissionReference = { tool: ToolReference; requestID: string };

export type PermissionStart = PermissionReference &
  AgentIdentity & {
    startedAt: number;
    toolName: string;
    name: string;
    patterns: string[];
  };

export type PermissionFinish = PermissionReference & {
  endedAt: number;
} & (
    | { reply: "once" | "always" | "reject"; error?: never }
    | { reply?: never; error: ObservationError }
  );

export type Observer = {
  /** Recording is synchronous and never waits for network export. */
  startRun(input: RunStart): void;
  updateRun(input: RunUpdate): void;
  finishRun(input: RunFinish): void;
  startInteraction(input: InteractionStart): void;
  finishInteraction(input: InteractionFinish): void;
  startLlm(input: LlmStart): void;
  /** Propagate an active LLM's context; unknown, finished, or closed calls return undefined. */
  llmTraceHeaders(input: LlmReference): TraceHeaders | undefined;
  updateLlm(input: LlmUpdate): void;
  finishLlm(input: LlmFinish): void;
  startTool(input: ToolStart): void;
  updateTool(input: ToolUpdate): void;
  finishTool(input: ToolFinish): void;
  startCompaction(input: CompactionStart): void;
  finishCompaction(input: CompactionFinish): void;
  startPermission(input: PermissionStart): void;
  finishPermission(input: PermissionFinish): void;
  /** Export ended operations without ending active operations; failures reject. */
  flush(): Promise<void>;
  /** End unfinished descendants before parents, then drain and close once. */
  shutdown(): Promise<void>;
};
