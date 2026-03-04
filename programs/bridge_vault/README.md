# Bridge Vault

The BridgeVaultProgram is located at [`../sol-bridge-lock`](../sol-bridge-lock/) (the existing Solana program, updated with ZK-compatible message IDs).

Changes from the original multisig-based design:
- `DepositEvent` now includes `message_id` (Keccak256 of domain-separated fields)
- `DepositRecord` stores `message_id`, `event_index`, and `asset_id`
- `compute_message_id()` function produces the canonical message ID that the ZK circuit proves
- Phase 1: Unlock still uses committee signatures + delay + caps
- Phase 2: Unlock will accept Groth16 proofs

See [`/spec/bridge-spec.md`](../../spec/bridge-spec.md) for the full specification.
