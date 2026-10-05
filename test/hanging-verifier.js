"use strict";

/**
 * Test verifier that never settles — used to prove the proxy fails closed
 * when the verifier exceeds its timeout budget.
 */
module.exports = {
  verify() {
    return new Promise(() => {}); // intentionally hangs forever
  },
};
