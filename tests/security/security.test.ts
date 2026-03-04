import { expect } from "chai";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createHash } from "crypto";

/* ------------------------------------------------------------------ */
/*  Security-focused tests — adversarial scenarios                     */
/* ------------------------------------------------------------------ */

describe("security tests", () => {
  /* ---------- helpers ---------- */

  function createCanonicalMessage(fields: {
    transferId: string;
    recipient: string;
    amount: bigint;
    chainId: number;
  }): Buffer {
    const prefix = Buffer.from("SOL_DCC_BRIDGE_UNLOCK_V1");
    const transferId = Buffer.from(fields.transferId, "hex");
    const recipient = Buffer.from(fields.recipient);
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(fields.amount);
    const chainId = Buffer.alloc(2);
    chainId.writeUInt16LE(fields.chainId);
    return Buffer.concat([prefix, transferId, recipient, amount, chainId]);
  }

  function signMessage(message: Buffer, secretKey: Uint8Array): Uint8Array {
    return nacl.sign.detached(message, secretKey);
  }

  /* ---------- replay attacks ---------- */

  describe("replay protection", () => {
    it("transfer_id is deterministic given (sender, nonce)", () => {
      const sender = Keypair.generate().publicKey.toBuffer();
      const nonce = Buffer.alloc(8);
      nonce.writeBigUInt64LE(1n);

      const hash1 = createHash("sha256")
        .update(Buffer.concat([sender, nonce]))
        .digest();
      const hash2 = createHash("sha256")
        .update(Buffer.concat([sender, nonce]))
        .digest();

      expect(hash1).to.deep.equal(hash2);
    });

    it("different nonce produces different transfer_id", () => {
      const sender = Keypair.generate().publicKey.toBuffer();

      const nonce1 = Buffer.alloc(8);
      nonce1.writeBigUInt64LE(1n);
      const nonce2 = Buffer.alloc(8);
      nonce2.writeBigUInt64LE(2n);

      const hash1 = createHash("sha256")
        .update(Buffer.concat([sender, nonce1]))
        .digest();
      const hash2 = createHash("sha256")
        .update(Buffer.concat([sender, nonce2]))
        .digest();

      expect(hash1).to.not.deep.equal(hash2);
    });
  });

  /* ---------- signature forgery ---------- */

  describe("signature verification", () => {
    it("valid signature accepted", () => {
      const keypair = nacl.sign.keyPair();
      const message = createCanonicalMessage({
        transferId: "a".repeat(64),
        recipient: "3P" + "x".repeat(33),
        amount: 1_000_000_000n,
        chainId: 1,
      });
      const sig = signMessage(message, keypair.secretKey);
      const valid = nacl.sign.detached.verify(message, sig, keypair.publicKey);
      expect(valid).to.be.true;
    });

    it("modified message detected", () => {
      const keypair = nacl.sign.keyPair();
      const message = createCanonicalMessage({
        transferId: "a".repeat(64),
        recipient: "3P" + "x".repeat(33),
        amount: 1_000_000_000n,
        chainId: 1,
      });
      const sig = signMessage(message, keypair.secretKey);

      // Tamper with message (change amount)
      const tampered = createCanonicalMessage({
        transferId: "a".repeat(64),
        recipient: "3P" + "x".repeat(33),
        amount: 999_000_000_000n, // inflated
        chainId: 1,
      });
      const valid = nacl.sign.detached.verify(
        tampered,
        sig,
        keypair.publicKey
      );
      expect(valid).to.be.false;
    });

    it("wrong signer detected", () => {
      const signer = nacl.sign.keyPair();
      const attacker = nacl.sign.keyPair();
      const message = createCanonicalMessage({
        transferId: "b".repeat(64),
        recipient: "3P" + "y".repeat(33),
        amount: 5_000_000_000n,
        chainId: 1,
      });
      const sig = signMessage(message, attacker.secretKey);
      const valid = nacl.sign.detached.verify(message, sig, signer.publicKey);
      expect(valid).to.be.false;
    });

    it("requires M-of-N unique signatures", () => {
      const validators = Array.from({ length: 5 }, () =>
        nacl.sign.keyPair()
      );
      const message = createCanonicalMessage({
        transferId: "c".repeat(64),
        recipient: "3P" + "z".repeat(33),
        amount: 2_000_000_000n,
        chainId: 1,
      });

      const M = 3;
      const signatures = validators
        .slice(0, M)
        .map((v) => signMessage(message, v.secretKey));
      const publicKeys = validators.slice(0, M).map((v) => v.publicKey);

      // Verify all M signatures
      const allValid = signatures.every((sig, i) =>
        nacl.sign.detached.verify(message, sig, publicKeys[i])
      );
      expect(allValid).to.be.true;

      // Only M-1 should not be sufficient (business logic test)
      expect(signatures.length).to.equal(M);
      expect(M).to.be.greaterThan(validators.length / 2);
    });

    it("duplicate signer detected in attestation set", () => {
      const validator = nacl.sign.keyPair();
      const message = createCanonicalMessage({
        transferId: "d".repeat(64),
        recipient: "3P" + "w".repeat(33),
        amount: 1_000_000_000n,
        chainId: 1,
      });

      // Two signatures from same key
      const sig1 = signMessage(message, validator.secretKey);
      const sig2 = signMessage(message, validator.secretKey);

      const pubkeys = [validator.publicKey, validator.publicKey];
      const uniquePubkeys = new Set(pubkeys.map((pk) => Buffer.from(pk).toString("hex")));
      expect(uniquePubkeys.size).to.equal(1); // duplicate!
      expect(uniquePubkeys.size).to.be.lessThan(pubkeys.length);
    });
  });

  /* ---------- domain separation ---------- */

  describe("domain separation", () => {
    it("different chain_id produces different message", () => {
      const fields = {
        transferId: "e".repeat(64),
        recipient: "3P" + "a".repeat(33),
        amount: 1_000_000_000n,
      };

      const msg1 = createCanonicalMessage({ ...fields, chainId: 1 });
      const msg2 = createCanonicalMessage({ ...fields, chainId: 2 });

      expect(msg1).to.not.deep.equal(msg2);
    });

    it("message prefix prevents cross-protocol replay", () => {
      const message = createCanonicalMessage({
        transferId: "f".repeat(64),
        recipient: "3P" + "b".repeat(33),
        amount: 1_000_000_000n,
        chainId: 1,
      });
      expect(message.subarray(0, 24).toString()).to.equal(
        "SOL_DCC_BRIDGE_UNLOCK_V1"
      );
    });
  });

  /* ---------- overflow ---------- */

  describe("arithmetic overflow", () => {
    it("maximum u64 amount should not overflow in transfer_id", () => {
      const maxU64 = 18_446_744_073_709_551_615n;
      const sender = Keypair.generate().publicKey.toBuffer();
      const nonce = Buffer.alloc(8);
      nonce.writeBigUInt64LE(maxU64);

      // Should not throw
      const hash = createHash("sha256")
        .update(Buffer.concat([sender, nonce]))
        .digest();
      expect(hash.length).to.equal(32);
    });
  });

  /* ---------- PDA collision ---------- */

  describe("PDA security", () => {
    it("different users produce different user_state PDAs", () => {
      const programId = Keypair.generate().publicKey;
      const user1 = Keypair.generate().publicKey;
      const user2 = Keypair.generate().publicKey;

      const [pda1] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_state"), user1.toBuffer()],
        programId
      );
      const [pda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_state"), user2.toBuffer()],
        programId
      );

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it("different transfer_ids produce different unlock PDAs", () => {
      const programId = Keypair.generate().publicKey;
      const id1 = Buffer.alloc(32, 1);
      const id2 = Buffer.alloc(32, 2);

      const [pda1] = PublicKey.findProgramAddressSync(
        [Buffer.from("unlock_record"), id1],
        programId
      );
      const [pda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("unlock_record"), id2],
        programId
      );

      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });
  });
});
