#!/bin/bash
# DCC <-> Solana ZK Bridge — Circuit Build Script
#
# Compiles Circom circuits and generates Groth16 proving artifacts.
#
# Prerequisites:
#   - circom 2.1.0+ installed (cargo install circom)
#   - snarkjs installed (npm install -g snarkjs)
#   - Powers of Tau ceremony file (ptau)
#
# Output:
#   build/bridge_deposit.r1cs
#   build/bridge_deposit_js/bridge_deposit.wasm
#   build/bridge_deposit_final.zkey
#   build/verification_key.json
#
# Usage:
#   cd zk/circuits && chmod +x build.sh && ./build.sh

set -euo pipefail

CIRCUIT="bridge_deposit"
BUILD_DIR="build"
PTAU_FILE="powersOfTau28_hez_final_22.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/${PTAU_FILE}"

echo "================================================================"
echo "  DCC <-> Solana ZK Bridge — Circuit Builder (Groth16/BN128)"
echo "================================================================"
echo

# ── Check dependencies ──────────────────────────────────────
command -v circom >/dev/null 2>&1 || {
  echo "ERROR: circom not found. Install: cargo install circom"
  exit 1
}
command -v snarkjs >/dev/null 2>&1 || {
  echo "ERROR: snarkjs not found. Install: npm install -g snarkjs"
  exit 1
}

echo "[1/7] Dependencies OK: circom $(circom --version 2>/dev/null || echo 'unknown'), snarkjs"

# ── Create build directory ──────────────────────────────────
mkdir -p "$BUILD_DIR"

# ── Download Powers of Tau (if needed) ──────────────────────
if [ ! -f "${BUILD_DIR}/${PTAU_FILE}" ]; then
  echo "[2/7] Downloading Powers of Tau (this may take a while)..."
  echo "       URL: ${PTAU_URL}"
  curl -L -o "${BUILD_DIR}/${PTAU_FILE}" "${PTAU_URL}"
else
  echo "[2/7] Powers of Tau file found: ${BUILD_DIR}/${PTAU_FILE}"
fi

# ── Compile circuit ─────────────────────────────────────────
echo "[3/7] Compiling circuit: ${CIRCUIT}.circom"
echo "       TREE_DEPTH=20, Keccak256, BN128"

circom "${CIRCUIT}.circom" \
  --r1cs \
  --wasm \
  --sym \
  -o "$BUILD_DIR" \
  -l ./node_modules

echo "       R1CS: ${BUILD_DIR}/${CIRCUIT}.r1cs"
echo "       WASM: ${BUILD_DIR}/${CIRCUIT}_js/${CIRCUIT}.wasm"

# ── Print circuit info ──────────────────────────────────────
echo "[4/7] Circuit info:"
snarkjs r1cs info "${BUILD_DIR}/${CIRCUIT}.r1cs"

# ── Phase 2 setup (circuit-specific) ───────────────────────
echo "[5/7] Groth16 setup (Phase 2)..."
snarkjs groth16 setup \
  "${BUILD_DIR}/${CIRCUIT}.r1cs" \
  "${BUILD_DIR}/${PTAU_FILE}" \
  "${BUILD_DIR}/${CIRCUIT}_0000.zkey"

# ── Multi-party ceremony contributions ─────────────────────
# SECURITY: Use /dev/urandom for cryptographic entropy, NOT just timestamps.
# In production, run multiple independent contributions from different
# machines/operators. Security requires only ONE honest contributor.
#
# ═══════════════════════════════════════════════════════════
# SINGLE-MACHINE DEVELOPMENT SETUP (NOT FOR PRODUCTION!)
# ═══════════════════════════════════════════════════════════
#
# WARNING: This automated setup runs ALL contributions on a single
# machine. For PRODUCTION deployment, use the multi-party ceremony:
#
#   ./ceremony.sh init           # Coordinator initializes
#   ./ceremony.sh contribute X   # Each contributor (SEPARATE MACHINE)
#   ./ceremony.sh finalize       # Coordinator applies beacon
#   ./ceremony.sh verify         # Anyone can verify
#
# The Groth16 trusted setup is ONLY secure if at least one
# contributor is honest and destroys their entropy. Running
# all contributions on one machine means a single compromise
# of that machine breaks ALL ceremony guarantees.
#
# ═══════════════════════════════════════════════════════════

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║  WARNING: Single-machine development ceremony.       ║"
echo "  ║  For production use: ./ceremony.sh (MPC protocol)    ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""

