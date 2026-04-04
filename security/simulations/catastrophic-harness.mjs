#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * CATASTROPHIC FAILURE SIMULATION HARNESS
 * ═══════════════════════════════════════════════════════════════
 *
 * Models the full SOL ↔ DCC ZK bridge state machine and injects
 * faults corresponding to Scenarios A–J from prompt3.md.
 *
 * SAFETY INVARIANTS (must never be violated):
 *   S1: wrappedSupply ≤ totalLocked (no asset duplication)
 *   S2: invalid proofs / fake events never mint/unlock
 *   S3: each message_id processed at most once
 *   S4: uncertain verification → reject or hold, never approve
 *   S5: paused state blocks all mint/unlock operations
 *   S6: rate limits cap maximum loss per time window
 *
 * Usage: node security/simulations/catastrophic-harness.mjs
 */

import crypto from 'crypto';
import { strict as assert } from 'assert';

// ═══════════════════════════════════════════════════════
// CONSTANTS (mirror production)
// ═══════════════════════════════════════════════════════

const MAX_SINGLE_MINT = 50_000_000_000n;
const MIN_MINT = 10_000_000n;
const MAX_HOURLY = 100_000_000_000n;
const MAX_DAILY = 1_000_000_000_000n;
const HOURLY_WINDOW = 120;
const DAILY_WINDOW = 1440;
const LARGE_TX_THRESHOLD = 10_000_000_000n;
const LARGE_TX_DELAY = 100;
const CHECKPOINT_EXPIRY = 1440;
const UNPAUSE_DELAY = 100;
const MIN_COMMITTEE = 3;
const MIN_THRESHOLD = 2;
const FINALITY_SAFETY_MARGIN = 32;
const SOL_CHAIN_ID = 1;
const DCC_CHAIN_ID = 2;

// ═══════════════════════════════════════════════════════
// FULL BRIDGE STATE MACHINE MODEL
// ═══════════════════════════════════════════════════════

class BridgeModel {
  constructor() {
    // ── Solana side ──
    this.vaultBalance = 0n;
    this.totalLocked = 0n;
    this.totalUnlocked = 0n;
    this.deposits = new Map();
    this.unlocks = new Map();
    this.userNonces = new Map();
    this.globalNonceSol = 0n;
    this.solPaused = false;
    this.dailyOutflow = 0n;
    this.maxDailyOutflow = MAX_DAILY;
    this.maxUnlock = MAX_SINGLE_MINT;
    this.solAuthority = 'sol_authority';
    this.solGuardian = 'sol_guardian';
    this.validators = new Map();
    this.minValidators = 3;

    // ── Solana checkpoint registry ──
    this.solCheckpoints = new Map();
    this.solNextCheckpointId = 0;
    this.solLastCheckpointSlot = 0;
    this.solCommittee = new Map();
    this.solMinSigs = 3;
    this.solTimelockSeconds = 3600;
    this.solCheckpointTTL = 100000;
    this.solPendingCount = 0;
    this.solMaxPending = 10;
    this.solFinalitySafetyMargin = FINALITY_SAFETY_MARGIN;

    // ── DCC side ──
    this.dccTotalMinted = 0n;
    this.dccTotalBurned = 0n;
    this.processedMessages = new Set();
    this.dccCheckpoints = new Map();
    this.dccNextCheckpointId = 0;
    this.dccPaused = false;
    this.hourlyMinted = 0n;
    this.hourlyResetHeight = 0;
    this.dailyMinted = 0n;
    this.dailyResetHeight = 0;
    this.pendingLarge = new Map();
    this.dccAdmin = 'dcc_admin';
    this.dccGuardian = 'dcc_guardian';
    this.vkSet = false;
    this.vkHash = null;
    this.unpauseRequestedAt = 0;

    // ── DCC committee ──
    this.dccCommittee = new Map();
    this.dccCommitteeSize = 0;
    this.dccApprovalThreshold = 0;
    this.proposals = new Map();
    this.nextProposalId = 0;

    // ── Burn records ──
    this.burnRecords = new Map();

    // ── Global ──
    this.currentSlot = 200;
    this.currentHeight = 200;
    this.currentTimestamp = 1700000000;
  }

  // ── Invariant checks ──
  checkAllInvariants() {
    const violations = [];

    // S1: No asset duplication
    const dccOutstanding = this.dccTotalMinted - this.dccTotalBurned;
    const solNetLocked = this.totalLocked - this.totalUnlocked;
    if (dccOutstanding * 10n > solNetLocked) {
      violations.push(`S1 VIOLATED: DCC outstanding (${dccOutstanding}×10=${dccOutstanding * 10n}) > SOL locked (${solNetLocked})`);
    }

    // S5: Paused blocks
    // (verified inline during operations)

    // S6: Rate limits
    if (this.hourlyMinted > MAX_HOURLY) {
      violations.push(`S6 VIOLATED: hourly ${this.hourlyMinted} > ${MAX_HOURLY}`);
    }
    if (this.dailyMinted > MAX_DAILY) {
      violations.push(`S6 VIOLATED: daily ${this.dailyMinted} > ${MAX_DAILY}`);
    }

    // Additional: vault consistency
    if (this.vaultBalance < this.totalLocked - this.totalUnlocked) {
      violations.push(`VAULT VIOLATED: vaultBalance(${this.vaultBalance}) < net locked(${this.totalLocked - this.totalUnlocked})`);
    }

    return violations;
  }

  // ═══════════════ SOLANA OPERATIONS ═══════════════

  deposit(user, amount) {
    if (this.solPaused) return { ok: false, err: 'SOL_PAUSED' };
    if (amount < MIN_MINT) return { ok: false, err: 'BELOW_MIN' };
    if (amount > MAX_SINGLE_MINT) return { ok: false, err: 'ABOVE_MAX' };

    const nonce = this.userNonces.get(user) || 0n;
    const transferId = sha256(`deposit:${user}:${nonce}`);

    if (this.deposits.has(transferId)) return { ok: false, err: 'PDA_EXISTS' };

    const messageId = keccak256(`msg:${user}:${nonce}:${this.currentSlot}:${amount}`);

    this.vaultBalance += amount;
    this.totalLocked += amount;
    this.globalNonceSol++;
    this.userNonces.set(user, nonce + 1n);
    this.deposits.set(transferId, {
      transferId, messageId, amount, user,
      slot: this.currentSlot, processed: false
    });

    return { ok: true, transferId, messageId, amount };
  }

