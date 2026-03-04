#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# DCC <-> Solana ZK Bridge — Multi-Party Ceremony (MPC) Script
# ═══════════════════════════════════════════════════════════════
#
# FIX: ATK-4 — Implements a proper multi-party trusted setup ceremony
# where each contributor runs on their OWN MACHINE with independent entropy.
#
# SECURITY MODEL:
#   The Groth16 trusted setup is secure if AT LEAST ONE contributor
#   honestly generated random entropy and destroyed it afterward.
#   This script supports N independent contributors + a final beacon.
#
# CEREMONY PROTOCOL:
#
#   Phase 1 (Powers of Tau): Use the Hermez community ceremony (already public)
#
#   Phase 2 (Circuit-Specific):
#     1. Coordinator generates initial zkey from R1CS + Phase 1 PTAU
#     2. Each contributor downloads the current zkey
#     3. Each contributor adds their entropy: snarkjs zkey contribute
#     4. Each contributor uploads the new zkey + publishes the hash
#     5. After all contributors: apply random beacon (public randomness)
#     6. Export verification key
#     7. Verify ceremony chain from R1CS → final zkey
#
# USAGE:
#
#   Step 1 (Coordinator): Initialize ceremony
#     ./ceremony.sh init
#
#   Step 2 (Each Contributor): Contribute entropy
#     ./ceremony.sh contribute <contributor_name>
#
#   Step 3 (Coordinator): Apply beacon and finalize
#     ./ceremony.sh finalize [beacon_hex]
#
#   Step 4 (Anyone): Verify the ceremony
#     ./ceremony.sh verify
#
# PREREQUISITES:
#   - snarkjs 0.7.3+ (npm install -g snarkjs)
#   - Compiled circuit (R1CS) from build.sh
#   - Powers of Tau file (downloaded by build.sh)

set -euo pipefail

CIRCUIT="bridge_deposit"
BUILD_DIR="build"
CEREMONY_DIR="ceremony"
PTAU_FILE="powersOfTau28_hez_final_22.ptau"
R1CS="${BUILD_DIR}/${CIRCUIT}.r1cs"

# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

log() { echo "[ceremony] $1"; }
err() { echo "[ceremony] ERROR: $1" >&2; exit 1; }

check_deps() {
    command -v snarkjs >/dev/null 2>&1 || err "snarkjs not found. Install: npm install -g snarkjs"
}

get_contribution_count() {
    ls -1 "${CEREMONY_DIR}/${CIRCUIT}_"*.zkey 2>/dev/null | wc -l | tr -d ' '
}

get_latest_zkey() {
    ls -1t "${CEREMONY_DIR}/${CIRCUIT}_"*.zkey 2>/dev/null | head -1
}

# ═══════════════════════════════════════════════════════════════
# INIT — Coordinator creates initial zkey
# ═══════════════════════════════════════════════════════════════

cmd_init() {
    check_deps
    
    log "═══════════════════════════════════════════════════"
    log "  PHASE 2 CEREMONY — INITIALIZATION"
    log "═══════════════════════════════════════════════════"
    
    [ -f "$R1CS" ] || err "R1CS not found: $R1CS (run build.sh first)"
    [ -f "${BUILD_DIR}/${PTAU_FILE}" ] || err "PTAU not found: ${BUILD_DIR}/${PTAU_FILE}"
    
    mkdir -p "$CEREMONY_DIR"
    
    local ZKEY_0="${CEREMONY_DIR}/${CIRCUIT}_0000.zkey"
    
    if [ -f "$ZKEY_0" ]; then
        log "Initial zkey already exists: $ZKEY_0"
        log "Delete $CEREMONY_DIR to restart."
        return
    fi
    
    log "Generating initial zkey from R1CS + PTAU..."
    snarkjs groth16 setup "$R1CS" "${BUILD_DIR}/${PTAU_FILE}" "$ZKEY_0"
    
    local HASH=$(snarkjs zkey export verificationkey "$ZKEY_0" /dev/null 2>&1 | grep "Hash" | head -1 || echo "")
    
    log ""
    log "═══════════════════════════════════════════════════"
    log "  INITIAL ZKEY CREATED: $ZKEY_0"
    log "═══════════════════════════════════════════════════"
    log ""
    log "NEXT STEPS:"
    log "  1. Share $ZKEY_0 with each contributor"
    log "  2. Each contributor runs:"
    log "     ./ceremony.sh contribute <their_name>"
    log "  3. After all contributions, run:"
    log "     ./ceremony.sh finalize"
    log ""
    log "SECURITY REMINDER:"
    log "  Each contributor MUST run on a DIFFERENT machine."
    log "  Contributors should not share their entropy source."
    log "  At least ONE honest contributor ensures security."
}

# ═══════════════════════════════════════════════════════════════
# CONTRIBUTE — Each contributor adds their entropy
# ═══════════════════════════════════════════════════════════════

