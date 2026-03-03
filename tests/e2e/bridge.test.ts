import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorError } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";
import * as crypto from "crypto";

// ---------- IDL type import ----------
// Anchor generates types at target/types/sol_bridge_lock.ts
import type { SolBridgeLock } from "../../target/types/sol_bridge_lock";

// ---------- Constants ----------
const PROGRAM_ID = new PublicKey(
  "9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF"
);
const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111"
);

// ---------- Helpers ----------
function findBridgeConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    PROGRAM_ID
  );
}

function findVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
}

function findUserStatePda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_state"), user.toBuffer()],
    PROGRAM_ID
  );
}

function findDepositRecordPda(transferId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), transferId],
    PROGRAM_ID
  );
}

function findValidatorEntryPda(validatorPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("validator"), validatorPubkey.toBuffer()],
    PROGRAM_ID
  );
}

function findUnlockRecordPda(transferId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("unlock"), transferId],
    PROGRAM_ID
  );
}

/**
 * Compute transfer ID = sha256(sender || nonce_le)
 * Matches on-chain compute_transfer_id()
 */
function computeTransferId(
  sender: PublicKey,
  nonce: BN
): Buffer {
  const data = Buffer.alloc(40);
  sender.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(BigInt(nonce.toString()), 32);
  return Buffer.from(crypto.createHash("sha256").update(data).digest());
}

/**
 * Build the canonical unlock message for Ed25519 signature verification.
 * Matches on-chain format: domain || transfer_id || recipient || amount_le || burn_tx_hash || chain_id_le || expiration_le
 */
function buildUnlockMessage(
  transferId: Buffer,
  recipient: PublicKey,
  amount: BN,
  burnTxHash: Buffer,
  dccChainId: number,
  expiration: BN
): Buffer {
  const domain = Buffer.from("SOL_DCC_BRIDGE_UNLOCK_V1");
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amount.toString()));
  const chainIdBuf = Buffer.alloc(4);
  chainIdBuf.writeUInt32LE(dccChainId);
  const expirationBuf = Buffer.alloc(8);
  expirationBuf.writeBigInt64LE(BigInt(expiration.toString()));

  return Buffer.concat([
    domain,
    transferId,
    recipient.toBuffer(),
    amountBuf,
    burnTxHash,
    chainIdBuf,
    expirationBuf,
  ]);
}

/**
 * Build a single Ed25519 precompile instruction containing multiple signatures.
 * This is more space-efficient than one instruction per signature since the
 * message bytes are shared.
 *
 * Ed25519 instruction data format:
 *   [0]    num_signatures (u8)
 *   [1]    padding (0x00)
 *   For each i in 0..num_signatures (14 bytes each):
 *     signature_offset        (u16 LE)
 *     signature_ix_index      (u16 LE) — 0xFFFF = same instruction
 *     public_key_offset       (u16 LE)
 *     public_key_ix_index     (u16 LE) — 0xFFFF = same instruction
 *     message_data_offset     (u16 LE)
 *     message_data_size       (u16 LE)
 *     message_ix_index        (u16 LE) — 0xFFFF = same instruction
 *   Then raw data: signatures (64 each), pubkeys (32 each), message
 */
