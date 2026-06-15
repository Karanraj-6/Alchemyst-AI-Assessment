# Agent Console — Technical Specification & Guide

A high-fidelity, real-time AI Agent Console built with Next.js 16 (App Router), Zustand, and TypeScript. It implements a resilient WebSocket manager that survives drops, latency spikes, and duplicates in chaos mode while maintaining pixel-perfect sync between the chat thread, event traces, and context visualizations.

---

## 1. Architectural Design

The console divides responsibility between raw WebSocket/protocol logic and the reactive UI render loop.

```mermaid
graph TD
    %% Nodes
    A[WebSocket Server] <-->|Raw JSON Protocol| B[WebSocketManager]
    B -->|1. deduplicate| C[SeqDeduplicator]
    B -->|2. handle PING| D[PONG Emitter]
    B -->|3. insert| E[ReorderBuffer Heap]
    E -->|4. drain in order| F[FSM Controller]
    F -->|5. dispatch action| G[Zustand Store]
    G -->|React Selector subscription| H[UI Components]
    
    %% Components Subgraph
    subgraph UI Panels
        H --> H1[ChatPanel - Task 1]
        H --> H2[TimelinePanel - Task 2]
        H --> H3[ContextPanel - Task 3]
        H --> H4[ConnectionIndicator]
    end

    %% Styles
    style A fill:#1a1b26,stroke:#ff6b6b,stroke-width:2px,color:#fff
    style B fill:#12131a,stroke:#6c63ff,stroke-width:2px,color:#fff
    style G fill:#12131a,stroke:#00d4aa,stroke-width:2px,color:#fff
```

### Key Components:
- **WebSocketManager** (`lib/websocket-manager.ts`): Houses connection setup, keepalive timers, send buffers, and raw frame receivers. Direct logic only—completely detached from the React render loop.
- **ReorderBuffer** (`lib/reorder-buffer.ts`): Stores out-of-order frames in a Min-Heap.
- **SeqDeduplicator** (`lib/dedup.ts`): Discards duplicate frames using a stateful sequence-number set.
- **Zustand Store** (`lib/store.ts`): Manages application state. Surgical subscriptions ensure only modified slices trigger re-renders.

---

## 2. WebSocket Connection State Machine

The socket connection transitions through the following FSM states:

```mermaid
stateDiagram-v2
    [*] --> DISCONNECTED
    DISCONNECTED --> CONNECTING : connect()
    CONNECTING --> CONNECTED : onOpen (first session)
    CONNECTING --> RESUMING : onOpen (existing session)
    CONNECTING --> WAITING_TO_RECONNECT : onerror / onclose
    
    CONNECTED --> STREAMING : TOKEN received
    STREAMING --> TOOL_CALL_PENDING : TOOL_CALL received
    TOOL_CALL_PENDING --> STREAMING : TOOL_RESULT received
    STREAMING --> CONNECTED : STREAM_END received
    
    STREAMING --> RECONNECTING : connection drop
    TOOL_CALL_PENDING --> RECONNECTING : connection drop
    CONNECTED --> RECONNECTING : connection drop
    
    RECONNECTING --> WAITING_TO_RECONNECT : calculate backoff
    WAITING_TO_RECONNECT --> CONNECTING : timer expires
    RESUMING --> STREAMING : replay yields active stream
    RESUMING --> CONNECTED : replay finishes idle
```

---

## 3. Sequence-Based Message Pipeline

When the client receives a message via the WebSocket, it passes through a 5-step pipeline:

```mermaid
flowchart TD
    Raw[1. Raw WebSocket Frame] --> Parse{Parse JSON?}
    Parse -->|No| Drop[Log Error & Discard]
    Parse -->|Yes| CheckFields{Has 'type' & 'seq'?}
    CheckFields -->|No| Drop
    CheckFields -->|Yes| Dedup{Is seq in Deduplicator Set?}
    Dedup -->|Yes| DiscardDuplicate[Discard Frame]
    Dedup -->|No| CheckPing{Is type == 'PING'?}
    
    CheckPing -->|Yes| FastPong[Send PONG echo immediately]
    FastPong --> InsertHeap
    
    CheckPing -->|No| InsertHeap[2. Insert into Min-Heap ReorderBuffer]
    InsertHeap --> HeapSort[Heapify by seq]
    HeapSort --> Drain{"heap[0].seq == nextExpectedSeq?"}
    
    Drain -->|No| Block[Stop - wait for gap filling]
    Drain -->|Yes| Extract["3. Extract min element & nextExpectedSeq++"]
    Extract --> DedupDrained{Is seq in Deduplicator Set?}
    DedupDrained -->|Yes| DiscardHeapDup[Discard duplicate]
    DedupDrained -->|No| MarkProcessed["4. Mark processed in Deduplicator & Store"]
    MarkProcessed --> FSM[Update FSM State]
    FSM --> StoreDispatch["5. Dispatch to Zustand Store"]
    StoreDispatch --> Drain
```

