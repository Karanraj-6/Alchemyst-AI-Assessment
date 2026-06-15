"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAgentStore } from "@/lib/store";
import type { TimelineEvent, TokenBatch, ServerMessage } from "@/lib/types";

const EVENT_TYPES = [
  "TOKEN",
  "TOOL_CALL",
  "TOOL_RESULT",
  "CONTEXT_SNAPSHOT",
  "PING",
  "STREAM_END",
  "ERROR",
] as const;

function getBadgeClass(type: string): string {
  if (type === "CONTEXT_SNAPSHOT") return "timeline-badge--CONTEXT";
  return `timeline-badge--${type}`;
}

function getBadgeLabel(type: string): string {
  switch (type) {
    case "CONTEXT_SNAPSHOT":
      return "CONTEXT";
    case "STREAM_END":
      return "END";
    default:
      return type;
  }
}

function getEventSummary(event: TimelineEvent): string {
  const msg = event.data;
  switch (msg.type) {
    case "TOKEN":
      return msg.text;
    case "TOOL_CALL":
      return `${msg.tool_name}(${Object.keys(msg.args).join(", ")})`;
    case "TOOL_RESULT":
      return `Result for ${msg.call_id}`;
    case "CONTEXT_SNAPSHOT":
      return `${msg.context_id} — ${Object.keys(msg.data).length} keys`;
    case "PING":
      return msg.challenge ? `challenge: ${msg.challenge}` : "⚠ empty challenge";
    case "STREAM_END":
      return `Stream ${msg.stream_id} ended`;
    case "ERROR":
      return `${msg.code}: ${msg.message}`;
    default:
      return "";
  }
}

function TokenBatchRow({
  batch,
  isSelected,
  onClick,
}: {
  batch: TokenBatch;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`timeline-row ${isSelected ? "timeline-row--selected" : ""}`}
      onClick={onClick}
      id={`timeline-batch-${batch.id}`}
    >
      <span className={`timeline-badge timeline-badge--TOKEN`}>TOKEN</span>
      <div className="timeline-detail">
        <div
          className="timeline-detail-text"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          style={{ cursor: "pointer" }}
        >
          Streamed {batch.tokenCount} tokens ({(batch.duration / 1000).toFixed(1)}s)
          {expanded ? " ▾" : " ▸"}
        </div>
        {expanded && (
          <div className="timeline-expand">{batch.totalText}</div>
        )}
      </div>
      <span className="timeline-seq">
        #{batch.startSeq}–{batch.endSeq}
      </span>
    </div>
  );
}

function EventRow({
  event,
  isSelected,
  isLinked,
  onClick,
}: {
  event: TimelineEvent;
  isSelected: boolean;
  isLinked: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`timeline-row ${isSelected ? "timeline-row--selected" : ""} ${isLinked ? "timeline-row--linked" : ""}`}
      onClick={onClick}
      id={`timeline-event-${event.id}`}
    >
      <span className={`timeline-badge ${getBadgeClass(event.type)}`}>
        {getBadgeLabel(event.type)}
      </span>
      <div className="timeline-detail">
        <div className="timeline-detail-text">{getEventSummary(event)}</div>
      </div>
      <span className="timeline-seq">#{event.seq}</span>
    </div>
  );
}