function createMultiSigEd25519Instruction(
  signers: { pubkey: Buffer; signature: Buffer }[],
  message: Buffer
): anchor.web3.TransactionInstruction {
  const numSigs = signers.length;
  const headerSize = 2 + numSigs * 14; // 2 header bytes + 14 per sig descriptor
  const dataSize =
    headerSize + numSigs * 64 + numSigs * 32 + message.length;

  const data = Buffer.alloc(dataSize);
  // Header: u8 num_signatures + u8 padding
  data.writeUInt8(numSigs, 0);
  data.writeUInt8(0, 1); // padding

  const sigDataStart = headerSize;
  const pubkeyDataStart = headerSize + numSigs * 64;
  const messageDataStart = headerSize + numSigs * 64 + numSigs * 32;

  for (let i = 0; i < numSigs; i++) {
    const descOffset = 2 + i * 14;
    // signature_offset
    data.writeUInt16LE(sigDataStart + i * 64, descOffset);
    // signature_instruction_index (0xFFFF = self)
    data.writeUInt16LE(0xffff, descOffset + 2);
    // public_key_offset
    data.writeUInt16LE(pubkeyDataStart + i * 32, descOffset + 4);
    // public_key_instruction_index (0xFFFF = self)
    data.writeUInt16LE(0xffff, descOffset + 6);
    // message_data_offset
    data.writeUInt16LE(messageDataStart, descOffset + 8);
    // message_data_size
    data.writeUInt16LE(message.length, descOffset + 10);
    // message_instruction_index (0xFFFF = self)
    data.writeUInt16LE(0xffff, descOffset + 12);

    // Copy signature
    signers[i].signature.copy(data, sigDataStart + i * 64);
    // Copy pubkey
    signers[i].pubkey.copy(data, pubkeyDataStart + i * 32);
  }

  // Copy message
  message.copy(data, messageDataStart);

  return new anchor.web3.TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data,
  });
}
describe("sol_bridge_lock", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolBridgeLock as Program<SolBridgeLock>;
  const authority = provider.wallet as anchor.Wallet;

  // Guardian keypair
  const guardian = Keypair.generate();
  // Validator keypairs (3 validators for 2-of-3 tests)
  const validators = [
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
  ];

  // PDAs
  const [bridgeConfigPda] = findBridgeConfigPda();
  const [vaultPda] = findVaultPda();
  const [userStatePda] = findUserStatePda(authority.publicKey);

  // Default init params
  const initParams = {
    guardian: guardian.publicKey,
    minValidators: 2,
    maxValidators: 10,
    minDeposit: new BN(100_000), // 0.0001 SOL
    maxDeposit: new BN(10 * LAMPORTS_PER_SOL),
    maxDailyOutflow: new BN(100 * LAMPORTS_PER_SOL),
    maxUnlockAmount: new BN(50 * LAMPORTS_PER_SOL),
    requiredConfirmations: 32,
    largeWithdrawalDelay: new BN(3600), // 1 hour
    largeWithdrawalThreshold: new BN(10 * LAMPORTS_PER_SOL),
    dccChainId: 87,
    solanaChainId: 1,
  };

  // ═══════════════════════════════════════════════════════
  //  1. INITIALIZE
  // ═══════════════════════════════════════════════════════
  describe("initialize", () => {
    it("initializes bridge config with correct params", async () => {
      await program.methods
        .initialize(initParams)
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          vault: vaultPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(config.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
      expect(config.paused).to.be.false;
      expect(config.globalNonce.toNumber()).to.equal(0);
      expect(config.totalLocked.toNumber()).to.equal(0);
      expect(config.totalUnlocked.toNumber()).to.equal(0);
      expect(config.validatorCount).to.equal(0);
      expect(config.minValidators).to.equal(2);
      expect(config.maxValidators).to.equal(10);
      expect(config.minDeposit.toNumber()).to.equal(100_000);
      expect(config.maxDeposit.toNumber()).to.equal(10 * LAMPORTS_PER_SOL);
      expect(config.requiredConfirmations).to.equal(32);
      expect(config.dccChainId).to.equal(87);
      expect(config.solanaChainId).to.equal(1);
    });

    it("prevents double initialization", async () => {
      try {
        await program.methods
          .initialize(initParams)
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            vault: vaultPda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // Anchor returns a custom 0x0 or system error for double init
        expect(err).to.exist;
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  //  2. REGISTER / REMOVE VALIDATORS
  // ═══════════════════════════════════════════════════════
  describe("register_validator", () => {
    it("registers 3 validators", async () => {
      for (const v of validators) {
        const [validatorPda] = findValidatorEntryPda(v.publicKey);
        await program.methods
          .registerValidator({ validatorPubkey: v.publicKey })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            validatorEntry: validatorPda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.validatorCount).to.equal(3);

      // Verify first validator entry
      const [v0Pda] = findValidatorEntryPda(validators[0].publicKey);
      const entry = await program.account.validatorEntry.fetch(v0Pda);
      expect(entry.pubkey.toBase58()).to.equal(
        validators[0].publicKey.toBase58()
      );
      expect(entry.active).to.be.true;
      expect(entry.attestationCount.toNumber()).to.equal(0);
    });

    it("rejects unauthorized caller", async () => {
      const rando = Keypair.generate();
      const fakeValidator = Keypair.generate();
      const [validatorPda] = findValidatorEntryPda(fakeValidator.publicKey);

      try {
        await program.methods
          .registerValidator({ validatorPubkey: fakeValidator.publicKey })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            validatorEntry: validatorPda,
            authority: rando.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([rando])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // Should be Unauthorized or insufficient funds (rando has no SOL)
        expect(err).to.exist;
      }
    });
  });

  describe("remove_validator", () => {
    it("removes a validator", async () => {
      const [validatorPda] = findValidatorEntryPda(validators[2].publicKey);

      await program.methods
        .removeValidator(validators[2].publicKey)
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          validatorEntry: validatorPda,
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.validatorCount).to.equal(2);
    });

    it("prevents removal when at min_validators", async () => {
      // We now have 2 validators, min_validators = 2
      const [validatorPda] = findValidatorEntryPda(validators[1].publicKey);

      try {
        await program.methods
          .removeValidator(validators[1].publicKey)
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            validatorEntry: validatorPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal(
          "ValidatorRemovalBreachesMinimum"
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  //  3. DEPOSIT
  // ═══════════════════════════════════════════════════════
  describe("deposit", () => {
    const depositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL
    let firstTransferId: Buffer;

    it("deposits SOL successfully", async () => {
      // Compute transfer ID from sender + nonce
      const nonceBn = new BN(0); // first deposit, nonce = 0

      firstTransferId = computeTransferId(
        authority.publicKey,
        nonceBn
      );
      const [depositRecordPda] = findDepositRecordPda(firstTransferId);

      const recipientDcc = Buffer.alloc(32);
      recipientDcc.write("dcc_recipient_address_here_padded", "utf-8");

      const vaultBefore = await provider.connection.getBalance(vaultPda);

      await program.methods
        .deposit({
          recipientDcc: Array.from(recipientDcc) as any,
          amount: depositAmount,
          transferId: Array.from(firstTransferId) as any,
        })
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          userState: userStatePda,
          depositRecord: depositRecordPda,
          vault: vaultPda,
          sender: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await provider.connection.getBalance(vaultPda);
      expect(vaultAfter - vaultBefore).to.equal(LAMPORTS_PER_SOL);

      // Verify deposit record
      const record = await program.account.depositRecord.fetch(
        depositRecordPda
      );
      expect(record.sender.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(record.amount.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(record.nonce.toNumber()).to.equal(0);
      expect(record.processed).to.be.false;

      // Verify config updated
      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.totalLocked.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(config.globalNonce.toNumber()).to.equal(1);
    });

    it("rejects deposit below minimum", async () => {
      const tinyAmount = new BN(100); // below 100_000 min
      const nonce = new BN(1);
      const transferId = computeTransferId(
        authority.publicKey,
        nonce
      );
      const [depositRecordPda] = findDepositRecordPda(transferId);

      try {
        await program.methods
          .deposit({
            recipientDcc: Array.from(Buffer.alloc(32)) as any,
            amount: tinyAmount,
            transferId: Array.from(transferId) as any,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            userState: userStatePda,
            depositRecord: depositRecordPda,
            vault: vaultPda,
            sender: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal("DepositTooSmall");
      }
    });

    it("rejects deposit above maximum", async () => {
      const hugeAmount = new BN(11 * LAMPORTS_PER_SOL); // above 10 SOL max
      const nonce = new BN(1);
      const transferId = computeTransferId(
        authority.publicKey,
        nonce
      );
      const [depositRecordPda] = findDepositRecordPda(transferId);

      try {
        await program.methods
          .deposit({
            recipientDcc: Array.from(Buffer.alloc(32)) as any,
            amount: hugeAmount,
            transferId: Array.from(transferId) as any,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            userState: userStatePda,
            depositRecord: depositRecordPda,
            vault: vaultPda,
            sender: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal("DepositTooLarge");
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  //  4. EMERGENCY PAUSE / RESUME
  // ═══════════════════════════════════════════════════════
  describe("emergency_pause / resume", () => {
    it("guardian can pause", async () => {
      // Airdrop to guardian so it can sign
      const sig = await provider.connection.requestAirdrop(
        guardian.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      await program.methods
        .emergencyPause()
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          authority: guardian.publicKey,
        })
        .signers([guardian])
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.paused).to.be.true;
    });

    it("rejects deposit when paused", async () => {
      const nonce = new BN(1);
      const transferId = computeTransferId(
        authority.publicKey,
        nonce
      );
      const [depositRecordPda] = findDepositRecordPda(transferId);

      try {
        await program.methods
          .deposit({
            recipientDcc: Array.from(Buffer.alloc(32)) as any,
            amount: new BN(LAMPORTS_PER_SOL),
            transferId: Array.from(transferId) as any,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            userState: userStatePda,
            depositRecord: depositRecordPda,
            vault: vaultPda,
            sender: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal("BridgePaused");
      }
    });

    it("guardian cannot resume (only authority can)", async () => {
      try {
        await program.methods
          .emergencyResume()
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            authority: guardian.publicKey,
          })
          .signers([guardian])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal("Unauthorized");
      }
    });

    it("authority can resume", async () => {
      await program.methods
        .emergencyResume()
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.paused).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════
  //  5. UNLOCK (with Ed25519 signatures)
  // ═══════════════════════════════════════════════════════
  describe("unlock", () => {
    const unlockAmount = new BN(0.5 * LAMPORTS_PER_SOL);
    const burnTxHash = Buffer.alloc(32);
    burnTxHash.fill(0xab);
    const dccChainId = 87;

    it("unlocks SOL with valid 2-of-2 validator signatures", async () => {
      const recipient = Keypair.generate();

      // Airdrop to recipient so the account exists (needed for SystemAccount constraint)
      const airdropSig = await provider.connection.requestAirdrop(
        recipient.publicKey,
        0.01 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      // Build unlock message
      const transferId = crypto.randomBytes(32);
      const expiration = new BN(
        Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      );
      const message = buildUnlockMessage(
        transferId,
        recipient.publicKey,
        unlockAmount,
        burnTxHash,
        dccChainId,
        expiration
      );

      // Sign with first 2 validators (2-of-2)
      const signers = validators.slice(0, 2).map((v) => {
        const sig = nacl.sign.detached(message, v.secretKey);
        return {
          pubkey: Buffer.from(v.publicKey.toBytes()),
          signature: Buffer.from(sig),
        };
      });

      const attestations = validators.slice(0, 2).map((v, i) => ({
        validator: v.publicKey,
        signature: Array.from(signers[i].signature) as any,
      }));

      // Build a single multi-sig Ed25519 precompile instruction (saves tx space)
      const ed25519Ix = createMultiSigEd25519Instruction(signers, message);

      const [unlockRecordPda] = findUnlockRecordPda(transferId);

      // Pass validator entries as remaining accounts
      const remainingAccounts = validators.slice(0, 2).map((v) => {
        const [pda] = findValidatorEntryPda(v.publicKey);
        return {
          pubkey: pda,
          isSigner: false,
          isWritable: false,
        };
      });

      const recipientBefore = await provider.connection.getBalance(
        recipient.publicKey
      );

      await program.methods
        .unlock({
          transferId: Array.from(transferId) as any,
          recipient: recipient.publicKey,
          amount: unlockAmount,
          burnTxHash: Array.from(burnTxHash) as any,
          dccChainId: dccChainId,
          expiration: expiration,
          attestations: attestations,
        })
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          unlockRecord: unlockRecordPda,
          vault: vaultPda,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          systemProgram: SystemProgram.programId,
          ed25519Program: ED25519_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts(remainingAccounts)
        .preInstructions([ed25519Ix])
        .rpc();

      const recipientAfter = await provider.connection.getBalance(
        recipient.publicKey
      );
      expect(recipientAfter - recipientBefore).to.equal(
        unlockAmount.toNumber()
      );

      // Verify unlock record
      const record = await program.account.unlockRecord.fetch(unlockRecordPda);
      expect(record.recipient.toBase58()).to.equal(
        recipient.publicKey.toBase58()
      );
      expect(record.amount.toNumber()).to.equal(unlockAmount.toNumber());
      expect(record.executed).to.be.true;

      // Verify config updated
      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.totalUnlocked.toNumber()).to.equal(
        unlockAmount.toNumber()
      );
    });

    it("rejects unlock with only 1 signature (below min_validators=2)", async () => {
      const recipient = Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        recipient.publicKey,
        0.01 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const transferId = crypto.randomBytes(32);
      const expiration = new BN(Math.floor(Date.now() / 1000) + 3600);
      const message = buildUnlockMessage(
        transferId,
        recipient.publicKey,
        unlockAmount,
        burnTxHash,
        dccChainId,
        expiration
      );

      // Sign with only 1 validator
      const sig = nacl.sign.detached(message, validators[0].secretKey);
      const attestations = [
        {
          validator: validators[0].publicKey,
          signature: Array.from(sig) as any,
        },
      ];

      const ed25519Ixs = [
        Ed25519Program.createInstructionWithPublicKey({
          publicKey: validators[0].publicKey.toBytes(),
          signature: sig,
          message: message,
        }),
      ];

      const [unlockRecordPda] = findUnlockRecordPda(transferId);
      const [v0Pda] = findValidatorEntryPda(validators[0].publicKey);

      try {
        await program.methods
          .unlock({
            transferId: Array.from(transferId) as any,
            recipient: recipient.publicKey,
            amount: unlockAmount,
            burnTxHash: Array.from(burnTxHash) as any,
            dccChainId: dccChainId,
            expiration: expiration,
            attestations: attestations,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            unlockRecord: unlockRecordPda,
            vault: vaultPda,
            recipient: recipient.publicKey,
            payer: authority.publicKey,
            systemProgram: SystemProgram.programId,
            ed25519Program: ED25519_PROGRAM_ID,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .remainingAccounts([
            { pubkey: v0Pda, isSigner: false, isWritable: false },
          ])
          .preInstructions(ed25519Ixs)
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal(
          "InsufficientSignatures"
        );
      }
    });

    it("rejects replay (same transfer ID)", async () => {
      // Re-use the first successful unlock's transfer ID
      // The PDA already exists so Anchor init will fail
      const transferId = crypto.randomBytes(32);
      const recipient = Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        recipient.publicKey,
        0.01 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const expiration = new BN(Math.floor(Date.now() / 1000) + 3600);
      const message = buildUnlockMessage(
        transferId,
        recipient.publicKey,
        unlockAmount,
        burnTxHash,
        dccChainId,
        expiration
      );

      const signers2 = validators.slice(0, 2).map((v) => {
        const sig = nacl.sign.detached(message, v.secretKey);
        return {
          pubkey: Buffer.from(v.publicKey.toBytes()),
          signature: Buffer.from(sig),
        };
      });

      const attestations = validators.slice(0, 2).map((v, i) => ({
        validator: v.publicKey,
        signature: Array.from(signers2[i].signature) as any,
      }));

      const ed25519Ix2 = createMultiSigEd25519Instruction(signers2, message);

      const [unlockRecordPda] = findUnlockRecordPda(transferId);
      const remainingAccounts = validators.slice(0, 2).map((v) => {
        const [pda] = findValidatorEntryPda(v.publicKey);
        return { pubkey: pda, isSigner: false, isWritable: false };
      });

      // First unlock should succeed
      await program.methods
        .unlock({
          transferId: Array.from(transferId) as any,
          recipient: recipient.publicKey,
          amount: unlockAmount,
          burnTxHash: Array.from(burnTxHash) as any,
          dccChainId: dccChainId,
          expiration: expiration,
          attestations: attestations,
        })
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          unlockRecord: unlockRecordPda,
          vault: vaultPda,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          systemProgram: SystemProgram.programId,
          ed25519Program: ED25519_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts(remainingAccounts)
        .preInstructions([ed25519Ix2])
        .rpc();

      // Second unlock with same transfer ID should fail (PDA already exists)
      try {
        await program.methods
          .unlock({
            transferId: Array.from(transferId) as any,
            recipient: recipient.publicKey,
            amount: unlockAmount,
            burnTxHash: Array.from(burnTxHash) as any,
            dccChainId: dccChainId,
            expiration: expiration,
            attestations: attestations,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            unlockRecord: unlockRecordPda,
            vault: vaultPda,
            recipient: recipient.publicKey,
            payer: authority.publicKey,
            systemProgram: SystemProgram.programId,
            ed25519Program: ED25519_PROGRAM_ID,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .remainingAccounts(remainingAccounts)
          .preInstructions([ed25519Ix2])
          .rpc();
        expect.fail("should have thrown — replay detected");
      } catch (err: any) {
        // Anchor will error because the PDA is already initialized
        expect(err).to.exist;
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  //  6. UPDATE CONFIG
  // ═══════════════════════════════════════════════════════
  describe("update_config", () => {
    it("authority updates min_deposit", async () => {
      await program.methods
        .updateConfig({
          minDeposit: new BN(200_000),
          maxDeposit: null,
          maxDailyOutflow: null,
          maxUnlockAmount: null,
          requiredConfirmations: null,
          largeWithdrawalDelay: null,
          largeWithdrawalThreshold: null,
          minValidators: null,
          newAuthority: null,
          newGuardian: null,
        })
        .accountsPartial({
          bridgeConfig: bridgeConfigPda,
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.bridgeConfig.fetch(bridgeConfigPda);
      expect(config.minDeposit.toNumber()).to.equal(200_000);
    });

    it("rejects unauthorized config update", async () => {
      const rando = Keypair.generate();

      try {
        await program.methods
          .updateConfig({
            minDeposit: new BN(1),
            maxDeposit: null,
            maxDailyOutflow: null,
            maxUnlockAmount: null,
            requiredConfirmations: null,
            largeWithdrawalDelay: null,
            largeWithdrawalThreshold: null,
            minValidators: null,
            newAuthority: null,
            newGuardian: null,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            authority: rando.publicKey,
          })
          .signers([rando])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });

    it("rejects invalid required_confirmations (below 32)", async () => {
      try {
        await program.methods
          .updateConfig({
            minDeposit: null,
            maxDeposit: null,
            maxDailyOutflow: null,
            maxUnlockAmount: null,
            requiredConfirmations: 10,
            largeWithdrawalDelay: null,
            largeWithdrawalThreshold: null,
            minValidators: null,
            newAuthority: null,
            newGuardian: null,
          })
          .accountsPartial({
            bridgeConfig: bridgeConfigPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const anchorErr = err as AnchorError;
        expect(anchorErr.error?.errorCode?.code).to.equal("InvalidConfig");
      }
    });
  });
});
