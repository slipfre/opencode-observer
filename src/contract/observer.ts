import type { JsonValue, ModelInput, ModelMessage } from "./messages.js";

export type AgentContext = {
  agentName?: string;
  agentType?: "primary" | "subagent";
  parentSessionID?: string;
};

export type RunReference = { sessionID: string; id: string };

export type ObservationError = {
  type: string;
  /** Source error summary; telemetry supplies a fallback when missing or blank. */
  message?: string;
};

export type RunStart = RunReference & {
  /** Source creation time, in Unix epoch milliseconds. */
  startedAt: number;
  /** Exact task tool association, when known before the run starts. */
  parentTool: ToolReference | undefined;
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
  agentType: AgentContext["agentType"];
  parentSessionID: string | undefined;
};

export type InteractionFinish = InteractionReference & {
  /** Idle or terminal observation time, or steer creation time, in epoch milliseconds. */
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
  maxOutputTokens?: number;
};

export type ModelHeaders = Record<string, string[]>;

export type ToolDefinition = {
  type: string;
  name: string;
  description?: string;
  parameters?: JsonValue;
};

export type ModelRequestMetadata = {
  outputType?: "text" | "json";
  toolDefinitions?: ToolDefinition[];
  headers?: ModelHeaders;
};

export type LlmStart = LlmReference & {
  /** Assistant message creation time in Unix epoch milliseconds. */
  startedAt: number;
  providerID: string;
  providerName: string;
  model: string;
  operation: "chat" | "generate_content" | "text_completion";
  stream: boolean;
  agentName?: string;
  /** Owner text fallback; this is not the full model request. */
  fallbackInputText: string | undefined;
  parameters?: LlmParameters;
  agentType: AgentContext["agentType"];
  parentSessionID: string | undefined;
  compactionID: string | undefined;
};

export type LlmFinish = LlmReference & {
  /** Assistant completion time, or terminal observation time when unavailable, in epoch milliseconds. */
  endedAt: number;
  /** Selected transport boundaries; omitted for the default message lifecycle. */
  timing?:
    | {
        source: "fetch";
        startedAt: number;
        endedAt: number;
        endReason: "eof" | "empty" | "error" | "cancel";
      }
    | { source: "message"; fallbackReason: "fetch-unobserved" | "fetch-incomplete" };
  /** Observed assistant text snapshot, with undefined distinct from known empty text. */
  fallbackOutputText: string | undefined;
  responseHeaders?: ModelHeaders;
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
  /** First step-start publication time (receipt time if unavailable), in epoch milliseconds.
   * Subtract the final selected LLM start; retries and later steps never replace this observation. */
  firstChunkObservedAt?: number;
  /** Latest OpenCode retry attempt reported, excluding initial execution; may still be in backoff. */
  retryCount?: number;
  /** Replace the SDK request snapshot and clear the previous step's response. */
  request?: ModelRequestMetadata;
  /** Model reported by the response callback; may include the SDK's request-model fallback. */
  responseModel?: string;
  responseHeaders?: ModelHeaders;
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
  AgentContext & {
    name: string;
    startedAt: number;
    description?: string;
    arguments?: { [key: string]: JsonValue };
  };

export type ToolUpdate = ToolReference & {
  description?: string;
  arguments?: { [key: string]: JsonValue };
};

export type ToolFinish = ToolReference & {
  endedAt: number;
  output?: string;
  error?: ObservationError;
};

/** A skill load retains the underlying tool call identity for permission correlation. */
export type SkillReference = ToolReference;

export type SkillMetadata = {
  /** Skill identity is metadata and remains observable without content capture. */
  name?: string;
  directory?: string;
  outputTruncated?: boolean;
};

export type SkillStart = SkillReference & AgentContext & SkillMetadata & { startedAt: number };

/** Merge known metadata; omitted fields retain their previous values. */
export type SkillUpdate = SkillReference & SkillMetadata;

/** Output is the actual returned text, which may include wrappers and truncation. */
export type SkillFinish = SkillReference & {
  endedAt: number;
  output?: string;
  error?: ObservationError;
};

export type CompactionReference = { interaction: InteractionReference; id: string };

export type CompactionStart = CompactionReference &
  AgentContext & {
    startedAt: number;
    auto: boolean;
    overflow: boolean;
    triggerMessageID?: string;
  };

export type CompactionFinish = CompactionReference & {
  endedAt: number;
  promptTokens?: number;
  summaryTokens?: number;
  error?: ObservationError;
};

export type PermissionReference = { tool: ToolReference; requestID: string };

export type PermissionStart = PermissionReference &
  AgentContext & {
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

/**
 * Operations use complete references: repeated starts cannot recreate an object,
 * and repeated finishes or late updates cannot rewrite its terminal state.
 * Update payloads define their own append or replacement semantics.
 * Source event deduplication and lifecycle callbacks belong to the caller.
 */
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
  startSkill(input: SkillStart): void;
  updateSkill(input: SkillUpdate): void;
  finishSkill(input: SkillFinish): void;
  startCompaction(input: CompactionStart): void;
  finishCompaction(input: CompactionFinish): void;
  startPermission(input: PermissionStart): void;
  finishPermission(input: PermissionFinish): void;
  /** Flush buffered ended operations without ending active operations; failures reject. */
  flush(): Promise<void>;
  /** End unfinished descendants before parents, then drain and close once. */
  shutdown(): Promise<void>;
};
