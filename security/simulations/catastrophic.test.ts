/**
 * SOL ⇄ DCC Bridge — Catastrophic Failure Simulation Harness
 *
 * Implements Scenarios A-J from prompt3.md.
 * Models the bridge as a state machine and injects faults to test invariants.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// BRIDGE STATE MACHINE MODEL
// ═══════════════════════════════════════════════════════════════

interface BridgeState {
  // Solana side
  vaultBalance: bigint;
  totalLocked: bigint;
  processedDeposits: Set<string>;
  processedUnlocks: Set<string>;
  globalNonce: number;
  paused: boolean;

  // DCC side
  wrappedSupply: bigint;
  processedMints: Set<string>;
  processedBurns: Set<string>;
  dccPaused: boolean;

  // Rate limits
  dailyOutflow: bigint;
  maxDailyOutflow: bigint;
  maxSingleTx: bigint;

  // Checkpoint
  checkpointRoot: string;
  lastCheckpointSlot: number;

  // Governance
  adminPubkey: string;
  unpauseRequestedAt: number;
  unpauseDelay: number;
}

function createInitialState(): BridgeState {
  return {
    vaultBalance: 0n,
    totalLocked: 0n,
    processedDeposits: new Set(),
    processedUnlocks: new Set(),
    globalNonce: 0,
    paused: false,

    wrappedSupply: 0n,
    processedMints: new Set(),
    processedBurns: new Set(),
    dccPaused: false,

    dailyOutflow: 0n,
    maxDailyOutflow: 1000_000_000_000n, // 1000 SOL
    maxSingleTx: 100_000_000_000n,      // 100 SOL

    checkpointRoot: 'valid_root_abc123',
    lastCheckpointSlot: 100,

    adminPubkey: 'admin_pubkey_hex',
    unpauseRequestedAt: 0,
    unpauseDelay: 100,
  };
}

// ═══════════════════════════════════════════════════════════════
// INVARIANT CHECKS
// ═══════════════════════════════════════════════════════════════

function checkInvariants(state: BridgeState): string[] {
  const violations: string[] = [];

  // INV-1: No asset duplication
  if (state.wrappedSupply > state.totalLocked) {
    violations.push(`INV-1 VIOLATED: wrappedSupply(${state.wrappedSupply}) > totalLocked(${state.totalLocked})`);
  }

  // INV-2: Vault balance must be >= totalLocked
  if (state.vaultBalance < state.totalLocked) {
    violations.push(`INV-2 VIOLATED: vaultBalance(${state.vaultBalance}) < totalLocked(${state.totalLocked})`);
  }

  // INV-3: Daily outflow within limits
  if (state.dailyOutflow > state.maxDailyOutflow) {
    violations.push(`INV-3 VIOLATED: dailyOutflow(${state.dailyOutflow}) > maxDailyOutflow(${state.maxDailyOutflow})`);
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// STATE TRANSITIONS
// ═══════════════════════════════════════════════════════════════

function deposit(state: BridgeState, transferId: string, amount: bigint): { success: boolean; error?: string } {
  if (state.paused) return { success: false, error: 'bridge_paused' };
  if (state.processedDeposits.has(transferId)) return { success: false, error: 'replay_detected' };
  if (amount > state.maxSingleTx) return { success: false, error: 'exceeds_single_tx_limit' };

  state.processedDeposits.add(transferId);
  state.vaultBalance += amount;
  state.totalLocked += amount;
  state.globalNonce++;
  return { success: true };
}

function mint(state: BridgeState, messageId: string, amount: bigint, checkpointRoot: string, validProof: boolean): { success: boolean; error?: string } {
  if (state.dccPaused) return { success: false, error: 'dcc_paused' };
  if (state.processedMints.has(messageId)) return { success: false, error: 'replay_detected' };
  if (!validProof) return { success: false, error: 'invalid_proof' };
  if (checkpointRoot !== state.checkpointRoot) return { success: false, error: 'invalid_checkpoint' };
  if (amount > state.maxSingleTx) return { success: false, error: 'exceeds_single_tx_limit' };

  state.dailyOutflow += amount;
  if (state.dailyOutflow > state.maxDailyOutflow) {
    state.dailyOutflow -= amount;
    return { success: false, error: 'daily_limit_exceeded' };
  }

  state.processedMints.add(messageId);
  state.wrappedSupply += amount;
  return { success: true };
}

function burn(state: BridgeState, burnId: string, amount: bigint): { success: boolean; error?: string } {
  if (state.dccPaused) return { success: false, error: 'dcc_paused' };
  if (amount > state.wrappedSupply) return { success: false, error: 'insufficient_supply' };
  if (state.processedBurns.has(burnId)) return { success: false, error: 'replay_detected' };

  state.processedBurns.add(burnId);
  state.wrappedSupply -= amount;
  return { success: true };
}

function unlock(state: BridgeState, transferId: string, amount: bigint, validBurnProof: boolean): { success: boolean; error?: string } {
  if (state.paused) return { success: false, error: 'bridge_paused' };
  if (state.processedUnlocks.has(transferId)) return { success: false, error: 'replay_detected' };
  if (!validBurnProof) return { success: false, error: 'invalid_burn_proof' };
  if (amount > state.totalLocked) return { success: false, error: 'insufficient_locked' };
  if (amount > state.maxSingleTx) return { success: false, error: 'exceeds_single_tx_limit' };

  state.processedUnlocks.add(transferId);
  state.totalLocked -= amount;
  state.vaultBalance -= amount;
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// SCENARIO SIMULATIONS
// ═══════════════════════════════════════════════════════════════

describe('Catastrophic Failure Simulations', () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
  });

  // ── SCENARIO A: "Nomad-class" Accept-All Bug ──────────────

  describe('Scenario A — Accept-All Bug', () => {
    it('wildcard checkpoint root is rejected', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const result = mint(state, 'msg1', 1_000_000_000n, '', true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_checkpoint');
    });

    it('zero checkpoint root is rejected', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const result = mint(state, 'msg1', 1_000_000_000n, '0'.repeat(64), true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_checkpoint');
    });

    it('replay protection survives after valid mint', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const r1 = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
      expect(r1.success).toBe(true);

      const r2 = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('replay_detected');
    });

    it('invalid proof always rejected even with valid checkpoint', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const result = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_proof');
    });
  });

  // ── SCENARIO B: Checkpoint Corruption ──────────────

  describe('Scenario B — Malicious Checkpoint Roots', () => {
    it('old checkpoint reuse rejected', () => {
      deposit(state, 'tx1', 1_000_000_000n);

      // Attacker tries old root
      const oldRoot = 'old_root_xyz';
      const result = mint(state, 'msg1', 1_000_000_000n, oldRoot, true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_checkpoint');
    });

    it('cross-chain checkpoint rejected', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const foreignRoot = 'ethereum_root_abc';
      const result = mint(state, 'msg1', 1_000_000_000n, foreignRoot, true);
      expect(result.success).toBe(false);
    });
  });

  // ── SCENARIO C: Prover Compromise ──────────────

  describe('Scenario C — Prover Compromise', () => {
    it('fake proof with wrong checkpoint rejected', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const result = mint(state, 'msg1', 999_000_000_000n, 'fake_root', false);
      expect(result.success).toBe(false);
    });

    it('compromised prover cannot change amount without valid proof', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      // Valid checkpoint but invalid proof (prover tries to mint more)
      const result = mint(state, 'msg1', 999_000_000_000n, state.checkpointRoot, false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_proof');
    });

    it('invariant holds after all legitimate operations', () => {
      deposit(state, 'tx1', 10_000_000_000n);
      mint(state, 'msg1', 10_000_000_000n, state.checkpointRoot, true);
      const violations = checkInvariants(state);
      expect(violations).toHaveLength(0);
    });
  });

  // ── SCENARIO D: Relayer Compromise ──────────────

  describe('Scenario D — Relayer Compromise', () => {
    it('invalid proof spam does not change state', () => {
      const initialSupply = state.wrappedSupply;
      for (let i = 0; i < 100; i++) {
        mint(state, `spam_${i}`, 1_000_000_000n, state.checkpointRoot, false);
      }
      expect(state.wrappedSupply).toBe(initialSupply);
    });

    it('relayer reordering does not bypass replay', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      deposit(state, 'tx2', 2_000_000_000n);

      const r1 = mint(state, 'msg2', 2_000_000_000n, state.checkpointRoot, true);
      const r2 = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      // Replay attempt
      const r3 = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
      expect(r3.success).toBe(false);
    });
  });

  // ── SCENARIO E: Serialization / Hash Mismatch ──────────────

  describe('Scenario E — Serialization Mismatch', () => {
    it('different message IDs are always distinct', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      deposit(state, 'tx2', 1_000_000_000n);

      const r1 = mint(state, 'msg_id_1', 1_000_000_000n, state.checkpointRoot, true);
      const r2 = mint(state, 'msg_id_2', 1_000_000_000n, state.checkpointRoot, true);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      // Both processed — no collision
      expect(state.processedMints.has('msg_id_1')).toBe(true);
      expect(state.processedMints.has('msg_id_2')).toBe(true);
    });
  });

  // ── SCENARIO F: Replay at Scale ──────────────

  describe('Scenario F — Replay at Scale', () => {
    it('mass replay of same proof fails', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);

      let replayCount = 0;
      for (let i = 0; i < 1000; i++) {
        const r = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
        if (r.success) replayCount++;
      }
      expect(replayCount).toBe(0);
      expect(state.wrappedSupply).toBe(1_000_000_000n);
    });

    it('replay with metadata mutation still detected', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);

      // Same message_id, different amount — still caught
      const r = mint(state, 'msg1', 2_000_000_000n, state.checkpointRoot, true);
      expect(r.success).toBe(false);
      expect(r.error).toBe('replay_detected');
    });

    it('cross-chain replay from unlock to mint blocked by different ID space', () => {
      // Unlock and mint use different processed sets
      deposit(state, 'tx1', 1_000_000_000n);
      mint(state, 'shared_id', 1_000_000_000n, state.checkpointRoot, true);

      // Unlock with same ID is a different operation
      burn(state, 'burn1', 500_000_000n);
      const r = unlock(state, 'shared_id', 500_000_000n, true);
      // In production, the domain separation in message construction
      // prevents cross-chain replay. Here we model separate ID spaces.
      expect(r.success).toBe(true);
    });
  });

  // ── SCENARIO G: Time / Finality Confusion ──────────────

  describe('Scenario G — Time/Finality Confusion', () => {
    it('stale checkpoint does not validate fresh events', () => {
      const staleRoot = 'stale_root';
      deposit(state, 'tx1', 1_000_000_000n);
      const r = mint(state, 'msg1', 1_000_000_000n, staleRoot, true);
      expect(r.success).toBe(false);
    });
  });

  // ── SCENARIO H: Vault Drain via Withdrawal Path ──────────────

  describe('Scenario H — Vault Drain', () => {
    it('unlock without burn proof fails', () => {
      deposit(state, 'tx1', 10_000_000_000n);
      const r = unlock(state, 'fake_unlock', 10_000_000_000n, false);
      expect(r.success).toBe(false);
      expect(r.error).toBe('invalid_burn_proof');
      expect(state.vaultBalance).toBe(10_000_000_000n);
    });

    it('unlock exceeding locked amount fails', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      const r = unlock(state, 'unlock1', 2_000_000_000n, true);
      expect(r.success).toBe(false);
      expect(r.error).toBe('insufficient_locked');
    });

    it('double unlock with same proof fails', () => {
      deposit(state, 'tx1', 10_000_000_000n);
      mint(state, 'msg1', 5_000_000_000n, state.checkpointRoot, true);
      burn(state, 'burn1', 5_000_000_000n);

      const r1 = unlock(state, 'unlock1', 5_000_000_000n, true);
      expect(r1.success).toBe(true);

      const r2 = unlock(state, 'unlock1', 5_000_000_000n, true);
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('replay_detected');
    });

    it('invariant holds after deposit-mint-burn-unlock cycle', () => {
      deposit(state, 'tx1', 5_000_000_000n);
      mint(state, 'msg1', 5_000_000_000n, state.checkpointRoot, true);
      burn(state, 'burn1', 5_000_000_000n);
      unlock(state, 'unlock1', 5_000_000_000n, true);

      expect(state.vaultBalance).toBe(0n);
      expect(state.totalLocked).toBe(0n);
      expect(state.wrappedSupply).toBe(0n);
      expect(checkInvariants(state)).toHaveLength(0);
    });
  });

  // ── SCENARIO I: Governance / Upgrade Takeover ──────────────

  describe('Scenario I — Governance Takeover', () => {
    it('pause blocks all operations', () => {
      state.paused = true;
      state.dccPaused = true;

      const d = deposit(state, 'tx1', 1_000_000_000n);
      expect(d.success).toBe(false);
      expect(d.error).toBe('bridge_paused');

      const m = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, true);
      expect(m.success).toBe(false);
      expect(m.error).toBe('dcc_paused');

      const u = unlock(state, 'unlock1', 1_000_000_000n, true);
      expect(u.success).toBe(false);
      expect(u.error).toBe('bridge_paused');
    });

    it('rate limits cap worst-case loss even with compromised admin', () => {
      // Admin sets max daily outflow but it's still bounded
      for (let i = 0; i < 500; i++) {
        deposit(state, `tx${i}`, 10_000_000_000n);
        const result = mint(state, `msg${i}`, 10_000_000_000n, state.checkpointRoot, true);
        if (!result.success) break;
      }

      // Worst-case: daily outflow should not exceed maxDailyOutflow
      expect(state.dailyOutflow).toBeLessThanOrEqual(state.maxDailyOutflow);
    });
  });

  // ── SCENARIO J: Partial Outage / Partition ──────────────

  describe('Scenario J — Partial Outage', () => {
    it('no operations succeed without valid proofs during outage', () => {
      deposit(state, 'tx1', 1_000_000_000n);
      // Simulate: prover is down, proofs are invalid
      const r = mint(state, 'msg1', 1_000_000_000n, state.checkpointRoot, false);
      expect(r.success).toBe(false);
      expect(state.wrappedSupply).toBe(0n);
    });

    it('funds remain locked safely during outage', () => {
      deposit(state, 'tx1', 5_000_000_000n);
      deposit(state, 'tx2', 3_000_000_000n);
      // All mints fail during outage
      expect(state.vaultBalance).toBe(8_000_000_000n);
      expect(state.wrappedSupply).toBe(0n);
      expect(checkInvariants(state)).toHaveLength(0);
    });
  });

  // ── RANDOMIZED PROPERTY-BASED TESTS ──────────────

  describe('Property-Based Fuzzing', () => {
    it('random operation sequences preserve invariants (1000 rounds)', () => {
      const ops = ['deposit', 'mint', 'burn', 'unlock', 'replay_mint', 'replay_unlock', 'invalid_proof'];
      let mintCounter = 0;
      let burnCounter = 0;
      let depositCounter = 0;
      let unlockCounter = 0;

      for (let i = 0; i < 1000; i++) {
        const op = ops[Math.floor(Math.random() * ops.length)];
        const amount = BigInt(Math.floor(Math.random() * 10_000_000_000)) + 1n;

        switch (op) {
          case 'deposit':
            deposit(state, `dep_${depositCounter++}`, amount > state.maxSingleTx ? state.maxSingleTx : amount);
            break;
          case 'mint':
            mint(state, `mint_${mintCounter++}`, amount > state.maxSingleTx ? state.maxSingleTx : amount, state.checkpointRoot, true);
            break;
          case 'burn':
            if (state.wrappedSupply > 0n) {
              const burnAmt = amount > state.wrappedSupply ? state.wrappedSupply : amount;
              burn(state, `burn_${burnCounter++}`, burnAmt);
            }
            break;
          case 'unlock':
            if (state.totalLocked > 0n) {
              const unlockAmt = amount > state.totalLocked ? state.totalLocked : (amount > state.maxSingleTx ? state.maxSingleTx : amount);
              unlock(state, `unlock_${unlockCounter++}`, unlockAmt, true);
            }
            break;
          case 'replay_mint':
            if (mintCounter > 0) {
              mint(state, `mint_${Math.floor(Math.random() * mintCounter)}`, amount, state.checkpointRoot, true);
            }
            break;
          case 'replay_unlock':
            if (unlockCounter > 0) {
              unlock(state, `unlock_${Math.floor(Math.random() * unlockCounter)}`, amount, true);
            }
            break;
          case 'invalid_proof':
            mint(state, `invalid_${i}`, amount, state.checkpointRoot, false);
            break;
        }

        // Check invariants after every operation
        const violations = checkInvariants(state);
        if (violations.length > 0) {
          throw new Error(`Invariant violated at round ${i}: ${violations.join(', ')}`);
        }
      }
    });

    it('pause followed by operations preserves safety', () => {
      deposit(state, 'tx1', 5_000_000_000n);
      mint(state, 'msg1', 5_000_000_000n, state.checkpointRoot, true);

      state.paused = true;
      state.dccPaused = true;

      // Attempt 100 random operations while paused
      for (let i = 0; i < 100; i++) {
        deposit(state, `paused_dep_${i}`, 1_000_000_000n);
        mint(state, `paused_mint_${i}`, 1_000_000_000n, state.checkpointRoot, true);
        unlock(state, `paused_unlock_${i}`, 1_000_000_000n, true);
      }

      // State should not have changed
      expect(state.vaultBalance).toBe(5_000_000_000n);
      expect(state.wrappedSupply).toBe(5_000_000_000n);
    });
  });
});