---

## 4. Message Type Protocols

### 1. `TOKEN` Flow (Streaming response segment)
1. **WS Reception**: A token message arrives with sequence number $S$ and text chunk.
2. **Buffer Processing**: Placed in heap; once drained in-order, state updates to `STREAMING`.
3. **Store Dispatch**: 
   - Locates or initializes the active `AgentMessage` matching `stream_id`.
   - Appends text to the last `text` segment. If the previous segment was a tool call, it spawns a fresh `text` segment (ensuring sequential segment stacking).
   - Groups consecutive tokens into a timeline `TokenBatch` row if timestamps are within 300ms.
4. **DOM Render**: Appends directly to text elements via React ref nodes to prevent overall panel reflowing.

### 2. `TOOL_CALL` and `TOOL_RESULT` Flow (Mid-stream pauses)
```mermaid
sequenceDiagram
    participant Server
    participant WSManager
    participant Store
    participant UI

    Server->>WSManager: TOOL_CALL (seq 5, call_id tc_01, args)
    WSManager->>Server: TOOL_ACK (call_id tc_01)
    WSManager->>Store: Dispatch TOOL_CALL
    Store->>UI: Append ToolCallSegment (pending)
    Note over UI: Freezes text. Renders pending ToolCard.
    
    Server->>WSManager: TOOL_RESULT (seq 6, call_id tc_01, result)
    WSManager->>Store: Dispatch TOOL_RESULT
    Store->>UI: Update ToolCallSegment (complete)
    Note over UI: Fills result card. Spawns next text segment.
```

### 3. `CONTEXT_SNAPSHOT` Flow (Working memory tracking)
1. Context payload arrives containing syntax trees.
2. Store registers the data in `contextSnapshots` mapped by `context_id`.
3. The scrubber slider is updated, computing a deep JSON diff comparing the new context to the previous snapshot:
   - Green highlights for added keys.
   - Red highlights for deleted keys (drawn with a strikethrough).
   - Yellow highlights for modified values.

### 4. `PING` & `PONG` Flow (Heartbeat keepalive)
1. **Fast PONG**: Upon receiving a `PING` frame, a `PONG` response is dispatched **instantly** to avoid timeout triggers on the server.
2. **Empty Challenge Handling**: If `msg.challenge` is empty or missing, a `PONG` is returned with an empty echo `""` to satisfy corrupt ping survival metrics without crashing.
3. **Trace Entry**: The PING is added to the reorder buffer. When drained, it registers as a row in the trace timeline.

### 5. `ERROR` Flow (Server-side anomalies)
1. Server reports an anomaly.
2. WSManager transitions connection state to `CONNECTED` (idle) to release input locks, and logs it.
3. A red-colored log row is pushed to the trace timeline.

### 6. `STREAM_END` Flow (Turn completion)
1. End packet arrives.
2. Connection FSM transitions to `CONNECTED`.
3. Active `AgentMessage` is marked `isComplete = true` and the blinking text cursor is hidden.

---

## 5. State Recovery Protocol (RESUME)

The following flow illustrates how the console reconstructs history when recovering from a network drop:

```mermaid
flowchart TD
    %% Reconnection Flow
    Drop[Connection Lost] --> StateReconnecting[State: RECONNECTING]
    StateReconnecting --> Indicator[Amber Banner Displayed in UI]
    Indicator --> CalculateBackoff[Exponential Backoff: 500ms * 2^attempt, max 10s]
    CalculateBackoff --> Wait[Wait Timer]
    Wait --> Connect[Retry WebSocket Connect]
    Connect --> Success{Connected?}
    
    %% Reconnect Handling
    Success -->|No| CalculateBackoff
    Success -->|Yes| CheckSession{Has existing session?}
    CheckSession -->|No| StateConnected[State: CONNECTED]
    CheckSession -->|Yes| StateResuming[State: RESUMING]
    
    StateResuming --> SendResume[Send RESUME message with lastProcessedSeq]
    SendResume --> ClearBuffer[Clear ReorderBuffer heap]
    ClearBuffer --> SetSeq[Set nextExpectedSeq = lastProcessedSeq + 1]
    SetSeq --> Replay[Process server replayed history frames]
    Replay --> Stitch[Stitch replayed segments back to chat and timeline in order]
    Stitch --> StateStreaming[State: STREAMING / CONNECTED]
```

---

## 6. Setup & Execution Instructions

### Installation
```bash
npm install
```

### Development Run
Runs the client at [http://localhost:3000](http://localhost:3000):
```bash
npm run dev
```

### Production Build & Run
```bash
npm run build
npm start
```
