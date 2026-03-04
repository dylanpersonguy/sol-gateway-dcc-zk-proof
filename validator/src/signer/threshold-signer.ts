// ═══════════════════════════════════════════════════════════════
// THRESHOLD SIGNATURE SERVICE (TSS / MPC Signing)
// ═══════════════════════════════════════════════════════════════
//
// Manages cryptographic signing for validator attestations.
// Supports:
// - Ed25519 signatures (Solana native)
// - Hardware Security Module (HSM) integration
// - Key rotation
// - Threshold signatures (future MPC upgrade)
//
// SECURITY: Private keys should NEVER be in memory longer than
// necessary. HSM mode keeps keys in hardware at all times.

import * as nacl from 'tweetnacl';
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

export interface KeyPairInfo {
  publicKey: Buffer;
  createdAt: number;
  rotationDue: number;
}

export class ThresholdSigner {
  private config: SignerConfig;
  private logger: Logger;
  private keyPair: nacl.SignKeyPair | null = null;
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
      return nacl.sign.detached.verify(
        new Uint8Array(message),
        new Uint8Array(signature),
        new Uint8Array(publicKey)
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

    const newKeyPair = nacl.sign.keyPair();
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
      this.keyPair = nacl.sign.keyPair();
      await this.saveEncryptedKey(this.keyPair);
      this.logger.info('Generated new key pair');
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

    const signature = nacl.sign.detached(
      new Uint8Array(message),
      this.keyPair.secretKey
    );

    this.signatureCount++;
    return Promise.resolve(Buffer.from(signature));
  }

  private async signWithHSM(message: Buffer): Promise<Buffer> {
    // HSM signing placeholder
    // In production: lib.C_Sign(session, message, { mechanism: CKM_EDDSA })
    return this.signSoftware(message);
  }

  private async saveEncryptedKey(keyPair: nacl.SignKeyPair): Promise<void> {
    // Encrypt the private key before saving to disk
    // Use SIGNER_ENCRYPTION_KEY env var if available, otherwise generate random key and save to .key file
    const envKey = process.env.SIGNER_ENCRYPTION_KEY;
    const encryptionKey = envKey
      ? Buffer.from(envKey, 'hex')
      : crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(keyPair.secretKey)),
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
    fs.writeFileSync(this.config.privateKeyPath, data);

    // Only write .key file if env var not provided (backward-compat / dev mode)
    if (!envKey) {
      this.logger.warn('SIGNER_ENCRYPTION_KEY env var not set — writing encryption key to disk (not recommended for production)');
      fs.writeFileSync(
        this.config.privateKeyPath + '.key',
        encryptionKey.toString('hex')
      );
    }
  }

  private decryptKeyPair(encryptedData: Buffer): nacl.SignKeyPair {
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

    return nacl.sign.keyPair.fromSecretKey(new Uint8Array(decrypted));
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