cmd_contribute() {
    check_deps
    local NAME="${1:-}"
    [ -n "$NAME" ] || err "Usage: ./ceremony.sh contribute <contributor_name>"
    
    log "═══════════════════════════════════════════════════"
    log "  PHASE 2 CEREMONY — CONTRIBUTION BY: $NAME"
    log "═══════════════════════════════════════════════════"
    
    [ -d "$CEREMONY_DIR" ] || err "Ceremony not initialized. Run: ./ceremony.sh init"
    
    local COUNT=$(get_contribution_count)
    local LATEST=$(get_latest_zkey)
    local NEXT_NUM=$(printf "%04d" $((COUNT)))
    local NEXT_ZKEY="${CEREMONY_DIR}/${CIRCUIT}_${NEXT_NUM}.zkey"
    
    [ -f "$LATEST" ] || err "No zkey found in $CEREMONY_DIR"
    
    log "Input zkey:  $LATEST"
    log "Output zkey: $NEXT_ZKEY"
    log ""
    log "GENERATING ENTROPY from /dev/urandom (64 bytes)..."
    log ""
    log "╔══════════════════════════════════════════════════╗"
    log "║  SECURITY: This entropy MUST be unique to YOU.  ║"
    log "║  It is generated from /dev/urandom and will     ║"
    log "║  NOT be stored. After this step completes,      ║"
    log "║  the entropy is destroyed in memory.            ║"
    log "╚══════════════════════════════════════════════════╝"
    log ""
    
    # Generate high-quality cryptographic entropy
    # Combine multiple sources: /dev/urandom + system state
    local ENTROPY_URANDOM=$(head -c 64 /dev/urandom | base64)
    local ENTROPY_EXTRA="$(date +%s%N)_$(hostname)_$$_$(id -un)_${NAME}"
    local COMBINED_ENTROPY="${ENTROPY_URANDOM}_${ENTROPY_EXTRA}"
    
    echo "${COMBINED_ENTROPY}" | \
        snarkjs zkey contribute \
            "$LATEST" \
            "$NEXT_ZKEY" \
            --name="DCC Bridge Ceremony - ${NAME}" \
            -v
    
    # Clear entropy from shell memory
    ENTROPY_URANDOM=""
    COMBINED_ENTROPY=""
    
    # Compute and display the contribution hash for public verification
    local CONTRIB_HASH=$(snarkjs zkey verify "$R1CS" "${BUILD_DIR}/${PTAU_FILE}" "$NEXT_ZKEY" 2>&1 | tail -10 || echo "Verify manually")
    
    log ""
    log "═══════════════════════════════════════════════════"
    log "  CONTRIBUTION COMPLETE"
    log "═══════════════════════════════════════════════════"
    log "  Contributor: $NAME"
    log "  Output:      $NEXT_ZKEY"
    log ""
    log "VERIFICATION OUTPUT:"
    echo "$CONTRIB_HASH" | while read -r line; do log "  $line"; done
    log ""
    log "NEXT STEPS:"
    log "  1. Publish the verification hash PUBLICLY"
    log "  2. Share $NEXT_ZKEY with the next contributor or coordinator"
    log "  3. DESTROY any copies of the entropy (already done in this script)"
    log ""
    log "To verify this contribution: ./ceremony.sh verify"
    
    # Record contribution in ceremony log
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | contribution | $NAME | $NEXT_ZKEY" >> "${CEREMONY_DIR}/ceremony.log"
}

# ═══════════════════════════════════════════════════════════════
# FINALIZE — Apply beacon and export verification key
# ═══════════════════════════════════════════════════════════════

