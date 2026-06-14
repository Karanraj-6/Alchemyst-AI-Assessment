"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAgentStore } from "@/lib/store";
import { WebSocketManager } from "@/lib/websocket-manager";
import ChatPanel from "@/components/ChatPanel";
import ConnectionIndicator from "@/components/ConnectionIndicator";
import TimelinePanel from "@/components/TimelinePanel";
import ContextPanel from "@/components/ContextPanel";
import type { TimelineEvent, TokenBatch } from "@/lib/types";

const WS_URL = "ws://localhost:4747/ws";

export default function Home() {
  const wsManagerRef = useRef<WebSocketManager | null>(null);
  const [activeTab, setActiveTab] = useState<"timeline" | "context">("timeline");
  const connectionState = useAgentStore((s) => s.connectionState);

  // Initialize WebSocket manager
  useEffect(() => {
    const store = useAgentStore.getState();
    const dispatch = {
      processServerMessage: (msg: Parameters<typeof store.processServerMessage>[0]) => {
        useAgentStore.getState().processServerMessage(msg);
      },
      setConnectionState: (state: Parameters<typeof store.setConnectionState>[0]) => {
        useAgentStore.getState().setConnectionState(state);
      },
      setReconnectAttempt: (attempt: number) => {
        useAgentStore.getState().setReconnectAttempt(attempt);
      },
    };

    const manager = new WebSocketManager(WS_URL, dispatch);
    wsManagerRef.current = manager;
    manager.connect();

    return () => {
      manager.disconnect();
    };
  }, []);

  const handleSendMessage = useCallback((content: string) => {
    const manager = wsManagerRef.current;
    if (!manager) return;

    // Add user message to store
    useAgentStore.getState().addUserMessage(content);
    // Send via WebSocket
    manager.sendUserMessage(content);
  }, []);

  const handleToolCardClick = useCallback((eventId: string) => {
    // Scroll timeline to event — already handled by selectedEventId in TimelinePanel
    setActiveTab("timeline");
  }, []);

  const handleTimelineEventClick = useCallback(
    (eventId: string, event: TimelineEvent) => {
      // Scroll chat to the corresponding element
      const msg = event.data;
      if (msg.type === "TOOL_CALL") {
        const callId = (msg as { call_id: string }).call_id;
        const el = document.getElementById(`tool-${callId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("highlight-flash");
          setTimeout(() => el.classList.remove("highlight-flash"), 1500);
        }
      } else if (msg.type === "TOKEN") {
        const seq = msg.seq;
        const elements = document.querySelectorAll("span.message-text-segment");
        for (const el of Array.from(elements)) {
          const start = parseInt(el.getAttribute("data-start-seq") || "0", 10);
          const end = parseInt(el.getAttribute("data-end-seq") || "0", 10);
          if (seq >= start && seq <= end) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("highlight-flash");
            setTimeout(() => el.classList.remove("highlight-flash"), 1500);
            break;
          }
        }
      }
    },
    []
  );

  const handleTimelineBatchClick = useCallback((batch: TokenBatch) => {
    const startSeq = batch.startSeq;
    const elements = document.querySelectorAll("span.message-text-segment");
    for (const el of Array.from(elements)) {
      const start = parseInt(el.getAttribute("data-start-seq") || "0", 10);
      const end = parseInt(el.getAttribute("data-end-seq") || "0", 10);
      if (startSeq >= start && startSeq <= end) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlight-flash");
        setTimeout(() => el.classList.remove("highlight-flash"), 1500);
        break;
      }
    }
  }, []);

  const isReconnecting =
    connectionState === "RECONNECTING" ||
    connectionState === "WAITING_TO_RECONNECT";

  return (
    <div className="app-layout">
      {/* Header */}
      <header className="app-header">
        <div className="app-header-title">
          <div className="logo-icon">⚡</div>
          Agent Console
        </div>
        <ConnectionIndicator />
      </header>

      {/* Reconnection banner */}
      {isReconnecting && (
        <div className="reconnect-banner" id="reconnect-banner">
          Connection lost — reconnecting automatically…
        </div>
      )}

      {/* Main content */}
      <div className="app-main">
        {/* Chat panel (center) */}
        <ChatPanel
          onSendMessage={handleSendMessage}
          onToolCardClick={handleToolCardClick}
        />

        {/* Right panel (timeline + context) */}
        <div className="right-panel">
          <div className="right-panel-tabs">
            <button
              className={`right-panel-tab ${activeTab === "timeline" ? "right-panel-tab--active" : ""}`}
              onClick={() => setActiveTab("timeline")}
              id="tab-timeline"
            >
              ⏱ Trace
            </button>
            <button
              className={`right-panel-tab ${activeTab === "context" ? "right-panel-tab--active" : ""}`}
              onClick={() => setActiveTab("context")}
              id="tab-context"
            >
              📋 Context
            </button>
          </div>

          <div className="right-panel-content">
            {activeTab === "timeline" ? (
              <TimelinePanel
                onEventClick={handleTimelineEventClick}
                onBatchClick={handleTimelineBatchClick}
              />
            ) : (
              <ContextPanel />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
