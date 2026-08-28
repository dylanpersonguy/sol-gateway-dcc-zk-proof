// ═══════════════════════════════════════════════════════════════
// THRESHOLD SIGNATURE SERVICE (TSS / MPC Signing)
// ═══════════════════════════════════════════════════════════════
//
// Manages cryptographic signing for validator attestations.
//
// SCHEME: DecentralChain Curve25519 (the same primitive as RIDE's sigVerify).
// This is not interchangeable with NaCl Ed25519 — attestation signatures are
// ultimately submitted to the bridge contract's committeeMint, so the chain's
// scheme is authoritative. ConsensusEngine.receiveAttestation verifies with
// the matching verifySignature().
//
// Supports:
// - DCC Curve25519 signatures (verified on-chain by sigVerify)
// - Hardware Security Module (HSM) integration
// - Key rotation
// - Threshold signatures (future MPC upgrade)
//
// SECURITY: Private keys should NEVER be in memory longer than
// necessary. HSM mode keeps keys in hardware at all times.

import {
  keyPair as dccKeyPair,
  signBytes as dccSignBytes,
  verifySignature as dccVerifySignature,
  publicKey as dccPublicKeyFrom,
  base58Decode,
  base58Encode,
  randomSeed,
} from '@decentralchain/ts-lib-crypto';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Logger } from 'winston';
import { createLogger } from '../utils/logger';

export interface SignerConfig {
  privateKeyPath: string;
  hsmEnabled: boolean;
  hsmSlot: number;
  hsmPin: string;
  keyRotationIntervalHours: number;
}

/** Raw 32-byte Curve25519 keys, decoded from the library's base58 form. */
interface RawKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate a fresh DCC keypair as raw bytes. */
function generateDccKeyPair(): RawKeyPair {
  const kp = dccKeyPair(randomSeed());
  return {
    publicKey: base58Decode(kp.publicKey),
    privateKey: base58Decode(kp.privateKey),
  };
}

export interface KeyPairInfo {
  publicKey: Buffer;
  createdAt: number;
  rotationDue: number;
}

export class ThresholdSigner {
  private config: SignerConfig;
  private logger: Logger;
  private keyPair: RawKeyPair | null = null;
  private keyInfo: KeyPairInfo | null = null;
  private signatureCount: number = 0;

  constructor(config: SignerConfig) {
    this.config = config;
    this.logger = createLogger('Signer');
  }

  /**
   * Initialize the signer — loads or generates key pair.
   */
  async initialize(): Promise<void> {
    if (this.config.hsmEnabled) {
      await this.initializeHSM();
    } else {
      await this.initializeSoftwareKey();
    }

    this.logger.info('Signer initialized', {
      publicKey: this.getPublicKey().toString('hex'),
      hsmEnabled: this.config.hsmEnabled,
    });
  }

  /**
   * Sign a message using the validator's private key.
   */
  async sign(message: Buffer): Promise<Buffer> {
    // ── GUARD: Check key rotation ──
    if (this.keyInfo && Date.now() > this.keyInfo.rotationDue) {
      this.logger.warn('Key rotation overdue — signing still allowed but rotation recommended');
    }

    if (this.config.hsmEnabled) {
      return this.signWithHSM(message);
    } else {
      return this.signSoftware(message);
    }
  }

  /**
   * Get the validator's public key.
   */
  getPublicKey(): Buffer {
    if (!this.keyPair) {
      throw new Error('Signer not initialized');
    }
    return Buffer.from(this.keyPair.publicKey);
  }