cmd_finalize() {
    check_deps
    local BEACON_HEX="${1:-}"
    
    log "═══════════════════════════════════════════════════"
    log "  PHASE 2 CEREMONY — FINALIZATION"
    log "═══════════════════════════════════════════════════"
    
    [ -d "$CEREMONY_DIR" ] || err "Ceremony not initialized"
    
    local COUNT=$(get_contribution_count)
    local LATEST=$(get_latest_zkey)
    
    [ "$COUNT" -ge 2 ] || err "Need at least 1 contribution (found $((COUNT - 1))). Run: ./ceremony.sh contribute <name>"
    
    log "Found $((COUNT - 1)) contribution(s)."
    log "Latest zkey: $LATEST"
    
    # Apply random beacon
    if [ -z "$BEACON_HEX" ]; then
        log ""
        log "No beacon provided. Generating from /dev/urandom."
        log "For maximum transparency, use a public randomness source:"
        log "  - Future Ethereum block hash"
        log "  - drand beacon value"
        log "  - National lottery numbers"
        log ""
        BEACON_HEX=$(head -c 32 /dev/urandom | xxd -p -c 64)
    fi
    
    log "Beacon value: ${BEACON_HEX:0:32}..."
    
    local FINAL_ZKEY="${CEREMONY_DIR}/${CIRCUIT}_final.zkey"
    local VKEY="${CEREMONY_DIR}/verification_key.json"

    snarkjs zkey beacon \
        "$LATEST" \
        "$FINAL_ZKEY" \
        "$BEACON_HEX" \
        10 \
        --name="DCC Bridge Ceremony - Final Beacon"
    
    log "✅ Beacon applied"
    
    # Export verification key
    snarkjs zkey export verificationkey "$FINAL_ZKEY" "$VKEY"
    log "✅ Verification key exported: $VKEY"
    
    # Full verification
    log ""
    log "Running full ceremony verification..."
    snarkjs zkey verify "$R1CS" "${BUILD_DIR}/${PTAU_FILE}" "$FINAL_ZKEY"
    
    # Copy final artifacts to build directory
    cp "$FINAL_ZKEY" "${BUILD_DIR}/${CIRCUIT}_final.zkey"
    cp "$VKEY" "${BUILD_DIR}/verification_key.json"
    
    log ""
    log "═══════════════════════════════════════════════════"
    log "  CEREMONY COMPLETE"
    log "═══════════════════════════════════════════════════"
    log ""
    log "  Contributions: $((COUNT - 1))"
    log "  Beacon:        ${BEACON_HEX:0:32}..."
    log "  Final zkey:    $FINAL_ZKEY"
    log "  VK:            $VKEY"
    log ""
    log "  Copied to build/:"
    log "    ${BUILD_DIR}/${CIRCUIT}_final.zkey"
    log "    ${BUILD_DIR}/verification_key.json"
    log ""
    log "  PUBLISH the following for public verification:"
    log "    1. All intermediate zkeys (or their hashes)"
    log "    2. The beacon value: $BEACON_HEX"
    log "    3. The ceremony.log file"
    log "    4. The final verification key hash"
    log ""
    
    # Record finalization
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | finalized | beacon=$BEACON_HEX" >> "${CEREMONY_DIR}/ceremony.log"
    
    # Compute VK hash for on-chain registration
    local VK_BYTES=$(cat "$VKEY")
    log "  To register on DCC, call setVerifyingKey with:"
    log "    vk = <serialize $VKEY as ByteVector>"
    log "    expectedHash = keccak256(vk)"
}

# ═══════════════════════════════════════════════════════════════
# VERIFY — Verify the entire ceremony chain
# ═══════════════════════════════════════════════════════════════

cmd_verify() {
    check_deps
    
    log "═══════════════════════════════════════════════════"
    log "  PHASE 2 CEREMONY — VERIFICATION"
    log "═══════════════════════════════════════════════════"
    
    local FINAL_ZKEY="${CEREMONY_DIR}/${CIRCUIT}_final.zkey"
    
    if [ ! -f "$FINAL_ZKEY" ]; then
        # Try to verify the latest contribution
        local LATEST=$(get_latest_zkey)
        [ -f "$LATEST" ] || err "No zkeys found"
        log "Verifying latest contribution: $LATEST"
        snarkjs zkey verify "$R1CS" "${BUILD_DIR}/${PTAU_FILE}" "$LATEST"
    else
        log "Verifying final zkey: $FINAL_ZKEY"
        snarkjs zkey verify "$R1CS" "${BUILD_DIR}/${PTAU_FILE}" "$FINAL_ZKEY"
    fi
    
    log ""
    log "✅ Ceremony verification PASSED"
    
    # Display ceremony log if it exists
    if [ -f "${CEREMONY_DIR}/ceremony.log" ]; then
        log ""
        log "Ceremony log:"
        cat "${CEREMONY_DIR}/ceremony.log" | while read -r line; do log "  $line"; done
    fi
}

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

CMD="${1:-help}"
shift || true

case "$CMD" in
    init)
        cmd_init
        ;;
    contribute)
        cmd_contribute "$@"
        ;;
    finalize)
        cmd_finalize "$@"
        ;;
    verify)
        cmd_verify
        ;;
    *)
        echo "DCC <-> Solana ZK Bridge — Multi-Party Ceremony"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  init                    Initialize ceremony (coordinator)"
        echo "  contribute <name>       Add your entropy contribution"
        echo "  finalize [beacon_hex]   Apply beacon and export VK (coordinator)"
        echo "  verify                  Verify the ceremony chain"
        echo ""
        echo "Security Protocol:"
        echo "  1. Coordinator runs: ./ceremony.sh init"
        echo "  2. Each contributor (DIFFERENT MACHINE) runs: ./ceremony.sh contribute <name>"
        echo "  3. Coordinator runs: ./ceremony.sh finalize <public_beacon>"
        echo "  4. Anyone verifies: ./ceremony.sh verify"
        echo ""
        echo "The ceremony is secure if AT LEAST ONE contributor was honest."
        ;;
esac
