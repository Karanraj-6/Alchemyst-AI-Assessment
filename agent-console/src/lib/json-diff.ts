// ─────────────────────────────────────────────────────────────
// Deep JSON Diff
//
// Computes the structural difference between two arbitrary
// nested JSON objects. Used by the Context Inspector to show
// what changed between consecutive CONTEXT_SNAPSHOT events.
// ─────────────────────────────────────────────────────────────

import type { DiffEntry, DiffResult } from "./types";

/**
 * Compute the diff between two JSON values.
 * Returns a flat list of diff entries with path, kind, and values.
 */
export function computeDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): DiffResult {
  const entries: DiffEntry[] = [];
  diffRecursive(oldObj, newObj, [], entries);

  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;

  for (const entry of entries) {
    switch (entry.kind) {
      case "added":
        addedCount++;
        break;
      case "removed":
        removedCount++;
        break;
      case "changed":
        changedCount++;
        break;
    }
  }

  return { entries, addedCount, removedCount, changedCount };
}

function diffRecursive(
  oldVal: unknown,
  newVal: unknown,
  path: string[],
  entries: DiffEntry[]
): void {
  // Both null/undefined
  if (oldVal === newVal) return;

  // Type mismatch or primitive change
  if (typeof oldVal !== typeof newVal || oldVal === null || newVal === null) {
    if (oldVal === undefined || oldVal === null) {
      entries.push({ path: [...path], kind: "added", newValue: newVal });
    } else if (newVal === undefined || newVal === null) {
      entries.push({ path: [...path], kind: "removed", oldValue: oldVal });
    } else {
      entries.push({ path: [...path], kind: "changed", oldValue: oldVal, newValue: newVal });
    }
    return;
  }

  // Arrays
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const maxLen = Math.max(oldVal.length, newVal.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = [...path, String(i)];
      if (i >= oldVal.length) {
        entries.push({ path: childPath, kind: "added", newValue: newVal[i] });
      } else if (i >= newVal.length) {
        entries.push({ path: childPath, kind: "removed", oldValue: oldVal[i] });
      } else {
        diffRecursive(oldVal[i], newVal[i], childPath, entries);
      }
    }
    return;
  }

  // One is array, other is not
  if (Array.isArray(oldVal) !== Array.isArray(newVal)) {
    entries.push({ path: [...path], kind: "changed", oldValue: oldVal, newValue: newVal });
    return;
  }

  // Objects
  if (typeof oldVal === "object" && typeof newVal === "object") {
    const oldObj = oldVal as Record<string, unknown>;
    const newObj = newVal as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
      const childPath = [...path, key];
      if (!(key in oldObj)) {
        entries.push({ path: childPath, kind: "added", newValue: newObj[key] });
      } else if (!(key in newObj)) {
        entries.push({ path: childPath, kind: "removed", oldValue: oldObj[key] });
      } else {
        diffRecursive(oldObj[key], newObj[key], childPath, entries);
      }
    }
    return;
  }

  // Primitive comparison (string, number, boolean)
  if (oldVal !== newVal) {
    entries.push({ path: [...path], kind: "changed", oldValue: oldVal, newValue: newVal });
  }
}
