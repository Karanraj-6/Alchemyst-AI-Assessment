"use client";

import { useAgentStore } from "@/lib/store";
import type { ConnectionState } from "@/lib/types";

const STATE_CONFIG: Record<
  ConnectionState,
  { label: string; className: string }
> = {
  DISCONNECTED: { label: "Disconnected", className: "disconnected" },
  CONNECTING: { label: "Connecting…", className: "reconnecting" },
  CONNECTED: { label: "Connected", className: "connected" },
  RESUMING: { label: "Resuming…", className: "reconnecting" },
  STREAMING: { label: "Streaming", className: "streaming" },
  TOOL_CALL_PENDING: { label: "Tool call…", className: "streaming" },
  RECONNECTING: { label: "Reconnecting…", className: "reconnecting" },
  WAITING_TO_RECONNECT: { label: "Reconnecting…", className: "reconnecting" },
};

export default function ConnectionIndicator() {
  const connectionState = useAgentStore((s) => s.connectionState);
  const reconnectAttempt = useAgentStore((s) => s.reconnectAttempt);

  const config = STATE_CONFIG[connectionState];
  const showAttempt =
    reconnectAttempt > 0 &&
    (connectionState === "RECONNECTING" ||
      connectionState === "WAITING_TO_RECONNECT");

  return (
    <div
      className={`connection-indicator connection-indicator--${config.className}`}
      id="connection-indicator"
      title={`State: ${connectionState}${showAttempt ? ` (attempt ${reconnectAttempt})` : ""}`}
    >
      <div className="connection-dot" />
      <span>
        {config.label}
        {showAttempt && (
          <span style={{ opacity: 0.7 }}> ({reconnectAttempt})</span>
        )}
      </span>
    </div>
  );
}