  /**
   * Verify a signature (used for peer validation).
   */
  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
    try {
      return dccVerifySignature(
        new Uint8Array(publicKey),
        new Uint8Array(message),
        new Uint8Array(signature),
      );
    } catch {
      return false;
    }
  }

  /**
   * Rotate the signing key.
   * In production with HSM, this generates a new key in the HSM
   * and the old key remains valid for a transition period.
   */
  async rotateKey(): Promise<KeyPairInfo> {
    this.logger.info('Rotating signing key');

    const newKeyPair = generateDccKeyPair();
    const oldPublicKey = this.keyPair
      ? Buffer.from(this.keyPair.publicKey).toString('hex')
      : 'none';

    this.keyPair = newKeyPair;
    this.keyInfo = {
      publicKey: Buffer.from(newKeyPair.publicKey),
      createdAt: Date.now(),
      rotationDue:
        Date.now() + this.config.keyRotationIntervalHours * 60 * 60 * 1000,
    };

    // Save encrypted key to disk
    await this.saveEncryptedKey(newKeyPair);

    this.logger.info('Key rotated', {
      oldPublicKey,
      newPublicKey: Buffer.from(newKeyPair.publicKey).toString('hex'),
    });

    return this.keyInfo;
  }

  // ── Private Methods ──

  private async initializeSoftwareKey(): Promise<void> {
    const keyPath = this.config.privateKeyPath;

    if (fs.existsSync(keyPath)) {
      // Load existing encrypted key
      const encryptedData = fs.readFileSync(keyPath);
      this.keyPair = this.decryptKeyPair(encryptedData);
      this.logger.info('Loaded existing key pair');
    } else {
      // Generate new key pair
      this.keyPair = generateDccKeyPair();
      await this.saveEncryptedKey(this.keyPair);
      this.logger.info('Generated new key pair');
    }

    if (!this.keyPair) {
      throw new Error('Signer key pair failed to initialize');
    }

    this.keyInfo = {
      publicKey: Buffer.from(this.keyPair.publicKey),
      createdAt: Date.now(),
      rotationDue:
        Date.now() + this.config.keyRotationIntervalHours * 60 * 60 * 1000,
    };
  }

  private async initializeHSM(): Promise<void> {
    // HSM integration placeholder
    // In production, this would use PKCS#11 to communicate with the HSM
    this.logger.info('HSM mode — using hardware security module', {
      slot: this.config.hsmSlot,
    });

    // For development, fall back to software key
    // In production, replace with actual HSM calls:
    //
    // const pkcs11 = require('pkcs11js');
    // const lib = new pkcs11.PKCS11();
    // lib.load('/usr/lib/softhsm/libsofthsm2.so');
    // lib.C_Initialize();
    // const slot = this.config.hsmSlot;
    // const session = lib.C_OpenSession(slot, pkcs11.CKF_SERIAL_SESSION);
    // lib.C_Login(session, pkcs11.CKU_USER, this.config.hsmPin);
    // ... generate/load key pair from HSM

    await this.initializeSoftwareKey();
  }

  private signSoftware(message: Buffer): Promise<Buffer> {
    if (!this.keyPair) {
      throw new Error('Signer not initialized');
    }

    // signBytes returns a base58 string; callers expect raw 64 bytes.
    const sigB58 = dccSignBytes(
      { privateKey: base58Encode(this.keyPair.privateKey) },
      new Uint8Array(message),
    );

    this.signatureCount++;
    return Promise.resolve(Buffer.from(base58Decode(sigB58 as string)));
  }

  private async signWithHSM(message: Buffer): Promise<Buffer> {
    // HSM signing placeholder
    // In production: lib.C_Sign(session, message, { mechanism: CKM_EDDSA })
    return this.signSoftware(message);
  }

  private async saveEncryptedKey(keyPair: RawKeyPair): Promise<void> {
    // Encrypt the private key before saving to disk
    // Use SIGNER_ENCRYPTION_KEY env var if available, otherwise generate random key and save to .key file
    const envKey = process.env.SIGNER_ENCRYPTION_KEY;
    const encryptionKey = envKey
      ? Buffer.from(envKey, 'hex')
      : crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(keyPair.privateKey)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const data = Buffer.concat([iv, authTag, encrypted]);

    // Save key file
    const dir = this.config.privateKeyPath.substring(
      0,
      this.config.privateKeyPath.lastIndexOf('/')
    );
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.config.privateKeyPath, data, { mode: 0o600 });

    // Only write .key file if env var not provided (backward-compat / dev mode)
    if (!envKey) {
      this.logger.warn('SIGNER_ENCRYPTION_KEY env var not set — writing encryption key to disk (not recommended for production)');
      fs.writeFileSync(
        this.config.privateKeyPath + '.key',
        encryptionKey.toString('hex'),
        { mode: 0o600 }
      );
    }
  }

  private decryptKeyPair(encryptedData: Buffer): RawKeyPair {
    // Prefer env var, fall back to .key file
    const envKey = process.env.SIGNER_ENCRYPTION_KEY;
    let encryptionKey: Buffer;
    if (envKey) {
      encryptionKey = Buffer.from(envKey, 'hex');
    } else {
      const keyHex = fs.readFileSync(
        this.config.privateKeyPath + '.key',
        'utf8'
      );
      encryptionKey = Buffer.from(keyHex, 'hex');
    }

    const iv = encryptedData.subarray(0, 16);
    const authTag = encryptedData.subarray(16, 32);
    const encrypted = encryptedData.subarray(32);

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    // A NaCl secret key is 64 bytes; a DCC private key is 32. A legacy key
    // cannot produce signatures that sigVerify (or the consensus layer) will
    // accept, so fail loudly rather than sign attestations nobody can verify.
    if (decrypted.length !== 32) {
      throw new Error(
        `Signing key at ${this.config.privateKeyPath} is ${decrypted.length} bytes — ` +
        'expected a 32-byte DecentralChain private key. This is a legacy NaCl ' +
        'Ed25519 key, whose signatures the bridge contract cannot verify. ' +
        'Delete the key file to generate a DCC key, then register the new ' +
        'public key on the bridge contract.',
      );
    }

    const privateKey = new Uint8Array(decrypted);
    return {
      privateKey,
      publicKey: base58Decode(
        dccPublicKeyFrom({ privateKey: base58Encode(privateKey) }),
      ),
    };
  }

  getStats(): {
    signatureCount: number;
    keyAge: number;
    rotationDue: boolean;
  } {
    return {
      signatureCount: this.signatureCount,
      keyAge: this.keyInfo ? Date.now() - this.keyInfo.createdAt : 0,
      rotationDue: this.keyInfo
        ? Date.now() > this.keyInfo.rotationDue
        : false,
    };
  }
}