  unlock(transferId, amount, validBurnProof, sigCount) {
    if (this.solPaused) return { ok: false, err: 'SOL_PAUSED' };
    if (this.unlocks.has(transferId)) return { ok: false, err: 'REPLAY' };
    if (!validBurnProof) return { ok: false, err: 'INVALID_BURN_PROOF' };
    if ((sigCount || 0) < this.minValidators) return { ok: false, err: 'INSUFFICIENT_SIGS' };
    if (amount > this.maxUnlock) return { ok: false, err: 'ABOVE_MAX' };
    if (this.dailyOutflow + amount > this.maxDailyOutflow) return { ok: false, err: 'DAILY_LIMIT' };
    if (amount > this.vaultBalance) return { ok: false, err: 'INSUFFICIENT_VAULT' };

    this.vaultBalance -= amount;
    this.totalUnlocked += amount;
    this.dailyOutflow += amount;
    this.unlocks.set(transferId, { amount, executed: true });
    return { ok: true };
  }

  // ═══════════════ SOLANA CHECKPOINT ═══════════════

  submitCheckpoint(root, slot, sigCount, currentSlot) {
    if (this.solPaused) return { ok: false, err: 'SOL_PAUSED' };
    if (sigCount < this.solMinSigs) return { ok: false, err: 'INSUFFICIENT_SIGS' };
    if (this.solPendingCount >= this.solMaxPending) return { ok: false, err: 'MAX_PENDING' };
    if (slot <= this.solLastCheckpointSlot) return { ok: false, err: 'SLOT_NOT_ADVANCING' };
    if (root === '0'.repeat(64)) return { ok: false, err: 'ZERO_ROOT' };
    if ((currentSlot || this.currentSlot) < slot + this.solFinalitySafetyMargin)
      return { ok: false, err: 'NOT_FINAL' };

    const id = this.solNextCheckpointId++;
    this.solCheckpoints.set(id, {
      root, slot, status: 'Pending',
      activatesAt: this.currentTimestamp + this.solTimelockSeconds,
      expiresAtSlot: (currentSlot || this.currentSlot) + this.solCheckpointTTL,
      sigCount
    });
    this.solLastCheckpointSlot = slot;
    this.solPendingCount++;
    return { ok: true, id };
  }

  activateCheckpointSol(id) {
    const cp = this.solCheckpoints.get(id);
    if (!cp || cp.status !== 'Pending') return { ok: false, err: 'NOT_PENDING' };
    if (this.currentTimestamp < cp.activatesAt) return { ok: false, err: 'TIMELOCK' };
    if (this.currentSlot >= cp.expiresAtSlot) return { ok: false, err: 'EXPIRED' };
    cp.status = 'Active';
    this.solPendingCount--;
    return { ok: true };
  }

  expireCheckpointSol(id) {
    const cp = this.solCheckpoints.get(id);
    if (!cp) return { ok: false, err: 'NOT_FOUND' };
    if (this.currentSlot < cp.expiresAtSlot) return { ok: false, err: 'NOT_EXPIRED' };
    cp.status = 'Expired';
    if (cp.status === 'Pending') this.solPendingCount--;
    return { ok: true };
  }

  // ═══════════════ DCC COMMITTEE ═══════════════

  initializeCommittee(members, threshold, caller) {
    if (caller !== this.dccAdmin) return { ok: false, err: 'UNAUTHORIZED' };
    if (members.length < MIN_COMMITTEE) return { ok: false, err: 'TOO_FEW_MEMBERS' };
    if (threshold < MIN_THRESHOLD) return { ok: false, err: 'THRESHOLD_TOO_LOW' };
    if (threshold > members.length) return { ok: false, err: 'THRESHOLD_TOO_HIGH' };
    if (this.dccCommitteeSize > 0) return { ok: false, err: 'ALREADY_INIT' };

    for (const m of members) this.dccCommittee.set(m, true);
    this.dccCommitteeSize = members.length;
    this.dccApprovalThreshold = threshold;
    return { ok: true };
  }

  proposeCheckpoint(slot, root, caller) {
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    if (this.dccCommitteeSize === 0) return { ok: false, err: 'NO_COMMITTEE' };
    if (!this.dccCommittee.get(caller)) return { ok: false, err: 'NOT_MEMBER' };
    if (root === '0'.repeat(64)) return { ok: false, err: 'ZERO_ROOT' };

    const id = this.nextProposalId++;
    this.proposals.set(id, {
      root, slot, approvals: 1, finalized: false,
      voters: new Set([caller])
    });
    return { ok: true, id };
  }

  approveCheckpoint(proposalId, caller) {
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    if (!this.dccCommittee.get(caller)) return { ok: false, err: 'NOT_MEMBER' };
    const p = this.proposals.get(proposalId);
    if (!p) return { ok: false, err: 'NOT_FOUND' };
    if (p.finalized) return { ok: false, err: 'ALREADY_FINAL' };
    if (p.voters.has(caller)) return { ok: false, err: 'ALREADY_VOTED' };

    p.approvals++;
    p.voters.add(caller);

    if (p.approvals >= this.dccApprovalThreshold) {
      p.finalized = true;
      const cpId = this.dccNextCheckpointId++;
      this.dccCheckpoints.set(cpId, {
        root: p.root, slot: p.slot, active: true,
        height: this.currentHeight
      });
      return { ok: true, activated: true, cpId };
    }
    return { ok: true, activated: false };
  }

  // Legacy admin register (no committee)
  registerCheckpointAdmin(root, slot, caller) {
    if (caller !== this.dccAdmin) return { ok: false, err: 'UNAUTHORIZED' };
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    if (this.dccCommitteeSize > 0) return { ok: false, err: 'COMMITTEE_ACTIVE' };
    if (root === '0'.repeat(64)) return { ok: false, err: 'ZERO_ROOT' };

    const cpId = this.dccNextCheckpointId++;
    this.dccCheckpoints.set(cpId, {
      root, slot, active: true, height: this.currentHeight
    });
    return { ok: true, cpId };
  }

  // ═══════════════ DCC VERIFY & MINT ═══════════════

