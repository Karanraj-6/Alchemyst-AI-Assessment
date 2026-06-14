"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useAgentStore } from "@/lib/store";
import type { ChatSegment } from "@/lib/types";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled: boolean;
}

function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Auto-resize
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, []);

  return (
    <div className="chat-input-area">
      <div className="chat-input-wrapper">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Send a message... (try: hello, report, analyze, find, schema, long)"
          rows={1}
          disabled={disabled}
          id="chat-input"
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          title="Send message"
          id="send-button"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

export default function ChatPanel({
  onSendMessage,
  onToolCardClick,
}: {
  onSendMessage: (content: string) => void;
  onToolCardClick?: (eventId: string) => void;
}) {
  const userMessages = useAgentStore((s) => s.userMessages);
  const agentMessages = useAgentStore((s) => s.agentMessages);
  const activeStreamId = useAgentStore((s) => s.activeStreamId);
  const connectionState = useAgentStore((s) => s.connectionState);
  const events = useAgentStore((s) => s.events);
  const setSelectedEventId = useAgentStore((s) => s.setSelectedEventId);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [userMessages.length, agentMessages, activeStreamId]);

  const isDisabled =
    connectionState === "DISCONNECTED" || connectionState === "CONNECTING";

  // Interleave messages by timestamp
  const allMessages: Array<
    { type: "user"; data: typeof userMessages[number] } |
    { type: "agent"; data: typeof agentMessages[number] }
  > = [];

  // Simple interleave: user messages trigger agent responses
  let agentIdx = 0;
  for (const userMsg of userMessages) {
    allMessages.push({ type: "user", data: userMsg });
    if (agentIdx < agentMessages.length) {
      allMessages.push({ type: "agent", data: agentMessages[agentIdx] });
      agentIdx++;
    }
  }
  // Any remaining agent messages
  while (agentIdx < agentMessages.length) {
    allMessages.push({ type: "agent", data: agentMessages[agentIdx] });
    agentIdx++;
  }

  const handleToolCardClick = useCallback(
    (callId: string) => {
      // Find the timeline event for this tool call
      const event = events.find(
        (e) =>
          e.data.type === "TOOL_CALL" &&
          (e.data as { call_id: string }).call_id === callId
      );
      if (event) {
        setSelectedEventId(event.id);
        onToolCardClick?.(event.id);
      }
    },
    [events, setSelectedEventId, onToolCardClick]
  );

  const handleTextSegmentClick = useCallback(
    (segment: ChatSegment) => {
      if (segment.kind !== "text") return;
      const tokenBatches = useAgentStore.getState().tokenBatches;
      const matchingBatch = tokenBatches.find(
        (b) => segment.startSeq >= b.startSeq && segment.startSeq <= b.endSeq
      );
      if (matchingBatch) {
        setSelectedEventId(matchingBatch.id);
        onToolCardClick?.(matchingBatch.id);
        return;
      }
    },
    [setSelectedEventId, onToolCardClick]
  );

  return (
    <div className="chat-panel" id="chat-panel">
      <div className="chat-messages" id="chat-messages">
        {allMessages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">⚡</div>
            <div className="chat-empty-text">Agent Console</div>
            <div className="chat-empty-hint">
              Send a message to the AI agent. Try keywords like &quot;hello&quot;,
              &quot;report&quot;, &quot;analyze&quot;, &quot;find&quot;, &quot;schema&quot;, or
              &quot;long&quot; to trigger different response scripts.
            </div>
          </div>
        )}

        {allMessages.map((msg) => {
          if (msg.type === "user") {
            return (
              <div key={msg.data.id} className="message message--user" id={`msg-${msg.data.id}`}>
                <div className="message-label">You</div>
                <div className="message-content">{msg.data.content}</div>
              </div>
            );
          }

          const agentMsg = msg.data;
          const isStreaming = activeStreamId === agentMsg.streamId && !agentMsg.isComplete;

          return (
            <div key={agentMsg.id} className="message message--agent" id={`msg-${agentMsg.id}`}>
              <div className="message-label">Agent</div>
              <div className="message-content">
                {agentMsg.segments.map((segment, idx) => {
                  if (segment.kind === "text") {
                    return (
                      <span
                        key={`text-${idx}`}
                        className="message-text-segment"
                        data-start-seq={segment.startSeq}
                        data-end-seq={segment.endSeq}
                        onClick={() => handleTextSegmentClick(segment)}
                      >
                        {segment.content}
                      </span>
                    );
                  }

                  if (segment.kind === "tool_call") {
                    return (
                      <div
                        key={`tool-${segment.callId}`}
                        className={`tool-card tool-card--${segment.status}`}
                        data-call-id={segment.callId}
                        id={`tool-${segment.callId}`}
                        onClick={() => handleToolCardClick(segment.callId)}
                      >
                        <div className="tool-card-header">
                          <div className="tool-card-icon">
                            {segment.status === "pending" ? "⏳" : "✓"}
                          </div>
                          <div className="tool-card-name">{segment.toolName}</div>
                          <div className="tool-card-status">
                            {segment.status === "pending" ? "Running…" : "Complete"}
                          </div>
                        </div>
                        <div className="tool-card-body">
                          <div className="tool-card-section-label">Arguments</div>
                          <div className="tool-card-json">
                            {JSON.stringify(segment.args, null, 2)}
                          </div>
                          {segment.status === "pending" && (
                            <div className="tool-card-spinner">
                              <div className="spinner" />
                              Waiting for result…
                            </div>
                          )}
                          {segment.result && (
                            <div className="tool-card-result">
                              <div className="tool-card-section-label">Result</div>
                              <div className="tool-card-json">
                                {JSON.stringify(segment.result, null, 2)}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}
                {isStreaming && <span className="streaming-cursor" />}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput onSend={onSendMessage} disabled={isDisabled} />
    </div>
  );
}
