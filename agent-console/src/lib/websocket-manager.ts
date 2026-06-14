// ─────────────────────────────────────────────────────────────
// WebSocket Protocol Manager
//
// Handles the complete WebSocket lifecycle:
// - Connection / disconnection
// - PING/PONG heartbeat
// - TOOL_ACK sending
// - RESUME on reconnection
// - Exponential backoff reconnection
// - Message dedup + reorder pipeline
//
// This is a pure protocol handler — no React dependencies.
// It calls into the Zustand store for state updates.
// ─────────────────────────────────────────────────────────────

import { ReorderBuffer } from "./reorder-buffer";
import { SeqDeduplicator } from "./dedup";
import type {
  ServerMessage,
  ConnectionState,
} from "./types";

export type StoreDispatch = {
  processServerMessage: (msg: ServerMessage) => void;
  setConnectionState: (state: ConnectionState) => void;
  setReconnectAttempt: (attempt: number) => void;
};

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private dispatch: StoreDispatch;

  // ── Protocol state ─────────────────────────────────────
  private reorderBuffer: ReorderBuffer;
  private dedup: SeqDeduplicator;
  private connectionState: ConnectionState = "DISCONNECTED";

  // ── Reconnection ────────────────────────────────────────
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasExistingSession: boolean = false;
  private intentionalClose: boolean = false;

  // ── Backoff parameters ──────────────────────────────────
  private static readonly BACKOFF_BASE_MS = 500;
  private static readonly BACKOFF_CAP_MS = 10_000;
  private static readonly BACKOFF_MULTIPLIER = 2;

  constructor(url: string, dispatch: StoreDispatch) {
    this.url = url;
    this.dispatch = dispatch;
    this.reorderBuffer = new ReorderBuffer(1);
    this.dedup = new SeqDeduplicator();
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;
    this.setConnectionState("CONNECTING");

    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleRawMessage(event.data as string);
      this.ws.onclose = (event) => this.handleClose(event);
      this.ws.onerror = () => {
        // Error is always followed by close, handle reconnect there
      };
    } catch {
      this.startReconnect();
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "client_disconnect");
      }
      this.ws = null;
    }

    this.setConnectionState("DISCONNECTED");
  }

  sendUserMessage(content: string): void {
    this.send({ type: "USER_MESSAGE", content });
    // Reset seq tracking for the new conversation turn
    // (server resets seq to 0 on each USER_MESSAGE)
    this.dedup.reset();
    this.reorderBuffer = new ReorderBuffer(1);
  }

  getLastProcessedSeq(): number {
    return this.dedup.lastProcessedSeq;
  }

  /**
   * Check if the WebSocket is currently open and ready.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────

  private handleOpen(): void {
    this.reconnectAttempt = 0;
    this.dispatch.setReconnectAttempt(0);

    if (this.hasExistingSession && this.dedup.lastProcessedSeq > 0) {
      // Reconnection — send RESUME as the first message
      this.setConnectionState("RESUMING");
      this.send({ type: "RESUME", last_seq: this.dedup.lastProcessedSeq });
      // Set expected seq to resume from where we left off and clear buffer
      this.reorderBuffer.clear();
      this.reorderBuffer.setExpectedSeq(this.dedup.lastProcessedSeq + 1);
    } else {
      this.setConnectionState("CONNECTED");
    }

    this.hasExistingSession = true;
  }

  private handleClose(_event: CloseEvent): void {
    this.ws = null;

    if (this.intentionalClose) {
      this.setConnectionState("DISCONNECTED");
      return;
    }

    // Unintentional close — start reconnection
    this.startReconnect();
  }

  // ─────────────────────────────────────────────────────────
  // Reconnection with exponential backoff
  // ─────────────────────────────────────────────────────────

  private startReconnect(): void {
    this.setConnectionState("RECONNECTING");

    const delay = Math.min(
      WebSocketManager.BACKOFF_BASE_MS * Math.pow(WebSocketManager.BACKOFF_MULTIPLIER, this.reconnectAttempt),
      WebSocketManager.BACKOFF_CAP_MS
    );

    this.reconnectAttempt++;
    this.dispatch.setReconnectAttempt(this.reconnectAttempt);

    this.setConnectionState("WAITING_TO_RECONNECT");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Message pipeline: raw → parse → dedup → reorder → process
  // ─────────────────────────────────────────────────────────

  private handleRawMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      console.error("[ws] Failed to parse message:", data.slice(0, 200));
      return;
    }

    // Validate message has required fields
    if (!msg.type || typeof msg.seq !== "number") {
      console.warn("[ws] Invalid message (missing type or seq):", msg);
      return;
    }

    // Step 1: Deduplicate
    if (this.dedup.isDuplicate(msg.seq)) {
      return;
    }

    // Step 2: Respond to PING immediately (latency-sensitive, avoid server timeout)
    if (msg.type === "PING") {
      this.handlePing(msg);
    }

    // Step 3: Insert into reorder buffer
    this.reorderBuffer.insert(msg);

    // Step 4: Drain in-order messages and process them
    const ordered = this.reorderBuffer.drain();
    for (const orderedMsg of ordered) {
      if (!this.dedup.isDuplicate(orderedMsg.seq)) {
        this.processMessage(orderedMsg);
        this.dedup.markProcessed(orderedMsg.seq);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Process individual messages (after dedup + reorder)
  // ─────────────────────────────────────────────────────────

  private processMessage(msg: ServerMessage): void {
    // State machine transitions
    switch (msg.type) {
      case "TOKEN":
        if (this.connectionState === "CONNECTED" || this.connectionState === "RESUMING") {
          this.setConnectionState("STREAMING");
        }
        break;

      case "TOOL_CALL":
        this.setConnectionState("TOOL_CALL_PENDING");
        // Send TOOL_ACK immediately
        this.send({ type: "TOOL_ACK", call_id: msg.call_id });
        break;

      case "TOOL_RESULT":
        this.setConnectionState("STREAMING");
        break;

      case "STREAM_END":
        this.setConnectionState("CONNECTED");
        break;

      case "CONTEXT_SNAPSHOT":
        // Context snapshots don't change the connection FSM state
        break;

      case "ERROR":
        console.error("[ws] Server error:", msg.code, msg.message);
        this.setConnectionState("CONNECTED");
        break;
    }

    // Dispatch to store for rendering
    this.dispatch.processServerMessage(msg);
  }

  // ─────────────────────────────────────────────────────────
  // PING/PONG heartbeat
  // ─────────────────────────────────────────────────────────

  private handlePing(msg: ServerMessage & { type: "PING" }): void {
    // Handle corrupt PINGs (empty challenge) gracefully — respond anyway
    const challenge = msg.challenge ?? "";
    this.send({ type: "PONG", echo: challenge });
  }

  // ─────────────────────────────────────────────────────────
  // Send helper
  // ─────────────────────────────────────────────────────────

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ─────────────────────────────────────────────────────────
  // State setter
  // ─────────────────────────────────────────────────────────

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.dispatch.setConnectionState(state);
  }
}
