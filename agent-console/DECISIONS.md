# Architectural Decisions

This document outlines the design decisions and technical rationales for the Alchemyst Agent Console.

## 1. Sequence-based Ordering & Deduplication

### Data Structure Selection
- **Deduplication**: We use a `SeqDeduplicator` class wrapping a Javascript `Set<number>`. A Set offers $O(1)$ average-time complexity for insertion and lookup, which is perfect for fast deduplication checks before any processing.
- **Reordering**: We implemented a `ReorderBuffer` using a **Min-Heap (Priority Queue)** data structure. The heap stores out-of-order messages sorted by their sequence number `seq`.
  - **Why Min-Heap**: Priority queues are optimal for streaming buffers. Insertion and extraction of the minimum elements are $O(\log n)$, which easily handles token rates exceeding 30+ frames per second.
  - **Gap Handling**: The buffer keeps track of `nextExpectedSeq`. When draining, it checks the root of the heap. If `heap[0].seq === nextExpectedSeq`, it extracts it, increments `nextExpectedSeq`, and repeats. If the root is greater than `nextExpectedSeq`, a gap exists, and the drain stops, leaving subsequent items in the heap until the gap is filled.
  - **PING Adjustment**: When a `PING` is received, we respond with `PONG` immediately to avoid timeouts. The PING message is then inserted into the reorder buffer so that it drains in sequence order, advancing `nextExpectedSeq` and preventing gap-related stream freezes.

---

## 2. Preventing Layout Shift During Tool Interruptions

### CSS & Rendering Strategy
- **Segmented Message Structure**: Instead of representing the agent's message as a raw string, we represent it as a list of segments:
  ```typescript
  type ChatSegment = 
    | { kind: 'text'; content: string; startSeq: number; endSeq: number }
    | { kind: 'tool_call'; callId: string; toolName: string; args: object; result: object | null; status: 'pending' | 'complete' }
  ```
- **Sequential Stacking**: When a `TOOL_CALL` is received, the current `text` segment freezes. A new `tool_call` segment is appended. When `TOOL_RESULT` is received, the segment is updated. Subsequent tokens start a new `text` segment.
- **HTML Flow**: In the DOM, these are rendered as stacked elements (`<span>` for text, `<div>` block cards for tools). Because segments are appended sequentially, they stack vertically in the order they occurred. There are no elements being removed, rearranged, or resized, resulting in **zero layout shift**.
- **Container Styling**: Containers are styled with `word-break: break-word` and `white-space: pre-wrap` to ensure tokens wrap gracefully without reflowing the containing card structure.

---

## 3. Reconnection & State Recovery

### DOM Consumption vs. Socket Reception
- **Tracking Processed State**: The state machine keeps a strict separation between what the socket receives and what the DOM has fully processed.
- `lastProcessedSeq` is updated inside the state store only *after* the corresponding message has been fully processed by the reducer/store and pushed to the components.
- **Reconnection Protocol**:
  1. On connection close, state transitions to `RECONNECTING`.
  2. The UI displays a non-blocking banner, keeping the chat interactive.
  3. Reconnections attempt with exponential backoff: 500ms, 1s, 2s, 4s, capping at 10s.
  4. On connection open, the client sends `RESUME { last_seq: lastProcessedSeq }` as the first message before any user actions can occur.
  5. The reorder buffer is cleared to discard any stale or duplicated frames, and `nextExpectedSeq` is set to `lastProcessedSeq + 1`.
  6. Replayed events are processed through the standard deduplication and reordering pipeline, seamlessly patching the UI.

---

## 4. Identified Protocol Failure Modes & Race Conditions

We have identified two critical architectural flaws within the WebSocket protocol design that can lead to race conditions, deadlocks, or artificial compliance failures under network stress:

