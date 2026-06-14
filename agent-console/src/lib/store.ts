// ─────────────────────────────────────────────────────────────
// Zustand Store — Central state for the Agent Console
//
// Why Zustand:
// - Minimal boilerplate for WebSocket-driven state
// - Subscriptions are surgical — components re-render only
//   on the slices they use (no context cascades)
// - No providers needed
// - Works well with imperative updates from the WS manager
// ─────────────────────────────────────────────────────────────

import { create } from "zustand";
import type {
  ConnectionState,
  ServerMessage,
  AgentMessage,
  UserChatEntry,
  TimelineEvent,
  TokenBatch,
  ContextSnapshot,
  ChatSegment,
} from "./types";

// ── Token batch grouping threshold ──────────────────────────
const TOKEN_BATCH_GAP_MS = 300;

// ── Store interface ─────────────────────────────────────────

interface AgentStore {
  // Connection
  connectionState: ConnectionState;
  reconnectAttempt: number;

  // Chat (Task 1)
  userMessages: UserChatEntry[];
  agentMessages: AgentMessage[];
  activeStreamId: string | null;

  // Timeline (Task 2)
  events: TimelineEvent[];
  tokenBatches: TokenBatch[];
  selectedEventId: string | null;
  eventTypeFilters: Set<string>;
  eventSearchQuery: string;

  // Context (Task 3)
  contextSnapshots: Map<string, ContextSnapshot[]>;
  activeContextId: string | null;
  scrubberIndex: number;

  // Actions
  processServerMessage: (msg: ServerMessage) => void;
  addUserMessage: (content: string) => void;
  setConnectionState: (state: ConnectionState) => void;
  setReconnectAttempt: (attempt: number) => void;
  setSelectedEventId: (id: string | null) => void;
  setEventTypeFilters: (types: Set<string>) => void;
  setEventSearchQuery: (query: string) => void;
  setActiveContextId: (id: string | null) => void;
  setScrubberIndex: (index: number) => void;
  resetChat: () => void;
}

