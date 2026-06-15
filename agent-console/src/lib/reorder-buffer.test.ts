import assert from "node:assert";
import { test } from "node:test";
import { ReorderBuffer } from "./reorder-buffer";
import type { ServerMessage } from "./types";

// Helper to create a dummy ServerMessage with a specific seq
function makeMsg(seq: number): ServerMessage {
  return {
    type: "TOKEN",
    seq,
    text: `token-${seq}`,
    stream_id: "test-stream",
  };
}

test("ReorderBuffer - Empty Buffer", () => {
  const buffer = new ReorderBuffer(1);
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 1);
  
  const drained = buffer.drain();
  assert.strictEqual(drained.length, 0);
});

test("ReorderBuffer - Single Element", () => {
  const buffer = new ReorderBuffer(1);
  buffer.insert(makeMsg(1));
  assert.strictEqual(buffer.size, 1);
  
  const drained = buffer.drain();
  assert.strictEqual(drained.length, 1);
  assert.strictEqual(drained[0].seq, 1);
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 2);
});

test("ReorderBuffer - Out-of-order Sequence", () => {
  const buffer = new ReorderBuffer(1);
  
  // Insert out of order: 3, 1, 4, 2
  buffer.insert(makeMsg(3));
  buffer.insert(makeMsg(1));
  buffer.insert(makeMsg(4));
  buffer.insert(makeMsg(2));
  
  assert.strictEqual(buffer.size, 4);
  
  const drained = buffer.drain();
  assert.strictEqual(drained.length, 4);
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [1, 2, 3, 4]
  );
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 5);
});

test("ReorderBuffer - Duplicates", () => {
  const buffer = new ReorderBuffer(1);
  
  // Insert 2, 1, 2, 3
  buffer.insert(makeMsg(2));
  buffer.insert(makeMsg(1));
  buffer.insert(makeMsg(2)); // duplicate
  buffer.insert(makeMsg(3));
  
  assert.strictEqual(buffer.size, 4);
  
  const drained = buffer.drain();
  // Expecting sequence to yield 1, 2, 3 and discard the duplicate 2.
  assert.strictEqual(drained.length, 3);
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [1, 2, 3]
  );
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 4);
});

test("ReorderBuffer - Gaps and Resolution", () => {
  const buffer = new ReorderBuffer(1);
  
  // Insert 1, 2, 4
  buffer.insert(makeMsg(1));
  buffer.insert(makeMsg(2));
  buffer.insert(makeMsg(4)); // Gap at 3
  
  let drained = buffer.drain();
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [1, 2]
  );
  // 4 should remain in heap
  assert.strictEqual(buffer.size, 1);
  assert.strictEqual(buffer.expectedSeq, 3);
  
  // Now fill the gap with 3
  buffer.insert(makeMsg(3));
  assert.strictEqual(buffer.size, 2); // heap has 3 and 4
  
  drained = buffer.drain();
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [3, 4]
  );
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 5);
});

test("ReorderBuffer - Fully Reversed Sequence", () => {
  const buffer = new ReorderBuffer(1);
  
  // Insert 5, 4, 3, 2, 1
  buffer.insert(makeMsg(5));
  buffer.insert(makeMsg(4));
  buffer.insert(makeMsg(3));
  buffer.insert(makeMsg(2));
  buffer.insert(makeMsg(1));
  
  assert.strictEqual(buffer.size, 5);
  
  const drained = buffer.drain();
  assert.strictEqual(drained.length, 5);
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [1, 2, 3, 4, 5]
  );
  assert.strictEqual(buffer.size, 0);
  assert.strictEqual(buffer.expectedSeq, 6);
});

test("ReorderBuffer - Drain All (Force Clean)", () => {
  const buffer = new ReorderBuffer(1);
  
  buffer.insert(makeMsg(5));
  buffer.insert(makeMsg(2));
  buffer.insert(makeMsg(8));
  
  // Even with gaps, drainAll should yield sorted elements [2, 5, 8]
  const drained = buffer.drainAll();
  assert.deepStrictEqual(
    drained.map((m) => m.seq),
    [2, 5, 8]
  );
  assert.strictEqual(buffer.size, 0);
});
