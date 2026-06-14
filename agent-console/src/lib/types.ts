// ─────────────────────────────────────────────────────────────
// Protocol Types (mirrors agent-server/src/types.ts)
// ─────────────────────────────────────────────────────────────

// ── Server → Client Messages ──────────────────────────────────

export interface TokenMessage {
  type: "TOKEN";
  seq: number;
  text: string;
  stream_id: string;
}

export interface ToolCallMessage {
  type: "TOOL_CALL";
  seq: number;
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  stream_id: string;
}

export interface ToolResultMessage {
  type: "TOOL_RESULT";
  seq: number;
  call_id: string;
  result: Record<string, unknown>;
  stream_id: string;
}

export interface ContextSnapshotMessage {
  type: "CONTEXT_SNAPSHOT";
  seq: number;
  context_id: string;
  data: Record<string, unknown>;
}

export interface PingMessage {
  type: "PING";
  seq: number;
  challenge: string;
}

export interface StreamEndMessage {
  type: "STREAM_END";
  seq: number;
  stream_id: string;
}

export interface ErrorMessage {
  type: "ERROR";
  seq: number;
  code: string;
  message: string;
}

export type ServerMessage =
  | TokenMessage
  | ToolCallMessage
  | ToolResultMessage
  | ContextSnapshotMessage
  | PingMessage
  | StreamEndMessage
  | ErrorMessage;

// ── Client → Server Messages ──────────────────────────────────

export interface UserMessagePayload {
  type: "USER_MESSAGE";
  content: string;
}

export interface PongPayload {
  type: "PONG";
  echo: string;
}

export interface ResumePayload {
  type: "RESUME";
  last_seq: number;
}

export interface ToolAckPayload {
  type: "TOOL_ACK";
  call_id: string;
}

export type ClientMessage =
  | UserMessagePayload
  | PongPayload
  | ResumePayload
  | ToolAckPayload;

// ─────────────────────────────────────────────────────────────
// Connection State Machine
// ─────────────────────────────────────────────────────────────

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RESUMING"
  | "STREAMING"
  | "TOOL_CALL_PENDING"
  | "RECONNECTING"
  | "WAITING_TO_RECONNECT";

// ─────────────────────────────────────────────────────────────
// Chat UI Model
// ─────────────────────────────────────────────────────────────

export type ToolCallStatus = "pending" | "complete";

export interface TextSegment {
  kind: "text";
  content: string;
  startSeq: number;
  endSeq: number;
}

export interface ToolCallSegment {
  kind: "tool_call";
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ToolCallStatus;
  seq: number;
  resultSeq: number | null;
}

export type ChatSegment = TextSegment | ToolCallSegment;

export interface AgentMessage {
  id: string;
  streamId: string;
  segments: ChatSegment[];
  isComplete: boolean;
  startedAt: number;
  completedAt: number | null;
}

export interface UserChatEntry {
  id: string;
  content: string;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────
// Timeline UI Model
// ─────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  type: ServerMessage["type"];
  seq: number;
  timestamp: number;
  data: ServerMessage;
  /** For linking tool call/result pairs */
  linkedEventId?: string;
}

export interface TokenBatch {
  id: string;
  streamId: string;
  tokenCount: number;
  totalText: string;
  startSeq: number;
  endSeq: number;
  startTime: number;
  endTime: number;
  duration: number;
}

// ─────────────────────────────────────────────────────────────
// Context Inspector Model
// ─────────────────────────────────────────────────────────────

export interface ContextSnapshot {
  contextId: string;
  seq: number;
  timestamp: number;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// JSON Diff Types
// ─────────────────────────────────────────────────────────────

export type DiffChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffEntry {
  path: string[];
  kind: DiffChangeKind;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface DiffResult {
  entries: DiffEntry[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
}