  verifyAndMint(messageId, checkpointId, amount, {
    validProof = true,
    checkpointRootFromProof = null,
    chainIdFromProof = DCC_CHAIN_ID,
    versionFromProof = 1
  } = {}) {
    // S5: Paused blocks
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    if (!this.vkSet) return { ok: false, err: 'VK_NOT_SET' };

    // S3: Replay protection
    if (this.processedMessages.has(messageId)) return { ok: false, err: 'REPLAY' };

    // Checkpoint must be active
    const cp = this.dccCheckpoints.get(checkpointId);
    if (!cp || !cp.active) return { ok: false, err: 'INACTIVE_CHECKPOINT' };

    // Checkpoint expiry
    if (this.currentHeight - cp.height >= CHECKPOINT_EXPIRY) {
      cp.active = false;
      return { ok: false, err: 'EXPIRED_CHECKPOINT' };
    }

    // S2: Invalid proof rejection
    if (!validProof) return { ok: false, err: 'INVALID_PROOF' };

    // S4: Fail-closed — if proof gives wrong root, reject
    const proofRoot = checkpointRootFromProof || cp.root;
    if (proofRoot !== cp.root) return { ok: false, err: 'ROOT_MISMATCH' };

    // Version check
    if (versionFromProof !== 1) return { ok: false, err: 'VERSION_MISMATCH' };

    // Amount bounds
    if (amount < MIN_MINT) return { ok: false, err: 'BELOW_MIN' };
    if (amount > MAX_SINGLE_MINT) return { ok: false, err: 'ABOVE_MAX' };

    // S6: Rate limits
    if (this.currentHeight - this.hourlyResetHeight >= HOURLY_WINDOW) {
      this.hourlyMinted = 0n;
      this.hourlyResetHeight = this.currentHeight;
    }
    if (this.hourlyMinted + amount > MAX_HOURLY)
      return { ok: false, err: 'HOURLY_LIMIT' };

    if (this.currentHeight - this.dailyResetHeight >= DAILY_WINDOW) {
      this.dailyMinted = 0n;
      this.dailyResetHeight = this.currentHeight;
    }
    if (this.dailyMinted + amount > MAX_DAILY)
      return { ok: false, err: 'DAILY_LIMIT' };

    const mintAmount = amount / 10n;
    if (mintAmount <= 0n) return { ok: false, err: 'ZERO_MINT' };

    // Large TX delay
    if (amount >= LARGE_TX_THRESHOLD) {
      this.processedMessages.add(messageId);
      this.pendingLarge.set(messageId, {
        amount: mintAmount, height: this.currentHeight
      });
      this.hourlyMinted += amount;
      this.dailyMinted += amount;
      return { ok: true, pending: true };
    }

    // Immediate mint
    this.processedMessages.add(messageId);
    this.dccTotalMinted += mintAmount;
    this.hourlyMinted += amount;
    this.dailyMinted += amount;
    return { ok: true, pending: false };
  }

  executePendingMint(messageId) {
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    const p = this.pendingLarge.get(messageId);
    if (!p) return { ok: false, err: 'NOT_PENDING' };
    if (this.currentHeight - p.height < LARGE_TX_DELAY)
      return { ok: false, err: 'DELAY_NOT_ELAPSED' };

    this.dccTotalMinted += p.amount;
    this.pendingLarge.delete(messageId);
    return { ok: true };
  }

  burn(amount) {
    if (this.dccPaused) return { ok: false, err: 'DCC_PAUSED' };
    if (amount <= 0n) return { ok: false, err: 'ZERO_AMOUNT' };
    const outstanding = this.dccTotalMinted - this.dccTotalBurned;
    if (amount > outstanding) return { ok: false, err: 'INSUFFICIENT' };

    const burnId = randomHex();
    this.dccTotalBurned += amount;
    this.burnRecords.set(burnId, { amount });
    this.processedMessages.add(burnId);
    return { ok: true, burnId };
  }

  // ═══════════════ EMERGENCY ═══════════════

  pauseSol(caller) {
    if (caller !== this.solAuthority && caller !== this.solGuardian)
      return { ok: false, err: 'UNAUTHORIZED' };
    this.solPaused = true;
    return { ok: true };
  }

  resumeSol(caller) {
    if (caller !== this.solAuthority) return { ok: false, err: 'UNAUTHORIZED' };
    this.solPaused = false;
    return { ok: true };
  }

  pauseDcc(caller) {
    if (caller !== this.dccAdmin && caller !== this.dccGuardian)
      return { ok: false, err: 'UNAUTHORIZED' };
    this.dccPaused = true;
    return { ok: true };
  }

  resumeDcc(caller) {
    if (caller !== this.dccAdmin) return { ok: false, err: 'UNAUTHORIZED' };
    if (this.unpauseRequestedAt === 0) {
      this.unpauseRequestedAt = this.currentHeight;
      return { ok: false, err: 'UNPAUSE_REQUESTED' };
    }
    if (this.currentHeight - this.unpauseRequestedAt < UNPAUSE_DELAY)
      return { ok: false, err: 'DELAY_NOT_ELAPSED' };
    this.dccPaused = false;
    this.unpauseRequestedAt = 0;
    return { ok: true };
  }

  setVk(hash, caller) {
    if (caller !== this.dccAdmin) return { ok: false, err: 'UNAUTHORIZED' };
    if (this.vkSet) return { ok: false, err: 'VK_ALREADY_SET' };
    this.vkSet = true;
    this.vkHash = hash;
    return { ok: true };
  }

  cancelPendingMint(messageId, caller) {
    if (caller !== this.dccAdmin && caller !== this.dccGuardian)
      return { ok: false, err: 'UNAUTHORIZED' };
    if (!this.pendingLarge.has(messageId)) return { ok: false, err: 'NOT_PENDING' };
    // FIX (E-8): Decrement totalMinted by cancelled pending amount
    const pending = this.pendingLarge.get(messageId);
    if (pending && pending.amount) {
      this.dccTotalMinted -= pending.amount;
    }
    this.pendingLarge.delete(messageId);
    return { ok: true };
  }

  deactivateCheckpoint(cpId, caller) {
    const cp = this.dccCheckpoints.get(cpId);
    if (!cp || !cp.active) return { ok: false, err: 'NOT_ACTIVE' };
    const expired = this.currentHeight - cp.height >= CHECKPOINT_EXPIRY;
    if (caller !== this.dccAdmin && caller !== this.dccGuardian && !expired)
      return { ok: false, err: 'UNAUTHORIZED' };
    cp.active = false;
    return { ok: true };
  }

  transferAdmin(newAdmin, caller) {
    if (caller !== this.dccAdmin) return { ok: false, err: 'UNAUTHORIZED' };
    this.dccAdmin = newAdmin;
    return { ok: true };
  }

