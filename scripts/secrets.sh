#!/usr/bin/env bash
#
# Load bridge secrets from the macOS Keychain into the environment.
#
# Keeps seeds and API keys out of .env and off the filesystem. The processes
# read them from the environment exactly as before, so nothing else changes.
#
#   ./scripts/secrets.sh store     # prompt for each secret, save to Keychain
#   ./scripts/secrets.sh check     # show which are present, never the values
#   source ./scripts/secrets.sh    # export them into the current shell
#
# For production use whatever the platform provides — Docker/Kubernetes secrets,
# Vault, AWS Secrets Manager — and inject the same variable names. The only rule
# is that the values arrive in the environment and are never written to a file.

set -euo pipefail

SERVICE="sol-gateway-dcc"
SECRETS=(
  DCC_VALIDATOR_SEED      # mints — the hot key
  DCC_ADMIN_SEED          # contract account: upgrades, caps, validator registry
  DCC_GUARDIAN_SEED       # emergency pause
  DCC_API_KEY
  INTERNAL_API_KEY        # validators -> API notify-complete
  SIGNER_ENCRYPTION_KEY   # encrypts the attestation key at rest
)

kc_get() { security find-generic-password -a "$SERVICE" -s "$1" -w 2>/dev/null || true; }
kc_put() { security add-generic-password -a "$SERVICE" -s "$1" -w "$2" -U; }

case "${1:-load}" in
  store)
    for name in "${SECRETS[@]}"; do
      existing="$(kc_get "$name")"
      if [ -n "$existing" ]; then
        printf '  %-24s already stored — press enter to keep, or paste a new value: ' "$name"
      else
        printf '  %-24s (leave blank to skip): ' "$name"
      fi
      read -rs value; echo
      [ -z "$value" ] && continue
      kc_put "$name" "$value"
      echo "     stored"
    done
    echo
    echo "Now remove these from .env — the processes read them from the environment."
    ;;

  check)
    echo "Keychain contents for '$SERVICE' (values never printed):"
    for name in "${SECRETS[@]}"; do
      v="$(kc_get "$name")"
      if [ -n "$v" ]; then
        printf '  %-24s present  (%d chars)\n' "$name" "${#v}"
      else
        printf '  %-24s MISSING\n' "$name"
      fi
    done
    ;;

  load|*)
    # Sourced: export into the caller's shell.
    for name in "${SECRETS[@]}"; do
      v="$(kc_get "$name")"
      [ -n "$v" ] && export "$name=$v"
    done
    ;;
esac