export default function TimelinePanel({
  onEventClick,
  onBatchClick,
}: {
  onEventClick?: (eventId: string, event: TimelineEvent) => void;
  onBatchClick?: (batch: TokenBatch) => void;
}) {
  const events = useAgentStore((s) => s.events);
  const tokenBatches = useAgentStore((s) => s.tokenBatches);
  const selectedEventId = useAgentStore((s) => s.selectedEventId);
  const setSelectedEventId = useAgentStore((s) => s.setSelectedEventId);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events.length, tokenBatches.length]);

  // Track whether user has scrolled up
  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const toggleFilter = useCallback((type: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Build display items: merge token batches with non-TOKEN events
  const displayItems = useMemo(() => {
    const items: Array<
      | { kind: "batch"; batch: TokenBatch }
      | { kind: "event"; event: TimelineEvent }
    > = [];

    // Collect non-TOKEN events
    const nonTokenEvents = events.filter((e) => e.type !== "TOKEN");

    // Merge batches and non-TOKEN events by timestamp
    let batchIdx = 0;
    let eventIdx = 0;

    while (batchIdx < tokenBatches.length || eventIdx < nonTokenEvents.length) {
      const batch = tokenBatches[batchIdx];
      const event = nonTokenEvents[eventIdx];

      if (batch && event) {
        if (batch.startTime <= event.timestamp) {
          items.push({ kind: "batch", batch });
          batchIdx++;
        } else {
          items.push({ kind: "event", event });
          eventIdx++;
        }
      } else if (batch) {
        items.push({ kind: "batch", batch });
        batchIdx++;
      } else if (event) {
        items.push({ kind: "event", event });
        eventIdx++;
      }
    }

    return items;
  }, [events, tokenBatches]);

  // Apply filters
  const filteredItems = useMemo(() => {
    let items = displayItems;

    // Type filter
    if (activeFilters.size > 0) {
      items = items.filter((item) => {
        if (item.kind === "batch") return activeFilters.has("TOKEN");
        return activeFilters.has(item.event.type);
      });
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      items = items.filter((item) => {
        if (item.kind === "batch") {
          return (
            item.batch.totalText.toLowerCase().includes(query) ||
            "token".includes(query)
          );
        }
        const type = item.event.type.toLowerCase();
        const badgeLabel = getBadgeLabel(item.event.type).toLowerCase();
        return (
          getEventSummary(item.event).toLowerCase().includes(query) ||
          type.includes(query) ||
          badgeLabel.includes(query)
        );
      });
    }

    return items;
  }, [displayItems, activeFilters, searchQuery]);

  const handleEventClick = useCallback(
    (eventId: string, event: TimelineEvent) => {
      setSelectedEventId(eventId);
      onEventClick?.(eventId, event);
    },
    [setSelectedEventId, onEventClick]
  );

  const handleBatchClick = useCallback(
    (batch: TokenBatch) => {
      setSelectedEventId(batch.id);
      onBatchClick?.(batch);
    },
    [setSelectedEventId, onBatchClick]
  );

  // Scroll selected event or batch into view
  useEffect(() => {
    if (selectedEventId) {
      const el =
        document.getElementById(`timeline-event-${selectedEventId}`) ||
        document.getElementById(`timeline-batch-${selectedEventId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedEventId]);

  return (
    <div className="timeline-panel" id="timeline-panel">
      {/* Filter bar */}
      <div className="timeline-filter-bar">
        {EVENT_TYPES.map((type) => (
          <button
            key={type}
            className={`timeline-filter-chip ${activeFilters.has(type) ? "timeline-filter-chip--active" : ""}`}
            onClick={() => toggleFilter(type)}
          >
            {getBadgeLabel(type)}
          </button>
        ))}
        <input
          className="timeline-search"
          placeholder="Search events…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          id="timeline-search"
        />
      </div>

      {/* Event list */}
      <div className="timeline-list" ref={listRef} onScroll={handleScroll}>
        {filteredItems.length === 0 && (
          <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            {events.length === 0
              ? "No events yet. Send a message to start."
              : "No events match the current filters."}
          </div>
        )}

        {filteredItems.map((item) => {
          if (item.kind === "batch") {
            return (
              <TokenBatchRow
                key={item.batch.id}
                batch={item.batch}
                isSelected={selectedEventId === item.batch.id}
                onClick={() => handleBatchClick(item.batch)}
              />
            );
          }

          const event = item.event;
          const isLinked = event.type === "TOOL_RESULT" && !!event.linkedEventId;

          return (
            <EventRow
              key={event.id}
              event={event}
              isSelected={selectedEventId === event.id}
              isLinked={isLinked}
              onClick={() => handleEventClick(event.id, event)}
            />
          );
        })}
      </div>
    </div>
  );
}
