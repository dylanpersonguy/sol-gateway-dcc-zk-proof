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
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/${PTAU_FILE}"

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

echo "       Adding entropy for production security..."
echo "DCC_SOL_BRIDGE_V1_ZK_CEREMONY_$(date +%s)" | \
  snarkjs zkey contribute \
    "${BUILD_DIR}/${CIRCUIT}_0000.zkey" \
    "${BUILD_DIR}/${CIRCUIT}_final.zkey" \
    --name="DCC Bridge ZK Ceremony" \
    -v

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