# Contribution 1: Automated with cryptographic randomness
echo "       Contribution 1: cryptographic randomness (/dev/urandom)..."
ENTROPY_1=$(head -c 64 /dev/urandom | base64)
echo "${ENTROPY_1}" | \
  snarkjs zkey contribute \
    "${BUILD_DIR}/${CIRCUIT}_0000.zkey" \
    "${BUILD_DIR}/${CIRCUIT}_0001.zkey" \
    --name="DCC Bridge Ceremony - Dev Contributor 1 (automated)" \
    -v
ENTROPY_1=""  # Clear entropy from memory

# Contribution 2: Additional entropy source (system state + random)
echo "       Contribution 2: additional entropy source..."
ENTROPY_2="$(date +%s%N)_$(head -c 64 /dev/urandom | base64)_$(hostname)_$$"
echo "${ENTROPY_2}" | \
  snarkjs zkey contribute \
    "${BUILD_DIR}/${CIRCUIT}_0001.zkey" \
    "${BUILD_DIR}/${CIRCUIT}_0002.zkey" \
    --name="DCC Bridge Ceremony - Dev Contributor 2 (automated)" \
    -v
ENTROPY_2=""  # Clear entropy from memory

# Apply random beacon
# NOTE: For production, use a PUBLIC verifiable beacon source:
#   - Future Ethereum block hash (commit to block number in advance)
#   - drand randomness beacon (https://drand.love)
#   - National lottery draw results
echo "       Applying random beacon contribution..."
BEACON_ENTROPY=$(head -c 32 /dev/urandom | xxd -p -c 64)
snarkjs zkey beacon \
  "${BUILD_DIR}/${CIRCUIT}_0002.zkey" \
  "${BUILD_DIR}/${CIRCUIT}_final.zkey" \
  "${BEACON_ENTROPY}" \
  10 \
  --name="DCC Bridge Ceremony - Dev Beacon"
echo "       Beacon hash: ${BEACON_ENTROPY:0:32}..."
BEACON_ENTROPY=""  # Clear from memory

# Clean up intermediate zkeys
rm -f "${BUILD_DIR}/${CIRCUIT}_0000.zkey" \
      "${BUILD_DIR}/${CIRCUIT}_0001.zkey" \
      "${BUILD_DIR}/${CIRCUIT}_0002.zkey"

echo "       Phase 2 complete: 2 dev contributions + beacon applied"
echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  FOR PRODUCTION: Run multi-party ceremony       │"
echo "  │  See: ./ceremony.sh --help                      │"
echo "  │  Minimum: 3+ independent contributors           │"
echo "  │  on SEPARATE machines + public beacon            │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ── Export verification key ─────────────────────────────────
echo "[6/7] Exporting verification key..."
snarkjs zkey export verificationkey \
  "${BUILD_DIR}/${CIRCUIT}_final.zkey" \
  "${BUILD_DIR}/verification_key.json"

echo "       VK: ${BUILD_DIR}/verification_key.json"

# ── Verify zkey ──────────────────────────────────────────────
echo "[7/7] Verifying zkey against r1cs and ptau..."
snarkjs zkey verify \
  "${BUILD_DIR}/${CIRCUIT}.r1cs" \
  "${BUILD_DIR}/${PTAU_FILE}" \
  "${BUILD_DIR}/${CIRCUIT}_final.zkey"

echo
echo "================================================================"
echo "  BUILD COMPLETE"
echo "================================================================"
echo
echo "Artifacts:"
echo "  R1CS:              ${BUILD_DIR}/${CIRCUIT}.r1cs"
echo "  WASM:              ${BUILD_DIR}/${CIRCUIT}_js/${CIRCUIT}.wasm"
echo "  Proving Key:       ${BUILD_DIR}/${CIRCUIT}_final.zkey"
echo "  Verification Key:  ${BUILD_DIR}/verification_key.json"
echo
echo "Test with:"
echo "  snarkjs groth16 prove ${BUILD_DIR}/${CIRCUIT}_final.zkey ${BUILD_DIR}/${CIRCUIT}_js/witness.wtns proof.json public.json"
echo
echo "To generate Solidity verifier (for future on-chain verification):"
echo "  snarkjs zkey export solidityverifier ${BUILD_DIR}/${CIRCUIT}_final.zkey verifier.sol"
echo
