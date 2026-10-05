"use strict";

/**
 * ccs-mcp-proxy — transparent stdio MCP proxy with fail-closed CCS
 * verification.
 *
 *   MCP Client  <--stdio-->  ccs-mcp-proxy  <--stdio(spawn)-->  target MCP server
 *
 * Behaviour:
 *  - initialize / tools/list / ping / all other methods and every
 *    notification are transparently forwarded in both directions, including
 *    server->client reverse requests and JSON-RPC batches.
 *  - tools/call is intercepted:
 *      enforce (default): verify first (CCS 7-dimension verifyCall). A
 *        "denied" verdict, verifier unavailability or verifier timeout
 *        (fail-closed) means the call is NOT forwarded; the client receives
 *        an MCP isError result carrying the signed denial receipt.
 *      shadow: the call is always forwarded, but verification still runs and
 *        both receipts are attached to result._meta (observation mode).
 *    On allow/forward, a signed execution receipt is attached in
 *    result._meta.ccs without altering the MCP content protocol.
 *  - stdout carries JSON-RPC only; all logs go to stderr.
 *
 * Id mapping: requests created by the proxy get their own ids prefixed "p:"
 * (outbound to backend) / "r:" (reverse requests to client), so they can
 * never collide with ids used by the peers.
 */

const { spawn } = require("child_process");
const { createLineFramer } = require("./framing");
const { createVerifier } = require("./verifier");

const REQUEST_METHODS = new Set(["request", "response", "error", "notification"]);

function isResponseLike(msg) {
  return msg && typeof msg === "object" && (msg.result !== undefined || msg.error !== undefined);
}
function hasId(msg) {
  return msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id");
}
function isRequest(msg) {
  return msg && typeof msg === "object" && typeof msg.method === "string" && hasId(msg);
}
function isNotification(msg) {
  return msg && typeof msg === "object" && typeof msg.method === "string" && !hasId(msg);
}

class CcsProxy {
  constructor(options = {}) {
    this.options = options;
    this.mode = options.mode === "shadow" ? "shadow" : "enforce";
    this.log = options.logger || (() => {});

    // Stop stdin flowing BEFORE any potentially slow work (the verifier
    // require chain can take hundreds of milliseconds on cold start). A
    // client may write immediately after spawn; bytes hitting a flowing
    // stdin before our 'data' listener exists would be silently dropped.
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }

    // Verifier is lazy: creation does not require the (slow-to-load) CCS
    // module, so initialize/tools/list are never blocked by it.
    this.verifier = createVerifier({
      modulePath: options.verifierModule,
      receiptsPath: options.receiptsModule,
      timeoutMs: options.verifyTimeoutMs,
      policy: options.policy,
      mode: this.mode,
    });

    // backend outbound requests: backendId -> { clientId }
    this.pendingBackend = new Map();
    // reverse requests from backend relayed to client: clientId -> backendId
    this.pendingReverse = new Map();

    this.backendSeq = 0;
    this.reverseSeq = 0;
    this.stopped = false;
    this.backendDead = false;
    this.clientClosed = false;

