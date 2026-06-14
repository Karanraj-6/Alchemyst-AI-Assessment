// ─────────────────────────────────────────────────────────────
// Seq Deduplication
//
// In chaos mode, the server may send the same seq twice.
// This module tracks which seqs have been fully processed
// (rendered to the DOM) and rejects duplicates.
// ─────────────────────────────────────────────────────────────

export class SeqDeduplicator {
  private processedSeqs: Set<number> = new Set();
  private _lastProcessedSeq: number = 0;

  /**
   * The highest seq that has been fully processed.
   * Used for RESUME messages on reconnection.
   */
  get lastProcessedSeq(): number {
    return this._lastProcessedSeq;
  }

  /**
   * Check if a seq has already been processed.
   */
  isDuplicate(seq: number): boolean {
    return this.processedSeqs.has(seq);
  }

  /**
   * Mark a seq as fully processed (rendered to DOM).
   * Updates lastProcessedSeq if this is the new maximum.
   */
  markProcessed(seq: number): void {
    this.processedSeqs.add(seq);
    if (seq > this._lastProcessedSeq) {
      this._lastProcessedSeq = seq;
    }
  }

  /**
   * Get the count of processed seqs.
   */
  get processedCount(): number {
    return this.processedSeqs.size;
  }

  /**
   * Reset state (e.g., on session reset).
   */
  reset(): void {
    this.processedSeqs.clear();
    this._lastProcessedSeq = 0;
  }
}
