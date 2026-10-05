"use strict";

/**
 * Newline-delimited JSON-RPC framing.
 *
 * MCP stdio transport encodes one JSON-RPC message per line (JSON.stringify
 * output contains no raw newlines). A server may split a message across
 * multiple writes or emit several messages in one chunk; this splitter keeps
 * a per-stream buffer and emits a callback for every complete, non-empty line.
 */
function createLineFramer(onLine) {
  let buffer = "";
  return function feed(chunk) {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length) {
        try {
          onLine(line);
        } catch (e) {
          // A buggy onLine must never corrupt the frame buffer; callers
          // handle errors themselves. Swallow defensively.
        }
      }
    }
  };
}

module.exports = { createLineFramer };
