/**
 * Child process for Groth16 proof generation.
 *
 * Runs snarkjs.groth16.fullProve in a separate Node.js process so the main
 * event-loop stays responsive for health checks, P2P heartbeats, etc.
 * Using child_process.fork() (not worker_threads) because snarkjs internally
 * uses worker_threads and conflicts when run inside our own worker.
 *
 * Communication protocol (IPC messages):
 *   → { circuitInput, wasmPath, zkeyPath }
 *   ← { proof, publicSignals }          on success
 *   ← { error: string }                 on failure
 */

'use strict';
const snarkjs = require('snarkjs');

process.on('message', async (msg) => {
  try {
    const { circuitInput, wasmPath, zkeyPath } = msg;
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      wasmPath,
      zkeyPath,
    );
    process.send({ proof, publicSignals });
  } catch (err) {
    process.send({ error: err.message || String(err) });
  }
});

// Signal that we're ready
process.send({ ready: true });
