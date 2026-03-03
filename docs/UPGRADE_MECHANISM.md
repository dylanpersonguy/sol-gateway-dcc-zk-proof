# Upgrade Mechanism

## Principles

1. **No breaking changes without multi-sig approval**
2. **Backward compatibility for at least 1 version**
3. **Blue-green deployment for off-chain components**
4. **On-chain upgrades require full audit of diff**
5. **Rollback capability for all components**

---

## Solana Program Upgrades

### Upgrade Authority

The Solana program uses the BPF Upgradeable Loader. The upgrade authority
is a **multi-sig wallet** requiring 2-of-3 signers:

| Signer | Role |
|--------|------|
| Authority A | Primary operator |
| Authority B | Secondary operator |
| Authority C | Emergency key (cold storage) |

### Upgrade Process

```bash
# 1. Build new program version
anchor build

# 2. Verify the build (reproducible builds)
anchor verify <PROGRAM_ID>

# 3. Deploy buffer
solana program write-buffer target/deploy/sol_bridge_lock.so

# 4. Verify buffer matches expected hash
solana program show-buffer <BUFFER_ADDRESS>

# 5. Multi-sig upgrade
#    Each signer approves the upgrade transaction
#    The Squads multi-sig executes the upgrade

# 6. Verify deployment
anchor verify <PROGRAM_ID>
```

### State Migration

If the upgrade changes account structures:

1. Add new fields at the end (don't change existing field order)
2. Use `_reserved` space for new fields
3. Implement migration instruction if needed
4. Run migration before enabling new features

### Rollback

```bash
# Set upgrade authority back to old buffer if needed
# This requires the multi-sig approval
solana program set-buffer <PROGRAM_ID> <OLD_BUFFER>
```

---

## DCC Contract Upgrades

### Process

1. Deploy new contract version to a new account
2. Test on testnet with full integration suite
3. Multi-sig approval to update bridge address
4. Call `updateBridgeContract()` on wSOL token
5. Migrate state from old contract to new
6. Redirect validators to watch new contract
7. Keep old contract active for in-flight transfers

### State Migration

```
# On DCC, state migration is handled via:
1. Read all state from old contract
2. Initialize new contract with migrated state
3. Verify state consistency
4. Switch over
```

---

## Validator Upgrades

### Rolling Upgrade

```
1. Announce maintenance window
2. Upgrade validator-1 → test consensus with 4 remaining
3. Verify validator-1 healthy
4. Upgrade validator-2 → test consensus
5. Continue for all validators
6. Post-upgrade integration test
```

### Version Compatibility

Validators must handle:
- Messages from previous version (backward compat)
- Mixed-version consensus rounds
- Graceful rejection of unknown message types

### Configuration Changes

Config changes (rate limits, thresholds) can be applied:
- **Per-validator:** Update `.env` and restart
- **On-chain:** Call `update_config` instruction with multi-sig

---

## API Server Upgrades

Standard blue-green deployment:

1. Deploy new version to staging
2. Run full test suite
3. Switch load balancer to new version
4. Monitor for errors
5. Keep old version hot for 1 hour
6. Decommission old version

---

## Frontend Upgrades

1. Build new version
2. Upload to CDN
3. Users automatically receive new version on next page load
4. No downtime deployment

---

## Emergency Hotfix Process

For critical security fixes:

1. **Pause bridge** immediately (guardian key)
2. Develop and test fix (internal only)
3. Security review by at least 2 engineers
4. Deploy fix using standard upgrade process
5. Verify fix on devnet
6. Deploy to mainnet
7. Resume bridge
8. Post-mortem within 48 hours

**Maximum time from detection to fix deployment: 4 hours**

---

## Version Numbering

```
MAJOR.MINOR.PATCH

MAJOR: Breaking changes (requires coordinated upgrade)
MINOR: New features (backward compatible)
PATCH: Bug fixes and security patches
```
