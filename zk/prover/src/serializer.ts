/**
 * DCC <-> Solana ZK Bridge — Proof Serializer for RIDE Verifier
 *
 * FIX: ZK-M1 — Implements conversion from snarkjs JSON proof format
 * to the ByteVector format expected by RIDE's groth16Verify_8inputs.
 *
 * RIDE groth16Verify_8inputs(vk: ByteVector, proof: ByteVector, inputs: ByteVector):
 *
 * Proof encoding (192 bytes):
 *   - pi_a: G1 point (2 × 32 bytes = 64 bytes, big-endian field elements)
 *   - pi_b: G2 point (2 × 2 × 32 bytes = 128 bytes, big-endian field elements)
 *            Note: G2 point coordinates are (x_im, x_re, y_im, y_re) — imaginary first
 *   - pi_c: G1 point (2 × 32 bytes = 64 bytes, big-endian field elements)
 *   Total: 64 + 128 + 64 = 256 bytes
 *
 *   Wait — actually DCC/Waves uses a different layout:
 *   proof = pi_a.x(32) + pi_a.y(32) + pi_b.x_im(32) + pi_b.x_re(32) +
 *           pi_b.y_im(32) + pi_b.y_re(32) + pi_c.x(32) + pi_c.y(32)
 *   = 256 bytes
 *
 * Inputs encoding (256 bytes):
 *   - 8 field elements, each 32 bytes big-endian
 *
 * Verification key encoding:
 *   See DCC documentation for exact layout.
 */

/**
 * Convert a decimal string to a 32-byte big-endian Uint8Array.
 * BN128 field elements are integers < p ≈ 2^254, encoded as 32-byte BE.
 */
export function fieldElementToBytes(decStr: string): Uint8Array {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/**
 * Serialize snarkjs Groth16 proof to a flat ByteVector for RIDE.
 *
 * snarkjs proof format:
 *   pi_a: [x, y, "1"]        (G1 affine, projective z=1)
 *   pi_b: [[x_a1, x_a0], [y_a1, y_a0], ["1", "0"]]  (G2 affine)
 *   pi_c: [x, y, "1"]        (G1 affine)
 *
 * RIDE proof ByteVector (256 bytes):
 *   pi_a.x (32B) + pi_a.y (32B) +
 *   pi_b.x[0] (32B) + pi_b.x[1] (32B) + pi_b.y[0] (32B) + pi_b.y[1] (32B) +
 *   pi_c.x (32B) + pi_c.y (32B)
 *
 * Note: G2 coordinates in snarkjs are [imaginary, real] pairs.
 * DCC expects them in the same order.
 */
export function serializeProofForRIDE(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Uint8Array {
  const result = new Uint8Array(256);
  let offset = 0;

  // pi_a: G1 point (x, y)
  result.set(fieldElementToBytes(proof.pi_a[0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_a[1]), offset); offset += 32;

  // pi_b: G2 point ([x_im, x_re], [y_im, y_re])
  result.set(fieldElementToBytes(proof.pi_b[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_b[1][1]), offset); offset += 32;

  // pi_c: G1 point (x, y)
  result.set(fieldElementToBytes(proof.pi_c[0]), offset); offset += 32;
  result.set(fieldElementToBytes(proof.pi_c[1]), offset); offset += 32;

  return result;
}

/**
 * Serialize public signals array to RIDE inputs ByteVector.
 *
 * snarkjs publicSignals: string[] of 8 decimal field element values
 * Each is converted to a 32-byte big-endian encoding.
 *
 * RIDE inputs (256 bytes):
 *   signal[0] (32B) + signal[1] (32B) + ... + signal[7] (32B)
 *
 * Signal ordering matches the circuit's `component main {public [...]}`:
 *   [0] checkpoint_root_lo
 *   [1] checkpoint_root_hi
 *   [2] message_id_lo
 *   [3] message_id_hi
 *   [4] amount
 *   [5] recipient_lo
 *   [6] recipient_hi
 *   [7] version
 */
export function serializeInputsForRIDE(publicSignals: string[]): Uint8Array {
  if (publicSignals.length !== 8) {
    throw new Error(
      `Expected 8 public signals, got ${publicSignals.length}. ` +
      `The circuit must produce exactly 8 field-element public inputs.`
    );
  }

  const result = new Uint8Array(256);
  for (let i = 0; i < 8; i++) {
    result.set(fieldElementToBytes(publicSignals[i]), i * 32);
  }
  return result;
}

/**
 * Serialize a complete proof submission for the RIDE verifyAndMint function.
 * Returns proof bytes, inputs bytes, and the parsed values for convenience.
 */
export function serializeForRIDE(
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] },
  publicSignals: string[]
): {
  proofBytes: Uint8Array;
  inputsBytes: Uint8Array;
  proofHex: string;
  inputsHex: string;
} {
  const proofBytes = serializeProofForRIDE(proof);
  const inputsBytes = serializeInputsForRIDE(publicSignals);

  return {
    proofBytes,
    inputsBytes,
    proofHex: '0x' + Array.from(proofBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    inputsHex: '0x' + Array.from(inputsBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
  };
}

/**
 * Serialize the verification key for RIDE's groth16Verify_8inputs.
 *
 * VK layout (variable size, depends on number of IC points):
 *   alpha.x(32) + alpha.y(32)                    = 64B
 *   beta.x[0](32) + beta.x[1](32) + beta.y[0](32) + beta.y[1](32) = 128B
 *   gamma.x[0](32) + gamma.x[1](32) + gamma.y[0](32) + gamma.y[1](32) = 128B
 *   delta.x[0](32) + delta.x[1](32) + delta.y[0](32) + delta.y[1](32) = 128B
 *   IC[0..n]: each G1 point x(32) + y(32)        = (n+1) × 64B
 *
 * For 8 public inputs: IC has 9 points (IC[0] is constant term).
 * Total: 64 + 128 + 128 + 128 + 9×64 = 1024 bytes
 */
export function serializeVkForRIDE(vkey: {
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}): Uint8Array {
  const icCount = vkey.IC.length;
  const totalBytes = 64 + 128 + 128 + 128 + icCount * 64;
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  // alpha (G1)
  result.set(fieldElementToBytes(vkey.vk_alpha_1[0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_alpha_1[1]), offset); offset += 32;

  // beta (G2)
  result.set(fieldElementToBytes(vkey.vk_beta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_beta_2[1][1]), offset); offset += 32;

  // gamma (G2)
  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_gamma_2[1][1]), offset); offset += 32;

  // delta (G2)
  result.set(fieldElementToBytes(vkey.vk_delta_2[0][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[0][1]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][0]), offset); offset += 32;
  result.set(fieldElementToBytes(vkey.vk_delta_2[1][1]), offset); offset += 32;

  // IC points (G1)
  for (let i = 0; i < icCount; i++) {
    result.set(fieldElementToBytes(vkey.IC[i][0]), offset); offset += 32;
    result.set(fieldElementToBytes(vkey.IC[i][1]), offset); offset += 32;
  }

  return result;
}
