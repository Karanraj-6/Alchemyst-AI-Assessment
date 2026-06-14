// ─────────────────────────────────────────────────────────────
// Reorder Buffer — Min-Heap for seq-based message ordering
//
// In chaos mode, messages arrive with out-of-order seq values.
// This buffer accumulates messages and yields them in correct
// seq order, stopping at the first gap.
// ─────────────────────────────────────────────────────────────

import type { ServerMessage } from "./types";

export class ReorderBuffer {
  /** Min-heap of messages, ordered by seq */
  private heap: ServerMessage[] = [];

  /** The next expected seq number */
  private nextExpectedSeq: number;

  constructor(startSeq: number = 1) {
    this.nextExpectedSeq = startSeq;
  }

  get expectedSeq(): number {
    return this.nextExpectedSeq;
  }

  get size(): number {
    return this.heap.length;
  }

  /**
   * Set the next expected seq (used after RESUME)
   */
  setExpectedSeq(seq: number): void {
    this.nextExpectedSeq = seq;
  }

  /**
   * Insert a message into the buffer.
   */
  insert(message: ServerMessage): void {
    this.heap.push(message);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Drain messages in seq order, starting from nextExpectedSeq.
   * Stops at the first gap (missing seq). Returns drained messages.
   */
  drain(): ServerMessage[] {
    const result: ServerMessage[] = [];

    while (this.heap.length > 0) {
      const top = this.heap[0];
      if (top.seq === this.nextExpectedSeq) {
        // Pop the min
        this.extractMin();
        result.push(top);
        this.nextExpectedSeq++;
      } else if (top.seq < this.nextExpectedSeq) {
        // Already processed or duplicate — discard
        this.extractMin();
      } else {
        // Gap — stop draining, wait for missing seq
        break;
      }
    }

    return result;
  }

  /**
   * Force-drain all buffered messages in seq order, ignoring gaps.
   * Used for cleanup or when we know no more messages are coming.
   */
  drainAll(): ServerMessage[] {
    const result: ServerMessage[] = [];
    while (this.heap.length > 0) {
      const msg = this.extractMin();
      if (msg) {
        result.push(msg);
      }
    }
    return result;
  }

  /**
   * Clear the buffer entirely.
   */
  clear(): void {
    this.heap = [];
  }

  // ── Min-Heap Operations ─────────────────────────────────

  private extractMin(): ServerMessage | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return min;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIdx = Math.floor((index - 1) / 2);
      if (this.heap[parentIdx].seq <= this.heap[index].seq) break;
      [this.heap[parentIdx], this.heap[index]] = [this.heap[index], this.heap[parentIdx]];
      index = parentIdx;
    }
  }

  private sinkDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < length && this.heap[left].seq < this.heap[smallest].seq) {
        smallest = left;
      }
      if (right < length && this.heap[right].seq < this.heap[smallest].seq) {
        smallest = right;
      }
      if (smallest === index) break;

      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}
