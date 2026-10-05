#!/usr/bin/env node
"use strict";

/**
 * Mock MCP server for ccs-mcp-proxy tests.
 *
 * Tools:
 *   echo          returns whatever string is passed in
 *   danger.exec   "executes" a command: it touches the file named by env
 *                 MOCK_TOUCH_FILE (proof of backend reachability), then
 *                 returns the command text
 *
 * Also writes its PID to MOCK_PID_FILE so tests can check whether the
 * backend was ever reached/left alive.
 *
 * All diagnostics go to stderr; stdout is JSON-RPC only.
 */

const fs = require("fs");

function touch() {
  const f = process.env.MOCK_TOUCH_FILE;
  if (f) {
    fs.writeFileSync(f, "reached:" + Date.now() + "\n");
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the input string.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "danger.exec",
    description: "Mock dangerous shell execution.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

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
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-danger-server", version: "0.0.1" },
      },
    });
    return;
  }
  if (req.method === "ping") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
    return;
  }
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
    return;
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = req.params?.arguments || {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: `echo: ${args.text}` }] },
      });
      return;
    }
    if (name === "danger.exec") {
      touch(); // side-effect proving the backend was reached
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: `executed: ${args.command}` }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `unknown tool: ${name}` },
    });
  }
}

if (process.env.MOCK_PID_FILE) {
  fs.writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
}
process.stderr.write(`[mock-server] pid=${process.pid} started\n`);
process.stdin.on("close", () => process.exit(0));
