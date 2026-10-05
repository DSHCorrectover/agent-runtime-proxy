#!/usr/bin/env node
"use strict";

/**
 * Edge-case mock MCP server:
 *  - on initialize it issues a server->client reverse request
 *    (sampling/createMessage) and expects a response mapped back to its
 *    original id;
 *  - after tools/list it emits a notification (notifications/resources/list_changed).
 *
 * Used by edge-tests.js only.
 */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    handle(req);
  }
});

function handle(req) {
  if (req.method === "initialize") {
    // Fire a reverse request with a distinctive id.
    send({
      jsonrpc: "2.0",
      id: "rev-42",
      method: "sampling/createMessage",
      params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 },
    });
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-reverse-server", version: "0.0.1" },
      },
    });
    return;
  }
  if (req.id === "rev-42") {
    // The answer to our reverse request, mapped back to the original id.
    send({
      jsonrpc: "2.0",
      id: "reverse-answer-observed",
      method: "notifications/progress",
      params: { progressToken: "t", result: req.result },
    });
    return;
  }
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [] } });
    send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  }
}
process.stdin.on("close", () => process.exit(0));