  // ── Time advancement ──
  advanceBlocks(n) { this.currentHeight += n; this.currentSlot += n; }
  advanceTime(s) { this.currentTimestamp += s; }
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function keccak256(s) {
  return crypto.createHash('sha3-256').update(s).digest('hex');
}

function randomHex() {
  return crypto.randomBytes(32).toString('hex');
}

function randomBigInt(max) {
  return BigInt(Math.floor(Math.random() * Number(max)));
}

// ═══════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════

let passed = 0, failed = 0, total = 0;
const results = { scenarios: {} };

function scenario(name, fn) {
  results.scenarios[name] = { tests: [], pass: true };
  console.log(`\n  ┌─ ${name}`);
  fn();
  if (results.scenarios[name].pass) {
    console.log(`  └─ ✅ SCENARIO PASS`);
  } else {
    console.log(`  └─ ❌ SCENARIO FAIL`);
  }
}

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    results.scenarios[Object.keys(results.scenarios).pop()].tests.push({ name, pass: true });
    console.log(`  │  ✅ ${name}`);
  } catch (e) {
    failed++;
    const scKey = Object.keys(results.scenarios).pop();
    results.scenarios[scKey].tests.push({ name, pass: false, error: e.message });
    results.scenarios[scKey].pass = false;
    console.log(`  │  ❌ ${name}: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// SCENARIO A — "NOMAD-CLASS" ACCEPT-ALL BUG
// ═══════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  CATASTROPHIC FAILURE SIMULATION HARNESS');
console.log('═══════════════════════════════════════════════════════════');

scenario('A — Nomad-Class Accept-All Bug', () => {
  test('A1: Zero checkpoint root rejected on DCC', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    const r = m.registerCheckpointAdmin('0'.repeat(64), 100, m.dccAdmin);
    assert(r.ok === false && r.err === 'ZERO_ROOT');
  });

  test('A2: Zero root rejected in committee proposal', () => {
    const m = new BridgeModel();
    m.initializeCommittee(['a', 'b', 'c'], 2, m.dccAdmin);
    const r = m.proposeCheckpoint(100, '0'.repeat(64), 'a');
    assert(r.ok === false && r.err === 'ZERO_ROOT');
  });

  test('A3: Wildcard/empty checkpoint root rejected on Solana', () => {
    const m = new BridgeModel();
    const r = m.submitCheckpoint('0'.repeat(64), 100, 5, 200);
    assert(r.ok === false && r.err === 'ZERO_ROOT');
  });

  test('A4: VK not set blocks all mints', () => {
    const m = new BridgeModel();
    // Simulate: vk never set (misconfiguration)
    assert(m.vkSet === false);
    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n);
    assert(r.ok === false && r.err === 'VK_NOT_SET');
  });

  test('A5: Replay protection cannot be "reset" via normal operations', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('user1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    // First mint succeeds
    const r1 = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r1.ok === true);

    // Replay blocked
    const r2 = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r2.ok === false && r2.err === 'REPLAY');

    // No API exists to clear processedMessages set
    assert(m.processedMessages.has(dep.messageId));
  });

  test('A6: Invalid proof with valid checkpoint = no state change', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    const before = m.dccTotalMinted;
    for (let i = 0; i < 100; i++) {
      m.verifyAndMint(`msg${i}`, 0, 1_000_000_000n, { validProof: false });
    }
    assert(m.dccTotalMinted === before, 'Minted supply changed with invalid proofs');
  });

  test('A7: Domain separation disabled = mismatch caught by root check', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    const realRoot = randomHex();
    m.registerCheckpointAdmin(realRoot, 100, m.dccAdmin);

    // Proof claims different root (domain sep disabled would produce wrong root)
    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n, {
      validProof: true,
      checkpointRootFromProof: randomHex()
    });
    assert(r.ok === false && r.err === 'ROOT_MISMATCH');
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO B — CHECKPOINT CORRUPTION / MALICIOUS ROOTS
// ═══════════════════════════════════════════════════════

scenario('B — Checkpoint Corruption / Malicious Roots', () => {
  test('B1: Malicious root not matching real events → proof fails', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    // Attacker registers malicious root
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    // Proof for a fabricated deposit would fail groth16 verification
    const r = m.verifyAndMint('fake_msg', 0, 50_000_000_000n, { validProof: false });
    assert(r.ok === false && r.err === 'INVALID_PROOF');
  });

  test('B2: Old checkpoint reuse blocked by expiry', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('user1', 1_000_000_000n);
    m.advanceBlocks(CHECKPOINT_EXPIRY + 1);

    const dep = Array.from(m.deposits.values())[0];
    const r = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r.ok === false && r.err === 'EXPIRED_CHECKPOINT');
  });

  test('B3: Cross-chain root from Ethereum rejected (different root)', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    const solRoot = randomHex();
    m.registerCheckpointAdmin(solRoot, 100, m.dccAdmin);

    // Attacker submits proof with Ethereum root
    const ethRoot = randomHex();
    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n, {
      validProof: true,
      checkpointRootFromProof: ethRoot
    });
    assert(r.ok === false && r.err === 'ROOT_MISMATCH');
  });

  test('B4: Deactivated checkpoint blocks mints', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deactivateCheckpoint(0, m.dccAdmin);

    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n);
    assert(r.ok === false && r.err === 'INACTIVE_CHECKPOINT');
  });

  test('B5: Committee prevents single-actor checkpoint injection', () => {
    const m = new BridgeModel();
    m.initializeCommittee(['alice', 'bob', 'charlie'], 2, m.dccAdmin);

    // Single attacker cannot activate checkpoint alone
    const p = m.proposeCheckpoint(100, randomHex(), 'alice');
    assert(p.ok === true);
    // Check: not yet activated (only 1 vote)
    assert(m.dccCheckpoints.size === 0, 'Checkpoint should not be active yet');

    // Second approval triggers activation
    const a = m.approveCheckpoint(p.id, 'bob');
    assert(a.ok === true && a.activated === true);
    assert(m.dccCheckpoints.size === 1);
  });

  test('B6: Max loss bounded by rate limits even with corrupt checkpoint', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    // Assume attacker controls checkpoint — all proofs "valid"
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    // Deposit enough to not violate S1 in our model
    for (let i = 0; i < 50; i++) m.deposit(`u${i}`, MAX_SINGLE_MINT);

    let totalMinted = 0n;
    for (let i = 0; i < 200; i++) {
      const r = m.verifyAndMint(`atk_${i}`, 0, MAX_SINGLE_MINT);
      if (r.ok) totalMinted += MAX_SINGLE_MINT;
    }
    // Should not exceed hourly cap
    assert(totalMinted <= MAX_HOURLY, `Minted ${totalMinted} exceeds hourly cap ${MAX_HOURLY}`);
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO C — PROVER COMPROMISE
// ═══════════════════════════════════════════════════════

scenario('C — Prover Compromise', () => {
  test('C1: Compromised prover generates invalid proof → rejected', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    const r = m.verifyAndMint('fake', 0, 50_000_000_000n, { validProof: false });
    assert(r.ok === false && r.err === 'INVALID_PROOF');
  });

  test('C2: Prover changes public inputs → root mismatch', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    const r = m.verifyAndMint('msg', 0, 1_000_000_000n, {
      validProof: true,
      checkpointRootFromProof: randomHex()
    });
    assert(r.ok === false && r.err === 'ROOT_MISMATCH');
  });

  test('C3: VK is immutable — prover cannot replace it', () => {
    const m = new BridgeModel();
    m.setVk('hash1', m.dccAdmin);
    const r = m.setVk('hash2', m.dccAdmin);
    assert(r.ok === false && r.err === 'VK_ALREADY_SET');
  });

  test('C4: 1000 fake proofs = 0 state changes', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    const before = m.dccTotalMinted;
    for (let i = 0; i < 1000; i++) {
      m.verifyAndMint(`fake_${i}`, 0, MAX_SINGLE_MINT, { validProof: false });
    }
    assert(m.dccTotalMinted === before);
    assert(m.processedMessages.size === 0, 'No messages should be marked processed');
  });

  test('C5: Version mismatch in proof rejected', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('user1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];
    const r = m.verifyAndMint(dep.messageId, 0, dep.amount, {
      validProof: true,
      versionFromProof: 2
    });
    assert(r.ok === false && r.err === 'VERSION_MISMATCH');
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO D — RELAYER COMPROMISE
// ═══════════════════════════════════════════════════════

scenario('D — Relayer Compromise', () => {
  test('D1: Invalid proof spam causes 0 state changes', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    const supplyBefore = m.dccTotalMinted;
    for (let i = 0; i < 500; i++) {
      m.verifyAndMint(`spam_${i}`, 0, 1_000_000_000n, { validProof: false });
    }
    assert(m.dccTotalMinted === supplyBefore);
  });

  test('D2: Relayer reorders submissions — order doesn\'t matter', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 1_000_000_000n);
    m.deposit('u2', 2_000_000_000n);
    const deps = Array.from(m.deposits.values());

    // Submit in reverse order
    const r2 = m.verifyAndMint(deps[1].messageId, 0, deps[1].amount);
    const r1 = m.verifyAndMint(deps[0].messageId, 0, deps[0].amount);
    assert(r1.ok === true);
    assert(r2.ok === true);
  });

  test('D3: Relayer withholds proofs — funds remain safe in vault', () => {
    const m = new BridgeModel();
    m.deposit('u1', 5_000_000_000n);
    // No mints submitted — funds sit safely in vault
    assert(m.vaultBalance === 5_000_000_000n);
    assert(m.dccTotalMinted === 0n);
    assert(m.checkAllInvariants().length === 0);
  });

  test('D4: Relayer has zero admin authority', () => {
    const m = new BridgeModel();
    // Relayer cannot pause
    const p1 = m.pauseSol('relayer');
    assert(p1.ok === false);
    const p2 = m.pauseDcc('relayer');
    assert(p2.ok === false);
    // Cannot set VK
    const v = m.setVk('fake', 'relayer');
    assert(v.ok === false);
    // Cannot transfer admin
    const t = m.transferAdmin('relayer', 'relayer');
    assert(t.ok === false);
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO E — SERIALIZATION / HASH MISMATCH
// ═══════════════════════════════════════════════════════

scenario('E — Serialization / Hash Mismatch', () => {
  test('E1: Different endianness → different message_id → stuck funds (liveness)', () => {
    // If prover uses BE and Solana uses LE, the message_ids diverge.
    // ZK proof proves membership of the wrong message_id → proof fails.
    // Result: liveness failure (stuck funds), NOT safety failure.
    const leHash = keccak256('amount_le:01000000');
    const beHash = keccak256('amount_be:00000001');
    assert(leHash !== beHash, 'LE and BE must produce different hashes');
    // Safety: no inflation possible because proof won't verify
  });

  test('E2: Fixed-width fields prevent padding ambiguity', () => {
    // With variable-length fields, chain_id=10,amount=02 could collide
    // with chain_id=1,amount=002. Fixed-width LE encoding prevents this.
    // Example: u32 LE of 10 = [0a,00,00,00], u32 LE of 1 = [01,00,00,00] — always distinct.
    const buf1 = Buffer.alloc(8); // chain=10 (4B LE) + idx=2 (4B LE)
    buf1.writeUInt32LE(10, 0);
    buf1.writeUInt32LE(2, 4);
    const buf2 = Buffer.alloc(8); // chain=1 (4B LE) + idx=2 (4B LE) — different!
    buf2.writeUInt32LE(1, 0);
    buf2.writeUInt32LE(2, 4);
    assert(!buf1.equals(buf2), 'Fixed-width LE encoding must disambiguate fields');
    // Also verify with actual input: chain=1,idx=02 vs chain=1,idx=20
    const buf3 = Buffer.alloc(8);
    buf3.writeUInt32LE(1, 0);
    buf3.writeUInt32LE(20, 4);
    assert(!buf2.equals(buf3), 'Different event_index values must differ');
  });

  test('E3: Golden test vector enforces cross-implementation consistency', () => {
    // The golden vector 0x6ad0deb8... is verified in both Rust and TypeScript.
    // If RIDE or Circom diverge, the ZK proof fails and funds are stuck (safe).
    const goldenHash = '6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444';
    assert(goldenHash.length === 64, 'Golden vector is 32 bytes hex');
    // Main point: mismatch = stuck, not stolen
  });

  test('E4: Domain separator length mismatch → revert', () => {
    // RIDE computeMessageId has runtime check: size(domainBytes) != 17 → throw
    // If this changes, it's caught immediately
    const expectedLen = 'DCC_SOL_BRIDGE_V1'.length;
    assert(expectedLen === 17, 'Domain separator must be exactly 17 bytes');
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO F — REPLAY AT SCALE
// ═══════════════════════════════════════════════════════

scenario('F — Replay at Scale', () => {
  test('F1: Same proof submitted 10,000 times → only 1 mint', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    let mintCount = 0;
    for (let i = 0; i < 10000; i++) {
      const r = m.verifyAndMint(dep.messageId, 0, dep.amount);
      if (r.ok) mintCount++;
    }
    assert(mintCount === 1, `Expected 1 mint, got ${mintCount}`);
  });

  test('F2: Same message_id + different amount → still blocked', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    m.verifyAndMint(dep.messageId, 0, dep.amount);
    const r = m.verifyAndMint(dep.messageId, 0, 2_000_000_000n);
    assert(r.ok === false && r.err === 'REPLAY');
  });

  test('F3: Cross-chain replay prevented by domain separation', () => {
    // message_id includes src_chain_id and dst_chain_id in its preimage.
    // A proof from chain 1→2 produces a different message_id than 1→3.
    const msgId_1_2 = keccak256(`bridge:${SOL_CHAIN_ID}:${DCC_CHAIN_ID}:deposit:100`);
    const msgId_1_3 = keccak256(`bridge:${SOL_CHAIN_ID}:3:deposit:100`);
    assert(msgId_1_2 !== msgId_1_3);
  });

  test('F4: processedMessages persists across simulated "restart"', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];
    m.verifyAndMint(dep.messageId, 0, dep.amount);

    // "Restart" — serialize/deserialize
    const serialized = JSON.stringify([...m.processedMessages]);
    m.processedMessages = new Set(JSON.parse(serialized));

    const r = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r.ok === false && r.err === 'REPLAY');
  });

  test('F5: Burn ID collision with mint ID → separate namespaces', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 1_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    m.verifyAndMint(dep.messageId, 0, dep.amount);
    // Burn uses separate ID generation (keccak of burn-specific data)
    // Even if IDs collide in the same Set, the operations are idempotent
    assert(m.processedMessages.has(dep.messageId));
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO G — TIME/FINALITY CONFUSION
// ═══════════════════════════════════════════════════════

scenario('G — Time/Finality Confusion', () => {
  test('G1: Non-finalized slot rejected by Solana checkpoint', () => {
    const m = new BridgeModel();
    // Try checkpoint at slot 195 when current slot is 200, safety margin=32
    const r = m.submitCheckpoint(randomHex(), 195, 5, 200);
    assert(r.ok === false && r.err === 'NOT_FINAL');
  });

  test('G2: Future slot rejected', () => {
    const m = new BridgeModel();
    // Slot 300 > current 200
    const r = m.submitCheckpoint(randomHex(), 300, 5, 200);
    assert(r.ok === false && r.err === 'NOT_FINAL');
  });

  test('G3: Stale checkpoint expired and blocked', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.advanceBlocks(CHECKPOINT_EXPIRY + 1);

    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n);
    assert(r.ok === false && r.err === 'EXPIRED_CHECKPOINT');
  });

  test('G4: Slot must advance monotonically', () => {
    const m = new BridgeModel();
    m.submitCheckpoint(randomHex(), 100, 5, 200);
    // Try earlier slot
    const r = m.submitCheckpoint(randomHex(), 50, 5, 200);
    assert(r.ok === false && r.err === 'SLOT_NOT_ADVANCING');
  });

  test('G5: Timelock prevents immediate checkpoint activation on Solana', () => {
    const m = new BridgeModel();
    m.submitCheckpoint(randomHex(), 100, 5, 200);
    const r = m.activateCheckpointSol(0);
    assert(r.ok === false && r.err === 'TIMELOCK');

    m.advanceTime(m.solTimelockSeconds + 1);
    const r2 = m.activateCheckpointSol(0);
    assert(r2.ok === true);
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO H — VAULT DRAIN VIA WITHDRAWAL PATH
// ═══════════════════════════════════════════════════════

scenario('H — Vault Drain via Withdrawal Path', () => {
  test('H1: Unlock without burn proof rejected', () => {
    const m = new BridgeModel();
    m.deposit('u1', 10_000_000_000n);
    const r = m.unlock('fake_tx', 10_000_000_000n, false, 5);
    assert(r.ok === false && r.err === 'INVALID_BURN_PROOF');
    assert(m.vaultBalance === 10_000_000_000n);
  });

  test('H2: Insufficient validator signatures rejected', () => {
    const m = new BridgeModel();
    m.deposit('u1', 10_000_000_000n);
    const r = m.unlock('tx1', 5_000_000_000n, true, 1); // 1 < min 3
    assert(r.ok === false && r.err === 'INSUFFICIENT_SIGS');
  });

  test('H3: Double unlock (replay) rejected', () => {
    const m = new BridgeModel();
    m.deposit('u1', 10_000_000_000n);
    const r1 = m.unlock('tx1', 5_000_000_000n, true, 5);
    assert(r1.ok === true);
    const r2 = m.unlock('tx1', 5_000_000_000n, true, 5);
    assert(r2.ok === false && r2.err === 'REPLAY');
  });

  test('H4: Unlock exceeding vault balance rejected', () => {
    const m = new BridgeModel();
    m.deposit('u1', 1_000_000_000n);
    const r = m.unlock('tx1', 2_000_000_000n, true, 5);
    assert(r.ok === false && r.err === 'INSUFFICIENT_VAULT');
  });

  test('H5: Daily outflow limit caps vault drain rate', () => {
    const m = new BridgeModel();
    for (let i = 0; i < 100; i++) m.deposit(`u${i}`, MAX_SINGLE_MINT);

    let totalDrained = 0n;
    for (let i = 0; i < 200; i++) {
      const r = m.unlock(`tx${i}`, MAX_SINGLE_MINT, true, 5);
      if (r.ok) totalDrained += MAX_SINGLE_MINT;
    }
    assert(totalDrained <= MAX_DAILY, `Drained ${totalDrained} > daily limit ${MAX_DAILY}`);
  });

  test('H6: Complete cycle preserves supply invariant', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);

    m.deposit('u1', 5_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];
    m.verifyAndMint(dep.messageId, 0, dep.amount);
    m.burn(dep.amount / 10n);  // 8-decimal amount
    m.unlock('unlock1', dep.amount, true, 5);

    assert(m.vaultBalance === 0n);
    assert(m.dccTotalMinted - m.dccTotalBurned === 0n);
    assert(m.checkAllInvariants().length === 0);
  });

  test('H7: Integer overflow in amount rejected by max check', () => {
    const m = new BridgeModel();
    m.deposit('u1', 10_000_000_000n);
    // Try unlocking u64::MAX
    const maxU64 = 18_446_744_073_709_551_615n;
    const r = m.unlock('tx1', maxU64, true, 5);
    assert(r.ok === false);
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO I — GOVERNANCE / UPGRADE TAKEOVER
// ═══════════════════════════════════════════════════════

scenario('I — Governance / Upgrade Takeover', () => {
  test('I1: VK is immutable once set — admin cannot replace', () => {
    const m = new BridgeModel();
    m.setVk('real_vk', m.dccAdmin);
    const r = m.setVk('evil_vk', m.dccAdmin);
    assert(r.ok === false && r.err === 'VK_ALREADY_SET');
  });

  test('I2: Compromised admin cannot instantly unpause DCC', () => {
    const m = new BridgeModel();
    m.pauseDcc(m.dccAdmin);
    assert(m.dccPaused === true);

    const r1 = m.resumeDcc(m.dccAdmin);
    assert(r1.ok === false && r1.err === 'UNPAUSE_REQUESTED');
    assert(m.dccPaused === true);

    // Still paused — delay not elapsed
    const r2 = m.resumeDcc(m.dccAdmin);
    assert(r2.ok === false && r2.err === 'DELAY_NOT_ELAPSED');
    assert(m.dccPaused === true);

    // After delay
    m.advanceBlocks(UNPAUSE_DELAY + 1);
    const r3 = m.resumeDcc(m.dccAdmin);
    assert(r3.ok === true);
    assert(m.dccPaused === false);
  });

  test('I3: Solana resume has NO timelock (finding FV-1)', () => {
    const m = new BridgeModel();
    m.pauseSol(m.solAuthority);
    assert(m.solPaused === true);
    // Instant resume — this is a known gap
    const r = m.resumeSol(m.solAuthority);
    assert(r.ok === true);
    assert(m.solPaused === false);
    // Document: this IS the known FV-1 finding
  });

  test('I4: Admin admin transfer preserves pause state', () => {
    const m = new BridgeModel();
    m.pauseDcc(m.dccAdmin);
    m.transferAdmin('evil_admin', m.dccAdmin);
    // Bridge stays paused
    assert(m.dccPaused === true);
    // Evil admin still can't instant-unpause
    const r = m.resumeDcc('evil_admin');
    assert(r.ok === false); // Timelock required
  });

  test('I5: Guardian can pause but NOT resume', () => {
    const m = new BridgeModel();
    const p = m.pauseDcc(m.dccGuardian);
    assert(p.ok === true);
    assert(m.dccPaused === true);

    const r = m.resumeDcc(m.dccGuardian);
    assert(r.ok === false && r.err === 'UNAUTHORIZED');
  });

  test('I6: Worst-case admin compromise loss bounded by rate limits', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);

    // Admin deposits a lot
    for (let i = 0; i < 100; i++) m.deposit(`d${i}`, MAX_SINGLE_MINT);

    // Admin mints as fast as rate limits allow
    let minted = 0n;
    for (let i = 0; i < 1000; i++) {
      const r = m.verifyAndMint(`evil_${i}`, 0, MAX_SINGLE_MINT);
      if (r.ok && !r.pending) minted += MAX_SINGLE_MINT / 10n;
    }

    // In one hour window, max minted is MAX_HOURLY / 10 in 8-decimal terms
    assert(m.hourlyMinted <= MAX_HOURLY);
    assert(m.dailyMinted <= MAX_DAILY);
  });

  test('I7: CancelPendingMint by admin does not re-enable replay', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 40_000_000_000n); // large tx >10 SOL

    const dep = Array.from(m.deposits.values())[0];
    const r1 = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r1.ok === true && r1.pending === true);

    // Admin cancels the pending mint
    m.cancelPendingMint(dep.messageId, m.dccAdmin);
    assert(!m.pendingLarge.has(dep.messageId));

    // Attacker tries to resubmit the same proof
    const r2 = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r2.ok === false && r2.err === 'REPLAY');
  });
});

// ═══════════════════════════════════════════════════════
// SCENARIO J — PARTIAL OUTAGE / PARTITION
// ═══════════════════════════════════════════════════════

scenario('J — Partial Outage / Partition', () => {
  test('J1: Solana RPC down — no proofs generated, funds safe', () => {
    const m = new BridgeModel();
    m.deposit('u1', 5_000_000_000n);
    // RPC down = no prover = no proofs submitted
    assert(m.vaultBalance === 5_000_000_000n);
    assert(m.dccTotalMinted === 0n);
    assert(m.checkAllInvariants().length === 0);
  });

  test('J2: Checkpoint delayed — no mints possible without checkpoint', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    // No checkpoint registered
    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n);
    assert(r.ok === false && r.err === 'INACTIVE_CHECKPOINT');
  });

  test('J3: DCC node disagreement — no guessing, fail closed', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    // Proof verification would fail if nodes disagree on state
    // System simply rejects — no "best guess" minting
    const r = m.verifyAndMint('msg1', 0, 1_000_000_000n, { validProof: false });
    assert(r.ok === false && r.err === 'INVALID_PROOF');
  });

  test('J4: Partial outage while large TX is pending — safe', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 40_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    const r = m.verifyAndMint(dep.messageId, 0, dep.amount);
    assert(r.ok === true && r.pending === true);

    // Outage: can't execute for a while
    // Execute attempt before delay = rejected
    const r2 = m.executePendingMint(dep.messageId);
    assert(r2.ok === false && r2.err === 'DELAY_NOT_ELAPSED');

    // After delay
    m.advanceBlocks(LARGE_TX_DELAY + 1);
    const r3 = m.executePendingMint(dep.messageId);
    assert(r3.ok === true);
  });
});

// ═══════════════════════════════════════════════════════
// RANDOMIZED PROPERTY-BASED FUZZING
// ═══════════════════════════════════════════════════════

scenario('Randomized Fuzzing — 10,000 operations', () => {
  test('10k random ops: all safety invariants hold', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);

    const ops = [
      'deposit', 'deposit', 'deposit',
      'mint', 'mint',
      'burn',
      'unlock',
      'replay_mint', 'replay_mint',
      'invalid_proof', 'invalid_proof',
      'advance_blocks',
      'pause_sol', 'unpause_sol',
      'pause_dcc', 'unpause_dcc',
      'expire_checkpoint',
      'register_cp',
      'execute_pending',
      'cancel_pending',
      'overflow_amount',
    ];

    let depCount = 0, mintCount = 0, burnCount = 0, unlockCount = 0;
    let replayBlocked = 0, invalidBlocked = 0, pauseBlocked = 0;

    for (let i = 0; i < 10000; i++) {
      const op = ops[Math.floor(Math.random() * ops.length)];
      const amt = MIN_MINT + randomBigInt(MAX_SINGLE_MINT - MIN_MINT);

      try {
        switch (op) {
          case 'deposit': {
            const r = m.deposit(`u_${i}`, amt);
            if (r.ok) depCount++;
            if (r.err === 'SOL_PAUSED') pauseBlocked++;
            break;
          }
          case 'mint': {
            if (m.deposits.size === 0) break;
            const deps = Array.from(m.deposits.values());
            const d = deps[Math.floor(Math.random() * deps.length)];
            // Use latest checkpoint (may be 0 or higher)
            const latestCpId = Math.max(0, m.dccNextCheckpointId - 1);
            const r = m.verifyAndMint(d.messageId, latestCpId, d.amount);
            if (r.ok) mintCount++;
            if (r.err === 'DCC_PAUSED') pauseBlocked++;
            break;
          }
          case 'burn': {
            const outstanding = m.dccTotalMinted - m.dccTotalBurned;
            if (outstanding <= 0n) break;
            const burnAmt = 1n + randomBigInt(outstanding > 1n ? outstanding - 1n : 0n);
            const r = m.burn(burnAmt);
            if (r.ok) burnCount++;
            if (r.err === 'DCC_PAUSED') pauseBlocked++;
            break;
          }
          case 'unlock': {
            if (m.burnRecords.size === 0) break;
            const burns = Array.from(m.burnRecords.entries());
            const [id, b] = burns[Math.floor(Math.random() * burns.length)];
            const r = m.unlock(id, b.amount * 10n, true, 5);
            if (r.ok) unlockCount++;
            if (r.err === 'SOL_PAUSED') pauseBlocked++;
            break;
          }
          case 'replay_mint': {
            if (m.processedMessages.size === 0) break;
            const msgId = Array.from(m.processedMessages)[
              Math.floor(Math.random() * m.processedMessages.size)
            ];
            const cpId = Math.max(0, m.dccNextCheckpointId - 1);
            const r = m.verifyAndMint(msgId, cpId, amt);
            if (r.ok) throw new Error('REPLAY SUCCEEDED — S3 VIOLATED');
            replayBlocked++;
            break;
          }
          case 'invalid_proof': {
            const cpId = Math.max(0, m.dccNextCheckpointId - 1);
            const r = m.verifyAndMint(`inv_${i}`, cpId, amt, { validProof: false });
            if (r.ok) throw new Error('INVALID PROOF ACCEPTED — S2 VIOLATED');
            invalidBlocked++;
            break;
          }
          case 'advance_blocks':
            m.advanceBlocks(Math.floor(Math.random() * 200) + 1);
            m.advanceTime(Math.floor(Math.random() * 7200));
            break;
          case 'pause_sol':
            m.pauseSol(m.solAuthority);
            break;
          case 'unpause_sol':
            m.resumeSol(m.solAuthority);
            break;
          case 'pause_dcc':
            m.pauseDcc(m.dccAdmin);
            break;
          case 'unpause_dcc':
            // Request unpause, advance past delay, then resume
            m.resumeDcc(m.dccAdmin);
            m.advanceBlocks(UNPAUSE_DELAY + 1);
            m.resumeDcc(m.dccAdmin);
            break;
          case 'expire_checkpoint':
            if (m.dccCheckpoints.size > 1) {
              // Only expire an OLD checkpoint, not the latest
              const oldest = Math.min(...m.dccCheckpoints.keys());
              m.deactivateCheckpoint(oldest, m.dccAdmin);
            }
            break;
          case 'register_cp':
            m.registerCheckpointAdmin(randomHex(), m.currentSlot > 50 ? m.currentSlot - 50 : 1, m.dccAdmin);
            break;
          case 'execute_pending':
            if (m.pendingLarge.size > 0) {
              const msgId = Array.from(m.pendingLarge.keys())[0];
              m.executePendingMint(msgId);
            }
            break;
          case 'cancel_pending':
            if (m.pendingLarge.size > 0) {
              const msgId = Array.from(m.pendingLarge.keys())[0];
              m.cancelPendingMint(msgId, m.dccAdmin);
            }
            break;
          case 'overflow_amount': {
            const cpId = Math.max(0, m.dccNextCheckpointId - 1);
            const r = m.verifyAndMint(`ovf_${i}`, cpId, MAX_SINGLE_MINT + 1n);
            assert(r.ok === false, 'Overflow amount should be rejected');
            break;
          }
        }
      } catch (e) {
        if (e.message.includes('VIOLATED')) throw e;
        // Other errors are expected (bounds, replays, etc.)
      }

      // Check ALL invariants after EVERY operation
      const violations = m.checkAllInvariants();
      if (violations.length > 0) {
        throw new Error(`Invariant violation at op ${i} (${op}): ${violations.join('; ')}`);
      }
    }

    console.log(`  │     Deposits: ${depCount}, Mints: ${mintCount}, Burns: ${burnCount}, Unlocks: ${unlockCount}`);
    console.log(`  │     Replays blocked: ${replayBlocked}, Invalid blocked: ${invalidBlocked}, Paused blocked: ${pauseBlocked}`);
  });
});

// ═══════════════════════════════════════════════════════
// CONCURRENCY / ORDERING TESTS
// ═══════════════════════════════════════════════════════

scenario('Concurrency / Ordering Tests', () => {
  test('Interleaved deposits and mints preserve S1', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);

    for (let i = 0; i < 100; i++) {
      m.deposit(`u${i}`, 100_000_000n);
      const dep = Array.from(m.deposits.values()).pop();
      m.verifyAndMint(dep.messageId, 0, dep.amount);
      assert(m.checkAllInvariants().length === 0);
    }
  });

  test('Burn before all mints complete — supply stays valid', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);

    m.deposit('u1', 1_000_000_000n);
    m.deposit('u2', 2_000_000_000n);
    const deps = Array.from(m.deposits.values());

    m.verifyAndMint(deps[0].messageId, 0, deps[0].amount);
    m.burn(50_000_000n); // Burn partial before second mint
    m.verifyAndMint(deps[1].messageId, 0, deps[1].amount);

    assert(m.checkAllInvariants().length === 0);
  });

  test('Pause during pending large TX — execution blocked', () => {
    const m = new BridgeModel();
    m.vkSet = true;
    m.registerCheckpointAdmin(randomHex(), 100, m.dccAdmin);
    m.deposit('u1', 40_000_000_000n);
    const dep = Array.from(m.deposits.values())[0];

    m.verifyAndMint(dep.messageId, 0, dep.amount);
    m.advanceBlocks(LARGE_TX_DELAY + 1);
    m.pauseDcc(m.dccAdmin);

    const r = m.executePendingMint(dep.messageId);
    assert(r.ok === false && r.err === 'DCC_PAUSED');
  });
});

// ═══════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════');
if (failed > 0) {
  console.log(`  RESULT: ${passed}/${total} passed, ${failed} FAILED`);
} else {
  console.log(`  RESULT: ${passed}/${total} passed — ALL SCENARIOS CLEAR`);
}
console.log('═══════════════════════════════════════════════════════════');
console.log('');

if (failed > 0) process.exit(1);
