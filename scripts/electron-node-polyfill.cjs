/**
 * Preloaded with `-r` when vitest runs under Electron-as-Node (ABI 109,
 * Node 16.16). Vite/Vitest expect Node 18+ crypto surface; Node 16 only
 * exposes it behind `crypto.webcrypto`. This bridges the gap without
 * touching production code paths.
 */
const nodeCrypto = require('crypto');

if (nodeCrypto.webcrypto) {
  if (typeof nodeCrypto.getRandomValues !== 'function') {
    nodeCrypto.getRandomValues = function getRandomValues(array) {
      return nodeCrypto.webcrypto.getRandomValues.call(nodeCrypto.webcrypto, array);
    };
  }
  if (!nodeCrypto.subtle) {
    nodeCrypto.subtle = nodeCrypto.webcrypto.subtle;
  }
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = nodeCrypto.webcrypto;
  }
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    // Node 16 webcrypto lacks randomUUID; Node >=16.7 has crypto.randomUUID.
    globalThis.crypto.randomUUID = require('crypto').randomUUID;
  }
}