    // Wire stdin listeners FIRST (stdin is already paused), then spawn the
    // backend and attach its listeners, then resume everything.
    this.wireStdin();
    this.backend = this.spawnBackend();
    this.wireBackend();
    process.stdin.resume();
    this.backend.stdout.resume();
  }

  // ---------------------------------------------------------------- backend

  spawnBackend() {
    const { command, args = [], env = {} } = this.options.backend;
    if (!command) throw new Error("backend command is required");

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: false,
    });

    // Hold backend stdout paused until listeners are wired in the
    // constructor; otherwise early frames (e.g. a server that emits on
    // startup) could be lost during cold start. NOTE: stderr is deliberately
    // NOT paused — it is consumed line-by-line for logs and pausing it
    // risks backpressuring/dropping the backend's own startup diagnostics.
    child.stdout.pause();

    child.on("error", (err) => {
      this.log("error", `failed to spawn backend: ${err.message}`);
      this.onBackendExit(-1, null);
    });
    child.on("exit", (code, signal) => this.onBackendExit(code, signal));

    return child;
  }

  onBackendExit(code, signal) {
    if (this.backendDead) return;
    this.backendDead = true;
    this.log("info", `backend exited (code=${code}, signal=${signal})`);

    // Fail any request still waiting on the backend. These are JSON-RPC
    // requests originated by the client; a dead backend is a transport-level
    // failure, so answer with a standard error instead of hanging.
    for (const [, entry] of this.pendingBackend) {
      const errPayload = { error: { code: -32000, message: "upstream MCP server terminated" } };
      if (entry && typeof entry.resolve === "function") {
        entry.resolve(errPayload);
      } else if (entry && entry.id !== undefined) {
        this.writeClient({ jsonrpc: "2.0", id: entry.id, ...errPayload });
      }
    }
    this.pendingBackend.clear();

    // Reverse requests can never be answered now; nothing more we can do
    // besides dropping them.
    this.pendingReverse.clear();

    if (this.stopped) return;
    // The second fuse keeps running while the client side is alive so the
    // client can observe/handle the backend loss; if the client already
    // disconnected we tear down.
    if (this.clientClosed) this.shutdown();
  }

  // -------------------------------------------------------------- transport

  wireStdin() {
    // stdin is paused (constructor top). Attach all readers; the caller
    // resumes stdin after the backend is wired too.
    process.stdin.on(
      "data",
      createLineFramer((line) => this.onClientLine(line))
    );
    process.stdin.on("close", () => {
      this.clientClosed = true;
      this.log("info", "client closed stdin");
      this.shutdown(); // proxy lifespan is bound to the client connection
    });
    process.stdin.on("error", (e) => this.log("error", `stdin error: ${e.message}`));
  }

  wireBackend() {
    // backend.stdout is paused from spawn; attach readers, caller resumes.
    this.backend.stdout.on(
      "data",
      createLineFramer((line) => this.onBackendLine(line))
    );
    this.backend.stderr.on("data", (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter((l) => l.length)
        .forEach((l) => this.log("backend", l));
    });
  }

  onClientLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.log("warn", `unparseable message from client: ${e.message}`);
      return;
    }
    this.fromClient(msg);
  }

  onBackendLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.log("warn", `unparseable message from backend: ${e.message}`);
      return;
    }
    this.fromBackend(msg);
  }

  // ------------------------------------------------------------- direction

  fromClient(msg) {
    if (Array.isArray(msg)) {
      msg.forEach((m) => this.fromClient(m));
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Client answering a reverse request originally issued by the backend.
    if (isResponseLike(msg) && this.pendingReverse.has(msg.id)) {
      const backendId = this.pendingReverse.get(msg.id);
      this.pendingReverse.delete(msg.id);
      this.writeBackend({ jsonrpc: "2.0", id: backendId, ...(msg.error ? { error: msg.error } : { result: msg.result }) });
      return;
    }

    if (isNotification(msg)) {
      this.writeBackend(msg);
      return;
    }

    if (isRequest(msg)) {
      if (msg.method === "tools/call") {
        this.handleToolsCall(msg);
        return;
      }
      this.requestBackend(msg);
      return;
    }

    // Stray response with no matching reverse request (or invalid message).
    this.log("warn", `dropping unmatched client message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  fromBackend(msg) {
    if (Array.isArray(msg)) {
      msg.forEach((m) => this.fromBackend(m));
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Backend answering a request originated by the client.
    if (isResponseLike(msg) && this.pendingBackend.has(msg.id)) {
      const entry = this.pendingBackend.get(msg.id);
      this.pendingBackend.delete(msg.id);
      const payload = msg.error ? { error: msg.error } : { result: msg.result };
      if (typeof entry.resolve === "function") {
        entry.resolve(payload); // internal callBackend() promise
      } else {
        this.writeClient({ jsonrpc: "2.0", id: entry.id, ...payload });
      }
      return;
    }

    if (isNotification(msg)) {
      // Backend-initiated notifications (e.g. notifications/progress,
      // resources/list/changed) pass through untouched.
      this.writeClient(msg);
      return;
    }

    if (isRequest(msg)) {
      // Server -> client reverse request (sampling/createMessage,
      // roots/list, elicitation/create, ...). Re-id to avoid colliding with
      // ids the client itself is using.
      const clientId = `r:${++this.reverseSeq}`;
      this.pendingReverse.set(clientId, msg.id);
      this.writeClient({ jsonrpc: "2.0", id: clientId, method: msg.method, params: msg.params });
      return;
    }

    this.log("warn", `dropping unmatched backend message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  requestBackend(clientMsg) {
    if (this.backendDead) {
      this.writeClient({
        jsonrpc: "2.0",
        id: clientMsg.id,
        error: { code: -32000, message: "upstream MCP server is not running" },
      });
      return;
    }
    const backendId = `p:${++this.backendSeq}`;
    this.pendingBackend.set(backendId, { id: clientMsg.id });
    this.writeBackend({
      jsonrpc: "2.0",
      id: backendId,
      method: clientMsg.method,
      params: clientMsg.params,
    });
  }

  // -------------------------------------------------------------- tools/call

  async handleToolsCall(msg) {
    const clientId = msg.id;
    const params = msg.params || {};
    const tool = params.name;
    const toolArgs = params.arguments && typeof params.arguments === "object" ? params.arguments : {};

    if (typeof tool !== "string" || !tool) {
      this.writeClient({
        jsonrpc: "2.0",
        id: clientId,
        error: { code: -32602, message: "tools/call requires a string 'name'" },
      });
      return;
    }

    const caller = this.buildCaller(params);
    const call = {
      tool,
      arguments: toolArgs,
      caller,
      metadata: this.buildMetadata(params),
    };

    const startedAt = process.hrtime.bigint();
    const vResult = await this.verifier.verify(call, { mode: this.mode });

    // Fail-closed: verifier failure/timeout is a hard deny in both modes.
    if (!vResult.ok) {
      this.log(
        "warn",
        `fail-closed [${vResult.reason}] tool=${tool} caller=${caller.agent_id} detail=${vResult.detail || ""}`
      );
      const denied = {
        ...call,
        verdict: "denied",
        failure: vResult.reason,
        failure_detail: vResult.detail,
      };
      this.writeClient(this.deniedResponse(clientId, vResult.receipt, denied, {
        enforced: true,
        reason: vResult.reason,
      }));
      return;
    }

    const verificationReceipt = vResult.receipt;
    const verdict = verificationReceipt.verdict === "denied" ? "denied" : "allowed";

    if (verdict === "denied" && this.mode === "enforce") {
      this.log("info", `denied (enforce) tool=${tool} caller=${caller.agent_id}`);
      const denied = {
        ...call,
        verdict: "denied",
        dimensions: verificationReceipt.dimensions,
      };
      this.writeClient(this.deniedResponse(clientId, verificationReceipt, denied, {
        enforced: true,
        reason: "ccs_denied",
      }));
      return;
    }

    // Allowed-in-enforce, or any call in shadow (including denied verdicts,
    // which shadow observes but does not block).
    if (this.backendDead) {
      this.writeClient({
        jsonrpc: "2.0",
        id: clientId,
        error: { code: -32000, message: "upstream MCP server is not running" },
      });
      return;
    }

    const execStarted = process.hrtime.bigint();
    const backendMsg = await this.callBackend({
      method: "tools/call",
      params,
    });
    const elapsedMs = Number(process.hrtime.bigint() - execStarted) / 1e6;

    const ccsMeta = {
      mode: this.mode,
      enforced: false,
      verdict,
      verification: verificationReceipt,
    };
    if (verdict === "denied" && this.mode === "shadow") {
      ccsMeta.enforced = false;
      ccsMeta.shadow_observed_denial = true;
    }

    if (backendMsg.error) {
      // Backend-level JSON-RPC error (transport/protocol). Still leave an
      // execution receipt for the audit trail, then surface the error.
      const execReceipt = this.verifier.signExecution(
        { tool, caller, verification_receipt: verificationReceipt },
        { result: { error: backendMsg.error }, isTransportError: true, elapsedMs }
      );
      ccsMeta.execution = execReceipt;
      this.writeClient({
        jsonrpc: "2.0",
        id: clientId,
        error: { ...backendMsg.error, data: { ccs: ccsMeta } },
      });
      return;
    }

    const result = backendMsg.result && typeof backendMsg.result === "object" ? backendMsg.result : {};
    const execReceipt = this.verifier.signExecution(
      { tool, caller, verification_receipt: verificationReceipt },
      { result, isTransportError: false, elapsedMs }
    );
    ccsMeta.execution = execReceipt;

    this.writeClient({
      jsonrpc: "2.0",
      id: clientId,
      result: {
        ...result,
        _meta: { ...(result._meta || {}), ccs: ccsMeta },
      },
    });

    const totalUs = Number(process.hrtime.bigint() - startedAt) / 1e3;
    this.log(
      "info",
      `${verdict} -> forwarded (${this.mode}) tool=${tool} caller=${caller.agent_id} total=${Math.round(totalUs)}us`
    );
  }

  deniedResponse(clientId, receipt, callLike, extra) {
    const reasonText =
      (receipt && receipt.dimensions
        ? Object.entries(receipt.dimensions)
            .filter(([, d]) => d.status === "fail")
            .map(([k, d]) => `${k}: ${d.reason || "fail"}`)
            .join("; ")
        : "") || callLike.failure || "ccs denied";

    return {
      jsonrpc: "2.0",
      id: clientId,
      result: {
        content: [
          {
            type: "text",
            text:
              `[ccs-mcp-proxy] tool call blocked by fail-closed CCS verification.\n` +
              `tool: ${callLike.tool}\ncaller: ${callLike.caller?.agent_id || "unknown"}\n` +
              `reason: ${reasonText}`,
          },
        ],
        isError: true,
        _meta: {
          ccs: {
            mode: this.mode,
            enforced: true,
            verdict: "denied",
            ...extra,
            verification: receipt || {
              unsigned: true,
              verdict: "denied",
              denial_reason: extra?.reason || "denied",
            },
          },
        },
      },
    };
  }

  callBackend(message) {
    return new Promise((resolve) => {
      if (this.backendDead) {
        resolve({ error: { code: -32000, message: "upstream MCP server is not running" } });
        return;
      }
      const backendId = `p:${++this.backendSeq}`;
      this.pendingBackend.set(backendId, {
        id: undefined,
        resolve,
      });
      this.writeBackend({ jsonrpc: "2.0", id: backendId, ...message });
    });
  }

  buildCaller(params) {
    // MCP itself carries no caller identity. The proxy injects a stable
    // synthetic identity so CCS Identity checks have a subject; real
    // deployments should pass the upstream agent id via params._meta.ccs_caller
    // or configure a fixed caller id.
    const configured =
      this.options.callerId ||
      process.env.CCS_CALLER_ID ||
      params?._meta?.ccs_caller ||
      null;
    return { agent_id: configured || "mcp-client:via-ccs-proxy" };
  }

  buildMetadata(params) {
    const meta = {};
    const upstream = params?._meta;
    if (upstream && typeof upstream === "object") {
      if (upstream.progressToken !== undefined) meta.progress_token = upstream.progressToken;
    }
    return meta;
  }

  // -------------------------------------------------------------- io / life

  writeBackend(msg) {
    if (!this.backend.stdin.writable) return;
    this.backend.stdin.write(JSON.stringify(msg) + "\n");
  }

  writeClient(msg) {
    if (this.stopped) return;
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    this.log("info", "proxy shutting down");
    try {
      if (!this.backendDead) {
        this.backend.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (!this.backendDead) this.backend.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 1000).unref();
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = { CcsProxy };
