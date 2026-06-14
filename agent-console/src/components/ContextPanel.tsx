"use client";

import { useState, useCallback, useMemo } from "react";
import { useAgentStore } from "@/lib/store";
import { computeDiff } from "@/lib/json-diff";
import type { DiffResult, DiffChangeKind } from "@/lib/types";

// ── JSON Tree Node ──────────────────────────────────────────

interface TreeNodeProps {
  keyName: string;
  value: unknown;
  depth: number;
  diffKind?: DiffChangeKind;
  diffMap?: Map<string, DiffChangeKind>;
  path?: string[];
  defaultExpanded?: boolean;
}

function getValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function getValuePreview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value.length > 60 ? value.slice(0, 60) + "…" : value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") return `{${Object.keys(value as object).length} keys}`;
  return String(value);
}

function TreeNode({
  keyName,
  value,
  depth,
  diffKind,
  diffMap,
  path = [],
  defaultExpanded = false,
}: TreeNodeProps) {
  // Only auto-expand first 2 levels for performance with large contexts
  const [expanded, setExpanded] = useState(defaultExpanded && depth < 2);
  const isExpandable =
    value !== null && typeof value === "object" && (Array.isArray(value) ? value.length > 0 : Object.keys(value as object).length > 0);
  const valueType = getValueType(value);

  // Determine diff kind for this node
  const currentPath = [...path, keyName];
  const pathKey = currentPath.join(".");
  const nodeDiffKind = diffKind || diffMap?.get(pathKey);

  const diffClass = nodeDiffKind ? `tree-node--${nodeDiffKind}` : "";

  return (
    <div className={`tree-node ${diffClass}`}>
      <div
        className="tree-node-row"
        onClick={() => isExpandable && setExpanded(!expanded)}
        style={{ paddingLeft: depth * 16 }}
      >
        <span className="tree-toggle">
          {isExpandable ? (expanded ? "▾" : "▸") : " "}
        </span>
        <span className="tree-key">{keyName}</span>
        <span className="tree-separator">: </span>
        {!isExpandable && (
          <span className={`tree-value tree-value--${valueType}`}>
            {getValuePreview(value)}
          </span>
        )}
        {isExpandable && !expanded && (
          <span className="tree-value">{getValuePreview(value)}</span>
        )}
        {isExpandable && (
          <span className="tree-type-badge">
            {Array.isArray(value)
              ? `[${(value as unknown[]).length}]`
              : `{${Object.keys(value as object).length}}`}
          </span>
        )}
      </div>
      {isExpandable && expanded && (
        <div className="tree-children">
          {Array.isArray(value)
            ? (value as unknown[]).map((item, idx) => (
                <TreeNode
                  key={idx}
                  keyName={String(idx)}
                  value={item}
                  depth={depth + 1}
                  diffMap={diffMap}
                  path={currentPath}
                  defaultExpanded={defaultExpanded}
                />
              ))
            : Object.entries(value as Record<string, unknown>).map(([k, v]) => (
                <TreeNode
                  key={k}
                  keyName={k}
                  value={v}
                  depth={depth + 1}
                  diffMap={diffMap}
                  path={currentPath}
                  defaultExpanded={defaultExpanded}
                />
              ))}
        </div>
      )}
    </div>
  );
}

// ── Context Panel ───────────────────────────────────────────

export default function ContextPanel() {
  const contextSnapshots = useAgentStore((s) => s.contextSnapshots);
  const activeContextId = useAgentStore((s) => s.activeContextId);
  const scrubberIndex = useAgentStore((s) => s.scrubberIndex);
  const setActiveContextId = useAgentStore((s) => s.setActiveContextId);
  const setScrubberIndex = useAgentStore((s) => s.setScrubberIndex);

  // Get all context IDs
  const contextIds = useMemo(
    () => Array.from(contextSnapshots.keys()),
    [contextSnapshots]
  );

  // Get snapshots for the active context
  const activeSnapshots = useMemo(
    () => (activeContextId ? contextSnapshots.get(activeContextId) || [] : []),
    [contextSnapshots, activeContextId]
  );

  // Current snapshot index (clamped)
  const currentIndex = Math.min(
    Math.max(0, scrubberIndex),
    activeSnapshots.length - 1
  );
  const currentSnapshot = activeSnapshots[currentIndex];

  // Compute diff with previous snapshot
  const diff: DiffResult | null = useMemo(() => {
    if (currentIndex <= 0 || !activeSnapshots[currentIndex - 1] || !currentSnapshot) {
      return null;
    }
    return computeDiff(
      activeSnapshots[currentIndex - 1].data,
      currentSnapshot.data
    );
  }, [activeSnapshots, currentIndex, currentSnapshot]);

  // Build diff map for tree highlighting
  const diffMap = useMemo(() => {
    if (!diff) return new Map<string, DiffChangeKind>();
    const map = new Map<string, DiffChangeKind>();
    for (const entry of diff.entries) {
      map.set(entry.path.join("."), entry.kind);
    }
    return map;
  }, [diff]);

  const handleScrubberChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setScrubberIndex(parseInt(e.target.value, 10));
    },
    [setScrubberIndex]
  );

  if (contextIds.length === 0) {
    return (
      <div className="context-panel">
        <div className="context-empty">
          No context snapshots received yet.
        </div>
      </div>
    );
  }

  return (
    <div className="context-panel" id="context-panel">
      {/* Context ID tabs */}
      {contextIds.length > 1 && (
        <div style={{ display: "flex", gap: "4px", padding: "8px", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap" }}>
          {contextIds.map((id) => (
            <button
              key={id}
              className={`timeline-filter-chip ${activeContextId === id ? "timeline-filter-chip--active" : ""}`}
              onClick={() => {
                setActiveContextId(id);
                const snaps = contextSnapshots.get(id) || [];
                setScrubberIndex(snaps.length - 1);
              }}
            >
              {id}
            </button>
          ))}
        </div>
      )}

      {/* Header with diff summary */}
      <div className="context-header">
        <span className="context-id-badge">{activeContextId}</span>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
          Snapshot {currentIndex + 1} / {activeSnapshots.length}
        </span>
        {diff && (
          <span className="context-diff-summary">
            {diff.addedCount > 0 && (
              <span className="context-diff-added">+{diff.addedCount} </span>
            )}
            {diff.removedCount > 0 && (
              <span className="context-diff-removed">−{diff.removedCount} </span>
            )}
            {diff.changedCount > 0 && (
              <span className="context-diff-changed">~{diff.changedCount}</span>
            )}
          </span>
        )}
      </div>

      {/* History scrubber */}
      {activeSnapshots.length > 1 && (
        <div className="context-scrubber">
          <span className="context-scrubber-label">History:</span>
          <input
            type="range"
            min={0}
            max={activeSnapshots.length - 1}
            value={currentIndex}
            onChange={handleScrubberChange}
            id="context-scrubber"
          />
          <span className="context-scrubber-label">
            #{currentSnapshot?.seq}
          </span>
        </div>
      )}

      {/* JSON tree view */}
      <div className="context-tree" id="context-tree">
        {currentSnapshot &&
          Object.entries(currentSnapshot.data).map(([key, value]) => (
            <TreeNode
              key={key}
              keyName={key}
              value={value}
              depth={0}
              diffMap={diffMap}
              path={[]}
              defaultExpanded={true}
            />
          ))}
      </div>
    </div>
  );
}