### 4.1 The `TOOL_ACK` Timeout Reconnection Race
- **The Design**: The server expects a `TOOL_ACK` within 2 seconds of sending a `TOOL_CALL`, waiting up to 5 seconds before logging a protocol violation and force-sending the `TOOL_RESULT` anyway.
- **The Failure Mode**:
  1. If a connection drops (or a severe latency spike occurs) immediately after the server dispatches a `TOOL_CALL` (e.g., `seq = 10`), the client cannot successfully deliver the `TOOL_ACK`.
  2. While the client is in the `RECONNECTING` loop, the server's 5-second timer continues. The server times out, logs a protocol violation, and outputs `TOOL_RESULT` (e.g., `seq = 11`) to its transaction queue.
  3. The client reconnects and transmits a `RESUME` message. 
     - If the client's highest processed sequence was `10` (`lastProcessedSeq = 10`), the server resumes replaying from `seq = 11`. The client will never send a `TOOL_ACK` for `seq = 10` because it has already advanced past it, but the server has already logged a violation for a drop it caused itself.
     - If the client's highest processed sequence was `9` (the tool call was lost on the wire), the server replays `seq = 10` followed immediately by `seq = 11`. The client processes the tool call and dispatches a `TOOL_ACK`, but it arrives *after* the server has already replayed the result, leading to an out-of-order acknowledgment violation.
- **Mitigation**: The server should suspend the tool-acknowledgement timer when a client socket disconnects, resuming only after a successful `RESUME` handshake has completed.

### 4.2 The Interleaved `PING` Sequence Gap Block
- **The Design**: `PING` messages are sent from the server interleaved in the same sequence number space (with a valid `seq` value).
- **The Failure Mode**: 
  1. In chaos mode, messages can arrive out-of-order. If a client receives a `PING` (e.g., `seq = 20`) out of order and processes it immediately to satisfy the 3-second `PONG` timeout, it sends the `PONG` response.
  2. However, if the client processes this `PING` out of order without routing it through the reorder buffer, `nextExpectedSeq` is not advanced past `20`.
  3. Subsequent packets (e.g., `seq = 21`, `seq = 22`) will arrive and be inserted into the min-heap buffer. Since the client is still waiting for `seq = 20` to satisfy the heap drain condition (`heap[0].seq === nextExpectedSeq`), the message loop will freeze permanently.
- **Mitigation**: Route `PING` sequence numbers through the reorder buffer heap, allowing them to advance `nextExpectedSeq` sequentially, while still triggering the socket `PONG` transmission immediately upon raw packet receipt.

---

## 5. Scalability Choices

### Scaling to 50 Concurrent Agent Streams (Operations Dashboard)
1. **Zustand Surgical Subscriptions**: Zustand allows component selectors (e.g. `useAgentStore(s => s.connectionState)`). This ensures components only re-render if their subscribed slice changes.
2. **Throttling/Batching Updates**: Instead of dispatching every token to React state immediately (causing up to 1500 renders/sec across 50 streams), we would batch updates. We can queue tokens in a raw array and drain them into the React state store at a throttled interval (e.g., every 100ms) or on `requestAnimationFrame`.
3. **Web Worker Offloading**: Run WebSocket connections and sequence reordering in a Web Worker thread. The main thread would only receive ready-to-render message chunks.
4. **Virtualized Timeline**: Switch the timeline to a virtualized list (like `react-window` or `react-virtualized`) so that only the rows visible on screen are mounted in the DOM.

### Scaling to 100x Longer Responses (Document Generation)
1. **Chunked State Management**: Storing millions of characters in a single string in React state causes major performance issues due to VDOM comparisons. We would store long texts as arrays of paragraph chunks and render them virtualized.
2. **Incremental Markdown Parsing**: Use a streaming markdown parser that compiles chunks incrementally rather than parsing the entire document on every new token.
3. **IndexedDB Offloading**: Cache older parts of the document in IndexedDB and load them only when the user scrolls, keeping the in-memory state footprint minimal.
4. **Timeline Trimming**: Automatically trim or archive older events (e.g. keeping only the last 100 events in memory) to prevent memory leaks from massive timelines.
