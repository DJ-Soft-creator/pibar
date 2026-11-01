// Types of Pi's RPC protocol (`pi --mode rpc`) as far as PiBar reads it: events on stdout, messages, content parts
// and the answers of the RPC commands. Pi sends dynamic JSON that is not checked at runtime, so every field PiBar does
// not strictly need is optional, and unknown event or part types simply fall through to the `default` branches.
import type { PiCommand, PiModel } from "./api";

/** Arguments of a tool call, e.g. { command } for bash or { path } for read */
export type ToolArgs = Record<string, unknown>;

export interface TextPart {
  type: "text";
  text?: string;
}
export interface ThinkingPart {
  type: "thinking";
  thinking?: string;
}
export interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: ToolArgs;
}
export interface ImagePart {
  type: "image";
  data?: string;
  mimeType?: string;
}
export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ImagePart;

/** Content of a user message or a tool result: plain text or parts */
export type Content = string | ContentPart[];

/** Token usage of one answer; `cost` is a number or { total } depending on the Pi version */
export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number | { total?: number };
}

export interface UserMessage {
  role: "user";
  content?: Content;
  timestamp?: number | string;
}
export interface AssistantMessage {
  role: "assistant";
  content?: ContentPart[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  /** Model that actually answered */
  provider?: string;
  model?: string;
  timestamp?: number | string;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  content?: Content;
  isError?: boolean;
  timestamp?: number | string;
}
export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** Streaming step of an answer (event message_update) */
export interface AssistantMessageEvent {
  type?: string;
  contentIndex: number;
  delta: string;
  /** toolcall_start */
  id: string;
  toolName: string;
  /** toolcall_end */
  toolCall?: { id: string; arguments?: ToolArgs };
}

export interface ToolOutput {
  content?: Content;
}

/** Dialog or notice from a Pi extension (RPC extension UI). Dialogs (select, confirm, input, editor) wait for an answer. */
export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Pi answers by itself after this many ms */
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  text?: string;
}

export type PiEvent =
  | UiRequest
  | { type: "agent_start" | "turn_start" | "agent_settled" }
  | { type: "message_start" | "message_end"; message?: PiMessage }
  | { type: "message_update"; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "tool_execution_start"; toolCallId: string; toolName?: string; args?: ToolArgs }
  | { type: "tool_execution_update"; toolCallId: string; partialResult?: ToolOutput }
  | { type: "tool_execution_end"; toolCallId: string; result?: ToolOutput; isError?: boolean; durationMs?: number };

/** Answer of get_state */
export interface PiState {
  model?: PiModel | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  sessionFile?: string;
  sessionName?: string;
  messageCount?: number;
}

/** Answer of get_session_stats (whole session) */
export interface PiSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number | null };
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
}

/** Answers (`data`) of the RPC commands PiBar sends, by command type */
export interface PiRpcResults {
  get_state: PiState;
  get_messages: { messages?: PiMessage[] };
  get_session_stats: PiSessionStats;
  get_available_models: { models?: PiModel[] };
  get_available_thinking_levels: { levels?: string[] };
  get_commands: { commands?: PiCommand[] };
  get_fork_messages: { messages?: { entryId: string; text: string }[] };
  fork: { cancelled?: boolean; text?: string } | undefined;
  switch_session: { cancelled?: boolean } | undefined;
  set_model: PiModel | undefined;
  prompt: { disposition?: string } | undefined;
}

/** Result type of an RPC command; commands not listed above return nothing PiBar reads */
export type PiResult<K extends string> = K extends keyof PiRpcResults ? PiRpcResults[K] : unknown;
