import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { selectScript } from "./scripts.js";
import { ChaosEngine, generateChaosConfig } from "./chaos.js";
// ─────────────────────────────────────────────────────────────
// AgentServer
//
// Single-session server: one active client at a time.
// Maintains event history for RESUME-based reconnection.
// ─────────────────────────────────────────────────────────────
export class AgentServer {
    mode;
    httpServer;
    wss;
    activeWs = null;
    // ── Sequence & history ────────────────────────────────────
    seq = 0;
    eventHistory = [];
    // ── Client event log (for /log endpoint) ──────────────────
    clientLog = [];
    // ── Heartbeat ─────────────────────────────────────────────
    heartbeatInterval = null;
    pendingPing = null;
    missedPongs = 0;
    HEARTBEAT_INTERVAL_MS = 12_000;
    PONG_TIMEOUT_MS = 3_000;
    pongTimeoutHandle = null;
    // ── Tool ACK tracking ─────────────────────────────────────
    pendingAcks = new Map();
    // ── Streaming state ───────────────────────────────────────
    isStreaming = false;
    streamAbortController = null;
    // ── Chaos ─────────────────────────────────────────────────
    chaosEngine = null;
    chaosConfig = null;
    constructor(mode) {
        this.mode = mode;
        this.httpServer = http.createServer((req, res) => {
            this.handleHttp(req, res);
        });
        this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
        this.wss.on("connection", (ws) => this.handleConnection(ws));
    }
    listen(port) {
        this.httpServer.listen(port, () => {
            console.log(`[agent-server] mode=${this.mode} port=${port}`);
            console.log(`[agent-server] WebSocket: ws://localhost:${port}/ws`);
            console.log(`[agent-server] Health:    http://localhost:${port}/health`);
            console.log(`[agent-server] Logs:      http://localhost:${port}/log`);
        });
    }
    // ─────────────────────────────────────────────────────────
    // HTTP handler
    // ─────────────────────────────────────────────────────────
    handleHttp(req, res) {
        // CORS headers for local dev
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                mode: this.mode,
                connected: this.activeWs !== null && this.activeWs.readyState === WebSocket.OPEN,
                seq: this.seq,
                historyLength: this.eventHistory.length,
            }));
            return;
        }
        if (req.url === "/log") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(this.clientLog, null, 2));
            return;
        }
        if (req.url === "/reset") {
            this.resetSession();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "reset" }));
            return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
    }
    // ─────────────────────────────────────────────────────────
    // WebSocket connection handler
    // ─────────────────────────────────────────────────────────
    handleConnection(ws) {
        console.log("[agent-server] New WebSocket connection");
        // Replace previous connection
        if (this.activeWs && this.activeWs.readyState === WebSocket.OPEN) {
            console.log("[agent-server] Closing previous connection");
            this.activeWs.close(1000, "replaced");
        }
        this.stopHeartbeat();
        this.abortStream();
        this.activeWs = ws;
        this.missedPongs = 0;
        // Generate new chaos config per connection
        if (this.mode === "chaos") {
            this.chaosConfig = generateChaosConfig();
            this.chaosEngine = new ChaosEngine(this.chaosConfig);
            console.log("[agent-server] Chaos config:", JSON.stringify(this.chaosConfig));
        }
        ws.on("message", (data) => this.handleMessage(ws, data));
        ws.on("close", (code, reason) => {
            console.log(`[agent-server] Connection closed: ${code} ${reason.toString()}`);
            if (this.activeWs === ws) {
                this.stopHeartbeat();
                this.activeWs = null;
            }
        });
        ws.on("error", (err) => {
            console.error("[agent-server] WebSocket error:", err.message);
        });
        // Start heartbeat after a short delay (let client settle)
        setTimeout(() => {
            if (this.activeWs === ws && ws.readyState === WebSocket.OPEN) {
                this.startHeartbeat(ws);
            }
        }, 2000);
    }
    // ─────────────────────────────────────────────────────────
    // Message handler
    // ─────────────────────────────────────────────────────────
    handleMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            this.logClient("PARSE_ERROR", { raw: raw.toString().slice(0, 200) }, "error");
            return;
        }
        switch (msg.type) {
            case "USER_MESSAGE":
                this.logClient("USER_MESSAGE", { content: msg.content }, "ok");
                this.handleUserMessage(ws, msg.content);
                break;
            case "PONG":
                this.handlePong(msg.echo);
                break;
            case "RESUME":
                this.logClient("RESUME", { last_seq: msg.last_seq }, "ok");
                this.handleResume(ws, msg.last_seq);
                break;
            case "TOOL_ACK":
                this.handleToolAck(msg.call_id);
                break;
            default:
                this.logClient("UNKNOWN_MESSAGE", { msg }, "error");
        }
    }
    // ─────────────────────────────────────────────────────────
    // USER_MESSAGE → run agent script
    // ─────────────────────────────────────────────────────────
    handleUserMessage(ws, content) {
        // Abort any in-progress stream
        this.abortStream();
        // Reset sequence and history for a new conversation turn
        // (keep the client log — it persists across turns)
        this.seq = 0;
        this.eventHistory = [];
        if (this.chaosEngine) {
            this.chaosEngine.reset();
        }
        const script = selectScript(content);
        console.log(`[agent-server] Selected script: ${script.name} (${script.id})`);
        this.runScript(ws, script).catch((err) => {
            if (err.name !== "AbortError") {
                console.error("[agent-server] Script error:", err);
            }
        });
    }
    // ─────────────────────────────────────────────────────────
    // RESUME → replay history after last_seq
    // ─────────────────────────────────────────────────────────
    handleResume(ws, lastSeq) {
        console.log(`[agent-server] Resume from seq=${lastSeq}, history has ${this.eventHistory.length} events`);
        const toReplay = this.eventHistory.filter((m) => m.seq > lastSeq);
        console.log(`[agent-server] Replaying ${toReplay.length} events`);
        for (const msg of toReplay) {
            this.rawSend(ws, msg);
        }
        // If stream was in progress when connection dropped, resume it
        // The abortStream() was called on disconnect, so the script
        // stopped. We don't auto-resume the script — the replayed events
        // give the client everything that was sent before the drop.
        // For a real system you'd resume the script, but for this test
        // server the replay is sufficient.
    }
    // ─────────────────────────────────────────────────────────
    // PONG handler
    // ─────────────────────────────────────────────────────────
    handlePong(echo) {
        if (!this.pendingPing) {
            this.logClient("PONG", { echo, expected: null }, "unexpected");
            return;
        }
        const latency = Date.now() - this.pendingPing.sentAt;
        if (echo === this.pendingPing.challenge) {
            this.logClient("PONG", { echo, latency_ms: latency }, "ok");
            this.missedPongs = 0;
        }
        else {
            this.logClient("PONG", {
                echo,
                expected: this.pendingPing.challenge,
                latency_ms: latency,
            }, "wrong_challenge");
        }
        this.pendingPing = null;
        if (this.pongTimeoutHandle) {
            clearTimeout(this.pongTimeoutHandle);
            this.pongTimeoutHandle = null;
        }
    }
    // ─────────────────────────────────────────────────────────
    // TOOL_ACK handler
    // ─────────────────────────────────────────────────────────
    handleToolAck(callId) {
        const pending = this.pendingAcks.get(callId);
        if (pending) {
            this.logClient("TOOL_ACK", { call_id: callId }, "ok");
            clearTimeout(pending.timeout);
            this.pendingAcks.delete(callId);
            pending.resolve();
        }
        else {
            this.logClient("TOOL_ACK", { call_id: callId }, "unexpected");
        }
    }
    // ─────────────────────────────────────────────────────────
    // Script execution engine
    // ─────────────────────────────────────────────────────────
    async runScript(ws, script) {
        const streamId = `s_${randomUUID().slice(0, 8)}`;
        const abort = new AbortController();
        this.streamAbortController = abort;
        this.isStreaming = true;
        try {
            for (const event of script.events) {
                if (abort.signal.aborted)
                    return;
                if (ws.readyState !== WebSocket.OPEN)
                    return;
                switch (event.kind) {
                    case "context": {
                        const msg = {
                            type: "CONTEXT_SNAPSHOT",
                            seq: this.nextSeq(),
                            context_id: event.context_id,
                            data: event.data,
                        };
                        await this.sendMessage(ws, msg);
                        break;
                    }
                    case "token": {
                        const msg = {
                            type: "TOKEN",
                            seq: this.nextSeq(),
                            text: event.text,
                            stream_id: streamId,
                        };
                        await this.sendMessage(ws, msg);
                        // Token delay: 30–80ms in normal, variable in chaos
                        const baseDelay = 30 + Math.random() * 50;
                        await this.delay(baseDelay, abort.signal);
                        break;
                    }
                    case "tool_call": {
                        const callId = `tc_${randomUUID().slice(0, 8)}`;
                        // Send TOOL_CALL
                        const callMsg = {
                            type: "TOOL_CALL",
                            seq: this.nextSeq(),
                            call_id: callId,
                            tool_name: event.tool_name,
                            args: event.args,
                            stream_id: streamId,
                        };
                        await this.sendMessage(ws, callMsg);
                        // Wait for TOOL_ACK (with 5s timeout)
                        await this.waitForAck(callId);
                        // Simulate tool execution delay
                        await this.delay(800 + Math.random() * 1200, abort.signal);
                        if (abort.signal.aborted)
                            return;
                        if (ws.readyState !== WebSocket.OPEN)
                            return;
                        // Send TOOL_RESULT
                        const resultMsg = {
                            type: "TOOL_RESULT",
                            seq: this.nextSeq(),
                            call_id: callId,
                            result: event.result,
                            stream_id: streamId,
                        };
                        await this.sendMessage(ws, resultMsg);
                        // Brief pause before resuming tokens
                        await this.delay(200, abort.signal);
                        break;
                    }
                }
            }
            // Stream end
            if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
                // Flush any remaining chaos buffer
                if (this.chaosEngine) {
                    const remaining = this.chaosEngine.flush();
                    for (const msg of remaining) {
                        this.rawSend(ws, msg);
                    }
                }
                const endMsg = {
                    type: "STREAM_END",
                    seq: this.nextSeq(),
                    stream_id: streamId,
                };
                await this.sendMessage(ws, endMsg);
            }
        }
        finally {
            this.isStreaming = false;
            this.streamAbortController = null;
        }
    }
    // ─────────────────────────────────────────────────────────
    // Message sending (with chaos if enabled)
    // ─────────────────────────────────────────────────────────
    async sendMessage(ws, message) {
        if (ws.readyState !== WebSocket.OPEN)
            return;
        // Record in history (always the original, unchaoticised version)
        this.eventHistory.push(message);
        if (this.chaosEngine) {
            // Check for connection drop
            if (this.chaosEngine.shouldDropConnection()) {
                console.log("[chaos] Dropping connection");
                ws.terminate();
                return;
            }
            // Process through chaos pipeline
            const { messages, delayMs } = this.chaosEngine.process(message);
            if (delayMs > 0) {
                console.log(`[chaos] Latency spike: ${Math.round(delayMs)}ms`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            for (const msg of messages) {
                this.rawSend(ws, msg);
            }
        }
        else {
            this.rawSend(ws, message);
        }
    }
    rawSend(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
    // ─────────────────────────────────────────────────────────
    // Heartbeat management
    // ─────────────────────────────────────────────────────────
    startHeartbeat(ws) {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                this.stopHeartbeat();
                return;
            }
            // Check if previous ping was answered
            if (this.pendingPing) {
                this.missedPongs++;
                this.logClient("PONG_TIMEOUT", {
                    challenge: this.pendingPing.challenge,
                    missed_count: this.missedPongs,
                }, "violation");
                if (this.missedPongs >= 3) {
                    console.log("[agent-server] 3 missed PONGs — terminating connection");
                    this.logClient("CONNECTION_TERMINATED", { reason: "missed_pongs" }, "violation");
                    ws.terminate();
                    this.stopHeartbeat();
                    return;
                }
            }
            // Generate challenge
            let challenge = randomUUID().slice(0, 8);
            // In chaos mode, occasionally send a corrupt (empty) challenge
            if (this.chaosEngine && this.chaosEngine.shouldCorruptPing()) {
                console.log("[chaos] Sending corrupt PING (empty challenge)");
                challenge = "";
            }
            const pingMsg = {
                type: "PING",
                seq: this.nextSeq(),
                challenge,
            };
            this.pendingPing = { challenge, sentAt: Date.now() };
            // Record in history
            this.eventHistory.push(pingMsg);
            this.rawSend(ws, pingMsg);
            // Set a timeout for the PONG
            this.pongTimeoutHandle = setTimeout(() => {
                if (this.pendingPing && this.pendingPing.challenge === challenge) {
                    // PONG was not received in time — will be caught on next heartbeat tick
                }
            }, this.PONG_TIMEOUT_MS);
        }, this.HEARTBEAT_INTERVAL_MS);
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.pongTimeoutHandle) {
            clearTimeout(this.pongTimeoutHandle);
            this.pongTimeoutHandle = null;
        }
        this.pendingPing = null;
    }
    // ─────────────────────────────────────────────────────────
    // Tool ACK waiting
    // ─────────────────────────────────────────────────────────
    waitForAck(callId) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (this.pendingAcks.has(callId)) {
                    console.log(`[agent-server] TOOL_ACK timeout for ${callId}`);
                    this.logClient("TOOL_ACK_TIMEOUT", { call_id: callId }, "violation");
                    this.pendingAcks.delete(callId);
                    resolve();
                }
            }, 5000);
            this.pendingAcks.set(callId, { resolve, timeout });
        });
    }
    // ─────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────
    nextSeq() {
        return ++this.seq;
    }
    delay(ms, signal) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            if (signal) {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new DOMException("Aborted", "AbortError"));
                };
                if (signal.aborted) {
                    clearTimeout(timer);
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }
    abortStream() {
        if (this.streamAbortController) {
            this.streamAbortController.abort();
            this.streamAbortController = null;
        }
        this.isStreaming = false;
        // Clear pending ACKs
        for (const [, entry] of this.pendingAcks) {
            clearTimeout(entry.timeout);
            entry.resolve();
        }
        this.pendingAcks.clear();
    }
    resetSession() {
        this.abortStream();
        this.stopHeartbeat();
        this.seq = 0;
        this.eventHistory = [];
        this.clientLog = [];
        this.missedPongs = 0;
        if (this.chaosEngine) {
            this.chaosEngine.reset();
        }
        console.log("[agent-server] Session reset");
    }
    logClient(type, data, verdict) {
        this.clientLog.push({
            timestamp: Date.now(),
            type,
            data,
            verdict,
        });
    }
}
