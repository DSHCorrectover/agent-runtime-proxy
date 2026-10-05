"use strict";

/**
 * CCS verifier adapter.
 *
 * The proxy reuses the pure verifyCall implementation from ccs-mcp-server
 * (NOT a child process — a direct in-process function call, so there is no
 * extra JSON-RPC hop). The default resolution order:
 *
 *   1. explicit module path from options/--verifier-module
 *   2. ../ccs-mcp-server-m8ven-fix/src/index.js next to this project
 *   3. require.resolve("ccs-mcp-server") (a declared dependency, if installed)
 *
 * A custom module must export either { verifyCall(call, policy) -> receipt }
 * or { verify(call, policy, ctx) -> receipt|Promise<receipt> }.
 *
 * Fail-closed semantics (Microsoft AGT): if the verifier throws, is
 * unavailable, or does not settle within `timeoutMs`, the proxy treats the
 * call as denied. For verifier failures (as opposed to a legitimate denied
 * verdict) we additionally sign an internal denial receipt with reason
 * verifier_unavailable / verifier_timeout when the receipts module loads.
 */

const path = require("path");

const DEFAULT_CCS_DIR = path.join(__dirname, "..", "..", "ccs-mcp-server-m8ven-fix", "src");
const GUARD_PACKAGE = "agent-runtime-guard";

function loadVerifierModule(explicitPath) {
  const tried = [];

  if (explicitPath) {
    tried.push(explicitPath);
    // eslint-disable-next-line global-require
    return { mod: require(path.resolve(explicitPath)), source: explicitPath };
  }

  const indexPath = path.join(DEFAULT_CCS_DIR, "index.js");
  tried.push(indexPath);
  try {
    // eslint-disable-next-line global-require
    return { mod: require(indexPath), source: indexPath };
  } catch (e) {
    // fall through
  }

  try {
    // eslint-disable-next-line global-require
    const mod = require(GUARD_PACKAGE);
    return { mod, source: GUARD_PACKAGE };
  } catch (e) {
    tried.push(GUARD_PACKAGE);
    try {
      // eslint-disable-next-line global-require
      const mod = require("ccs-mcp-server");
      return { mod, source: "ccs-mcp-server" };
    } catch (e2) {
      tried.push("ccs-mcp-server");
      const err = new Error(
        `Verifier module not found. Tried: ${tried.join(", ")}. ` +
        `Set --verifier-module or CCS_VERIFIER_MODULE. Original error: ${e2.message}`
      );
      err.code = "CCS_VERIFIER_MISSING";
      throw err;
    }
  }
}

function loadReceipts(explicitPath) {
  if (explicitPath === false) return null;
  if (explicitPath) {
    try {
      // eslint-disable-next-line global-require
      return require(path.resolve(explicitPath));
    } catch {
      return null;
    }
  }
  try {
    // eslint-disable-next-line global-require
    return require(path.join(DEFAULT_CCS_DIR, "receipts.js"));
  } catch {
    return null;
  }
}

