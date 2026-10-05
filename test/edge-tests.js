"use strict";

/**
 * Edge-case checks (not part of the required four scenarios):
 *   - server->client reverse request re-id + response mapping,
 *   - backend notifications pass through,
 *   - stdout purity: every emitted line is parseable JSON-RPC.
 *
 * Run: node test/edge-tests.js
 */

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src", "cli.js");
const MOCK = path.join(__dirname, "mock-reverse-server.js");

function run() {
  const child = spawn(process.execPath, [CLI, "--mode", "enforce", "--", process.execPath, MOCK], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messages = [];
  const parseErrors = [];

  // Install the line parser FIRST — attaching ANY 'data' listener flips the
  // socket into flowing mode, so it must be the real parser, otherwise frames
  // emitted between spawn and a later listener registration would be lost.
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      try {
        messages.push(JSON.parse(line));
      } catch {
        parseErrors.push(line);
      }
    }
  });

  const whenSpawned = new Promise((resolve) => child.on("spawn", resolve));
  const waitFor = (pred, timeout = 15000) =>
    new Promise((resolve) => {
      const tick = () => {
        const found = messages.find(pred);
        if (found) return resolve(found);
        if (Date.now() - start > timeout) return resolve(null);
        setImmediate(tick);
      };
      const start = Date.now();
      tick();
    });
  return { child, messages, parseErrors, whenSpawned, waitFor };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { child, messages, parseErrors, whenSpawned, waitFor } = run();
  await whenSpawned;
  await sleep(300);

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e", version: "0" } },
    }) + "\n"
  );

  // Wait until the backend's reverse request actually arrives (re-ided to
  // r:1) before answering. Answering on a fixed timer is invalid: the proxy
  // (correctly) treats an answer with no pending reverse request as stray.
  const reverse = await waitFor((m) => m.method === "sampling/createMessage");
  const reverseOk = !!reverse && reverse.id === "r:1";

  if (reverseOk) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: "r:1", result: { role: "assistant", content: { type: "text", text: "ok" } } }) + "\n"
    );
  }

  // tools/list triggers a backend notification after responding.
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await waitFor((m) => m.id === 2 && Array.isArray(m.result?.tools));
  await sleep(100);

  const notif = messages.find((m) => m.method === "notifications/resources/list_changed");
  const notifOk = !!notif && notif.id === undefined;
  const listOk = !!messages.find((m) => m.id === 2 && Array.isArray(m.result?.tools));
  const purityOk = parseErrors.length === 0 && messages.every((m) => m.jsonrpc === "2.0");

  child.stdin.end();
  await new Promise((r) => child.on("exit", r));

  // The mock backend emits notifications/progress only when it receives the
  // reverse-request answer mapped back to its ORIGINAL id "rev-42".
  const mappedBack = !!messages.find(
    (m) => m.method === "notifications/progress" && m.params?.result?.content?.text === "ok"
  );

  const checks = [
    ["reverse request relayed with proxy id r:1", reverseOk],
    ["reverse response mapped back to original backend id", mappedBack],
    ["backend notification passes through", notifOk],
    ["tools/list response returns to original client id", listOk],
    ["stdout purity: every line is valid JSON-RPC", purityOk],
  ];

  let fail = 0;
  checks.forEach(([n, ok]) => {
    process.stderr.write(`[${ok ? "PASS" : "FAIL"}] edge: ${n}\n`);
    if (!ok) fail += 1;
  });
  process.exit(fail ? 1 : 0);
}

main();
