#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { CcsProxy } = require("./proxy");

const HELP = `ccs-mcp-proxy — fail-closed transparent stdio MCP proxy with CCS verification

Usage:
  ccs-mcp-proxy [options] -- <backend-command> [backend-args...]

Options:
  --mode <shadow|enforce>     Verification mode (default: enforce; env CCS_PROXY_MODE)
  --policy-file <path>        JSON file with CCS policy overrides
  --policy-json <json>        Inline JSON string with CCS policy overrides
  --verifier-module <path>    Custom verifier module (exports verifyCall or verify)
  --receipts-module <path>    Custom receipts module (signReceipt/canonical)
  --verify-timeout-ms <n>     Verifier timeout; on timeout the call is denied (default 2000)
  --caller-id <id>            Synthetic caller id for CCS Identity checks
  --env <KEY=VALUE>           Extra environment variable for the backend (repeatable)
  -h, --help                  Show this help

Environment:
  CCS_PROXY_MODE, CCS_VERIFIER_MODULE, CCS_VERIFY_TIMEOUT_MS, CCS_CALLER_ID
  CCS_BACKEND_COMMAND         Backend command string, used only when no
                              command is given after "--"

Examples:
  ccs-mcp-proxy -- node /opt/servers/memory-server.js
  ccs-mcp-proxy --mode shadow -- npx -y some-mcp-server
  ccs-mcp-proxy --policy-file policy.json --env DEBUG=1 -- ./my-server --flag
`;

function parseArgs(argv) {
  const opts = {
    mode: process.env.CCS_PROXY_MODE || "enforce",
    backend: { command: null, args: [], env: {} },
    policy: {},
  };

  let i = 0;
  let seenDashDash = false;

  while (i < argv.length) {
    const a = argv[i];

    if (seenDashDash) {
      if (!opts.backend.command) opts.backend.command = a;
      else opts.backend.args.push(a);
      i += 1;
      continue;
    }

    if (a === "--") {
      seenDashDash = true;
      i += 1;
      continue;
    }
    if (a === "-h" || a === "--help") {
      opts.help = true;
      i += 1;
      continue;
    }
    if (a === "--mode") {
      opts.mode = argv[++i];
    } else if (a.startsWith("--mode=")) {
      opts.mode = a.split("=").slice(1).join("=");
    } else if (a === "--policy-file") {
      opts.policyFile = argv[++i];
    } else if (a === "--policy-json") {
      opts.policyJson = argv[++i];
    } else if (a === "--verifier-module") {
      opts.verifierModule = argv[++i];
    } else if (a === "--receipts-module") {
      opts.receiptsModule = argv[++i];
    } else if (a === "--verify-timeout-ms") {
      opts.verifyTimeoutMs = Number(argv[++i]);
    } else if (a === "--caller-id") {
      opts.callerId = argv[++i];
    } else if (a === "--env") {
      const pair = argv[++i] || "";
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`invalid --env value: ${pair}`);
      opts.backend.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      throw new Error(`unknown option: ${a}`);
    }
    i += 1;
  }

  if (!opts.backend.command && process.env.CCS_BACKEND_COMMAND) {
    const parts = tokenize(process.env.CCS_BACKEND_COMMAND);
    opts.backend.command = parts[0];
    opts.backend.args = parts.slice(1);
  }

  return opts;
}

// Minimal shell-like tokenizer for CCS_BACKEND_COMMAND: splits on
// whitespace, honoring single/double quotes and backslash escapes.
function tokenize(s) {
  const out = [];
  let cur = "";
  let has = false;
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function makeLogger() {
  return function log(level, msg) {
    const line = `[ccs-mcp-proxy] ${new Date().toISOString()} ${level} ${msg}\n`;
    process.stderr.write(line);
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }

  if (opts.help) {
    process.stderr.write(HELP);
    process.exit(0);
  }

  if (!opts.backend.command) {
    process.stderr.write(`error: backend command is required (pass it after "--")\n\n${HELP}`);
    process.exit(2);
  }

  let policy = {};
  try {
    if (opts.policyFile) policy = JSON.parse(fs.readFileSync(opts.policyFile, "utf8"));
    if (opts.policyJson) policy = { ...policy, ...JSON.parse(opts.policyJson) };
  } catch (e) {
    process.stderr.write(`error loading policy: ${e.message}\n`);
    process.exit(2);
  }

  let proxy;
  try {
    proxy = new CcsProxy({
      mode: opts.mode,
      backend: opts.backend,
      policy,
      verifierModule: opts.verifierModule,
      receiptsModule: opts.receiptsModule,
      verifyTimeoutMs: opts.verifyTimeoutMs,
      callerId: opts.callerId,
      logger: makeLogger(),
    });
  } catch (e) {
    process.stderr.write(`error initializing proxy: ${e.message}\n`);
    process.exit(2);
  }

  const stop = () => proxy.shutdown();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  process.stderr.write(
    `[ccs-mcp-proxy] mode=${proxy.mode} verifier=${proxy.verifier.source} ` +
      `timeout=${proxy.verifier.timeoutMs}ms backend=${opts.backend.command} ${opts.backend.args.join(" ")}\n`
  );
}

if (require.main === module) main();

module.exports = { parseArgs, tokenize };