function createVerifier(options = {}) {
  // Lazy internals: requiring the verifier module from Coze Drive can take
  // hundreds of milliseconds. Keeping it lazy lets the proxy answer
  // initialize/tools/list instantly; the first tools/call triggers load and
  // a load failure is handled as fail-closed DENY by the proxy.
  let internals = null;
  let loadError = null;
  let loading = null;

  function load() {
    if (internals) return Promise.resolve(internals);
    if (loadError) return Promise.resolve({ error: loadError });
    if (loading) return loading;

    loading = new Promise((resolve) => {
      // Defer to the next tick so a synchronous require never blocks the
      // construction/wiring phase (require itself is synchronous and slow,
      // but this wrapper returns immediately).
      setImmediate(() => {
        try {
          const { mod, source } = loadVerifierModule(
            options.modulePath || process.env.CCS_VERIFIER_MODULE
          );
          const receipts = loadReceipts(
            options.receiptsPath !== undefined ? options.receiptsPath : undefined
          );
          const verifyFn =
            typeof mod.verify === "function"
              ? (call, policy, ctx) => mod.verify(call, policy, ctx)
              : typeof mod.verifyCall === "function"
                ? (call, policy) => mod.verifyCall(call, policy)
                : null;
          if (!verifyFn) {
            throw new Error(`CCS verifier module ${source} exports neither verify() nor verifyCall()`);
          }
          internals = { receipts, verifyFn, source };
          resolve(internals);
        } catch (e) {
          loadError = e;
          resolve({ error: e });
        } finally {
          loading = null;
        }
      });
    });
    return loading;
  }

  const timeoutMs = Math.max(1, Number(options.timeoutMs || process.env.CCS_VERIFY_TIMEOUT_MS || 2000));
  const policy = options.policy || {};

  function signFailureReceipt(call, reason, detail, receiptsMod) {
    const rc = receiptsMod || (internals && internals.receipts);
    if (!rc || typeof rc.signReceipt !== "function") return null;
    try {
      return rc.signReceipt({
        evidence_type: "ccs.tool_call.verification",
        evidence_id: require("crypto").randomUUID(),
        tool: call.tool,
        caller: call.caller?.agent_id || "unknown",
        verdict: "denied",
        denied_by: "proxy_fail_closed",
        denial_reason: reason,
        detail,
        dimensions: {
          Structure: { status: "pass" },
          Schema: { status: "pass" },
          Security: { status: "pass" },
          Identity: { status: "pass" },
          Latency: { status: "pass" },
          Cost: { status: "pass" },
          Integrity: { status: "fail", reason },
        },
        issued_at: new Date().toISOString(),
      });
    } catch {
      return null;
    }
  }

  /**
   * Returns { ok: true, receipt } on a settled verifier result, or
   * { ok: false, reason, receipt? } when the verifier failed to load or did
   * not settle in time. Failure results are always interpreted as DENY.
   */
  async function verify(call, ctx) {
    const loaded = await load();
    if (loaded && loaded.error) {
      return {
        ok: false,
        reason: "verifier_unavailable",
        detail: loaded.error.message,
        receipt: signFailureReceipt(call, "verifier_unavailable", loaded.error.message, null),
      };
    }
    const { receipts: rc, verifyFn: vf, source } = loaded;

    let timer;
    let timedOut = false;

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ __timeout: true });
      }, timeoutMs);
    });

    let work;
    try {
      work = Promise.resolve(vf(call, policy, ctx));
    } catch (e) {
      clearTimeout(timer);
      return {
        ok: false,
        reason: "verifier_unavailable",
        detail: e.message,
        receipt: signFailureReceipt(call, "verifier_unavailable", e.message, rc),
      };
    }

    return Promise.race([work, timeoutPromise]).then(
      (result) => {
        clearTimeout(timer);
        if (timedOut || (result && result.__timeout)) {
          return {
            ok: false,
            reason: "verifier_timeout",
            detail: `verifier did not settle within ${timeoutMs}ms`,
            receipt: signFailureReceipt(call, "verifier_timeout", `>${timeoutMs}ms`, rc),
          };
        }
        if (!result || typeof result !== "object" || typeof result.verdict !== "string") {
          return {
            ok: false,
            reason: "verifier_unavailable",
            detail: "verifier returned no usable verdict",
            receipt: signFailureReceipt(call, "verifier_unavailable", "missing verdict", rc),
          };
        }
        return { ok: true, receipt: result };
      },
      (e) => {
        clearTimeout(timer);
        return {
          ok: false,
          reason: "verifier_unavailable",
          detail: e.message,
          receipt: signFailureReceipt(call, "verifier_unavailable", e.message, rc),
        };
      }
    );
  }

  /**
   * Execution receipt: signed proof of what the backend actually returned.
   * Falls back to a lightweight local receipt if no receipts module/signing
   * function is available.
   */
  function signExecution(call, exec) {
    const crypto = require("crypto");
    const rc = internals && internals.receipts;
    const body = {
      evidence_type: "ccs.tool_execution.evidence",
      evidence_id: crypto.randomUUID(),
      tool: call.tool,
      caller: call.caller?.agent_id || "unknown",
      result_hash:
        "sha256:" + crypto.createHash("sha256").update(canonicalOrJson(exec.result, rc)).digest("hex"),
      transport_error: !!exec.isTransportError,
      execution_time_us: Math.round(exec.elapsedMs * 1000),
      proxy_mode: options.mode || "enforce",
      issued_at: new Date().toISOString(),
    };
    if (call.verification_receipt?.evidence_hash) {
      body.verification_evidence_hash = call.verification_receipt.evidence_hash;
    }
    if (rc && typeof rc.signReceipt === "function") {
      try {
        return rc.signReceipt(body);
      } catch {
        /* fall through to unsigned */
      }
    }
    body.unsigned = true;
    return body;
  }

  function canonicalOrJson(obj, rc) {
    const rcm = rc || (internals && internals.receipts);
    if (rcm && typeof rcm.canonical === "function") {
      try {
        return rcm.canonical(obj);
      } catch {
        /* ignore */
      }
    }
    return JSON.stringify(obj);
  }

  return {
    verify,
    signExecution,
    timeoutMs,
    preload: load,
    get ready() {
      return !!internals;
    },
    get source() {
      return internals ? internals.source : "(lazy, not loaded)";
    },
  };
}

module.exports = { createVerifier, loadVerifierModule };