// ── Helper: generate a unique ID ────────────────────────────
let idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}_${++idCounter}_${Date.now()}`;
}

// ── Store creation ──────────────────────────────────────────

export const useAgentStore = create<AgentStore>((set, get) => ({
  // ── Initial state ─────────────────────────────────────────
  connectionState: "DISCONNECTED",
  reconnectAttempt: 0,
  userMessages: [],
  agentMessages: [],
  activeStreamId: null,
  events: [],
  tokenBatches: [],
  selectedEventId: null,
  eventTypeFilters: new Set<string>(),
  eventSearchQuery: "",
  contextSnapshots: new Map<string, ContextSnapshot[]>(),
  activeContextId: null,
  scrubberIndex: -1,

  // ── Actions ───────────────────────────────────────────────

  setConnectionState: (state) => set({ connectionState: state }),
  setReconnectAttempt: (attempt) => set({ reconnectAttempt: attempt }),
  setSelectedEventId: (id) => set({ selectedEventId: id }),
  setEventTypeFilters: (types) => set({ eventTypeFilters: types }),
  setEventSearchQuery: (query) => set({ eventSearchQuery: query }),
  setActiveContextId: (id) => set({ activeContextId: id }),
  setScrubberIndex: (index) => set({ scrubberIndex: index }),

  resetChat: () =>
    set({
      userMessages: [],
      agentMessages: [],
      activeStreamId: null,
      events: [],
      tokenBatches: [],
      contextSnapshots: new Map(),
      activeContextId: null,
      scrubberIndex: -1,
    }),

  addUserMessage: (content) =>
    set((state) => ({
      userMessages: [
        ...state.userMessages,
        { id: uid("usr"), content, timestamp: Date.now() },
      ],
      events: [],
      tokenBatches: [],
      contextSnapshots: new Map(),
      activeContextId: null,
      scrubberIndex: -1,
      selectedEventId: null,
    })),

  // ── Message processor ─────────────────────────────────────
  processServerMessage: (msg: ServerMessage) => {
    const state = get();
    const now = Date.now();

    // 1. Add to timeline events
    const eventId = uid("evt");
    const timelineEvent: TimelineEvent = {
      id: eventId,
      type: msg.type,
      seq: msg.seq,
      timestamp: now,
      data: msg,
    };

    // 2. Process by message type
    switch (msg.type) {
      case "TOKEN": {
        // Update or create the active agent message
        const agentMessages = [...state.agentMessages];
        let activeMsg = agentMessages.find(
          (m) => m.streamId === msg.stream_id && !m.isComplete
        );

        if (!activeMsg) {
          // Create new agent message for this stream
          activeMsg = {
            id: uid("agt"),
            streamId: msg.stream_id,
            segments: [],
            isComplete: false,
            startedAt: now,
            completedAt: null,
          };
          agentMessages.push(activeMsg);
        } else {
          // Clone for immutability
          const idx = agentMessages.indexOf(activeMsg);
          activeMsg = { ...activeMsg, segments: [...activeMsg.segments] };
          agentMessages[idx] = activeMsg;
        }

        // Append token to the last text segment, or create a new one
        const lastSegment =
          activeMsg.segments.length > 0
            ? activeMsg.segments[activeMsg.segments.length - 1]
            : null;

        if (lastSegment && lastSegment.kind === "text") {
          // Clone and append
          const updatedSegment = {
            ...lastSegment,
            content: lastSegment.content + msg.text,
            endSeq: msg.seq,
          };
          activeMsg.segments[activeMsg.segments.length - 1] = updatedSegment;
        } else {
          // New text segment
          const newSegment: ChatSegment = {
            kind: "text",
            content: msg.text,
            startSeq: msg.seq,
            endSeq: msg.seq,
          };
          activeMsg.segments.push(newSegment);
        }

        // Update token batching for timeline
        const tokenBatches = [...state.tokenBatches];
        const lastBatch =
          tokenBatches.length > 0
            ? tokenBatches[tokenBatches.length - 1]
            : null;

        if (
          lastBatch &&
          lastBatch.streamId === msg.stream_id &&
          now - lastBatch.endTime < TOKEN_BATCH_GAP_MS
        ) {
          // Extend the existing batch
          tokenBatches[tokenBatches.length - 1] = {
            ...lastBatch,
            tokenCount: lastBatch.tokenCount + 1,
            totalText: lastBatch.totalText + msg.text,
            endSeq: msg.seq,
            endTime: now,
            duration: now - lastBatch.startTime,
          };
        } else {
          // New batch
          tokenBatches.push({
            id: uid("batch"),
            streamId: msg.stream_id,
            tokenCount: 1,
            totalText: msg.text,
            startSeq: msg.seq,
            endSeq: msg.seq,
            startTime: now,
            endTime: now,
            duration: 0,
          });
        }

        set({
          agentMessages,
          activeStreamId: msg.stream_id,
          tokenBatches,
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "TOOL_CALL": {
        const agentMessages = [...state.agentMessages];
        let activeMsg = agentMessages.find(
          (m) => m.streamId === msg.stream_id && !m.isComplete
        );

        if (!activeMsg) {
          activeMsg = {
            id: uid("agt"),
            streamId: msg.stream_id,
            segments: [],
            isComplete: false,
            startedAt: now,
            completedAt: null,
          };
          agentMessages.push(activeMsg);
        } else {
          const idx = agentMessages.indexOf(activeMsg);
          activeMsg = { ...activeMsg, segments: [...activeMsg.segments] };
          agentMessages[idx] = activeMsg;
        }

        // Add tool call segment
        const toolSegment: ChatSegment = {
          kind: "tool_call",
          callId: msg.call_id,
          toolName: msg.tool_name,
          args: msg.args,
          result: null,
          status: "pending",
          seq: msg.seq,
          resultSeq: null,
        };
        activeMsg.segments.push(toolSegment);

        set({
          agentMessages,
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "TOOL_RESULT": {
        const agentMessages = state.agentMessages.map((agentMsg) => {
          if (agentMsg.streamId !== msg.stream_id) return agentMsg;

          const segments = agentMsg.segments.map((seg) => {
            if (seg.kind === "tool_call" && seg.callId === msg.call_id) {
              return {
                ...seg,
                result: msg.result,
                status: "complete" as const,
                resultSeq: msg.seq,
              };
            }
            return seg;
          });

          return { ...agentMsg, segments };
        });

        // Link tool call and tool result events
        const toolCallEvent = state.events.find(
          (e) =>
            e.data.type === "TOOL_CALL" &&
            (e.data as { call_id: string }).call_id === msg.call_id
        );

        if (toolCallEvent) {
          timelineEvent.linkedEventId = toolCallEvent.id;
        }

        set({
          agentMessages,
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "STREAM_END": {
        const agentMessages = state.agentMessages.map((agentMsg) => {
          if (agentMsg.streamId === msg.stream_id && !agentMsg.isComplete) {
            return { ...agentMsg, isComplete: true, completedAt: now };
          }
          return agentMsg;
        });

        set({
          agentMessages,
          activeStreamId: null,
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "CONTEXT_SNAPSHOT": {
        const contextSnapshots = new Map(state.contextSnapshots);
        const existing = contextSnapshots.get(msg.context_id) || [];
        const snapshot: ContextSnapshot = {
          contextId: msg.context_id,
          seq: msg.seq,
          timestamp: now,
          data: msg.data,
        };
        contextSnapshots.set(msg.context_id, [...existing, snapshot]);

        const newScrubberIndex = existing.length; // Point to the new snapshot

        set({
          contextSnapshots,
          activeContextId: state.activeContextId || msg.context_id,
          scrubberIndex: newScrubberIndex,
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "PING": {
        // PINGs are handled by the WS manager (PONG sent there).
        // Just add to timeline.
        set({
          events: [...state.events, timelineEvent],
        });
        break;
      }

      case "ERROR": {
        set({
          events: [...state.events, timelineEvent],
        });
        break;
      }
    }
  },
}));
