/**
 * RUBE-STOCK-POS v3.1 Phase 4: Dual-KEK Envelope Encryption & External Keystore Manifest (`WBS-18`)
 *
 * Implements Section 7.2 of the Complete Architecture Specification:
 * - Stores `keystore.manifest.json` OUTSIDE the encrypted SQLite database to break the circular
 *   dependency ("cannot read wrapped DEK from inside an encrypted DB before unlocking it").
 * - Uses a 256-bit (64-hex char) Data Encryption Key (DEK) wrapped independently into two
 *   authenticated AES-256-GCM Key-Encryption-Key (KEK) slots:
 *   1. `dpapiSlot`: Wrapped using the host OS / Machine DPAPI secret for Unattended Morning Boot.
 *   2. `argon2RecoverySlot`: Wrapped using a key derived from the Owner's 24-Word / Passphrase
 *      Recovery Kit (`scryptSync` / Argon2id-equivalent KDF with 16-byte random salt) so that
 *      if the motherboard dies or a Windows user password reset invalidates DPAPI, the Owner can
 *      unlock the database on any replacement machine and automatically re-seal `dpapiSlot`.
 * - Persists `keystore.manifest.json` atomically via `.part` temporary file + `fsyncSync` + `renameSync`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface WrappedKekSlotDto {
  readonly algorithm: 'DPAPI-AES256-GCM' | 'ARGON2ID-KDF-AES256-GCM';
  readonly kdfSaltHex?: string;
  readonly nonceHex: string;
  readonly authTagHex: string;
  readonly wrappedDekCiphertextHex: string;
  readonly sealedAt: string;
}

export interface ExternalKeystoreManifestDto {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly dekFingerprintSha256Hex: string;
  readonly dpapiSlot: WrappedKekSlotDto;
  readonly argon2RecoverySlot: WrappedKekSlotDto;
  readonly updatedAt: string;
}

function assertValidHex64Dek(rawHexKey64: string): void {
  if (rawHexKey64.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(rawHexKey64)) {
    throw new Error('SQLCipher Raw Hex DEK must be exactly 64 hexadecimal characters (256 bits)');
  }
}

function deriveDpapiKek32(machineDpapiSecret: string): Buffer {
  if (!machineDpapiSecret || machineDpapiSecret.trim().length < 8) {
    throw new Error('machineDpapiSecret must be at least 8 characters');
  }
  return createHash('sha256')
    .update(`RUBE-DPAPI-KEK-V3.1:${machineDpapiSecret}`, 'utf8')
    .digest();
}

function deriveRecoveryPassphraseKek32(recoveryPassphrase: string, saltHex: string): Buffer {
  if (!recoveryPassphrase || recoveryPassphrase.trim().length < 12) {
    throw new Error('Owner Recovery Passphrase must be at least 12 characters');
  }
  const saltBuf = Buffer.from(saltHex, 'hex');
  return scryptSync(recoveryPassphrase.normalize('NFKC'), saltBuf, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

function sealDekWithKek32(
  rawHexKey64: string,
  kek32: Buffer,
  algorithm: WrappedKekSlotDto['algorithm'],
  kdfSaltHex?: string
): WrappedKekSlotDto {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek32, nonce);
  cipher.setAAD(Buffer.from(`RUBE-KEYSTORE-V1:${algorithm}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(rawHexKey64.toUpperCase(), 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm,
    ...(kdfSaltHex ? { kdfSaltHex } : {}),
    nonceHex: nonce.toString('hex'),
    authTagHex: authTag.toString('hex'),
    wrappedDekCiphertextHex: ciphertext.toString('hex'),
    sealedAt: new Date().toISOString(),
  };
}

function unsealDekWithKek32(slot: WrappedKekSlotDto, kek32: Buffer): string {
  const nonce = Buffer.from(slot.nonceHex, 'hex');
  const authTag = Buffer.from(slot.authTagHex, 'hex');
  const ciphertext = Buffer.from(slot.wrappedDekCiphertextHex, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', kek32, nonce);
  decipher.setAAD(Buffer.from(`RUBE-KEYSTORE-V1:${slot.algorithm}`, 'utf8'));
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  assertValidHex64Dek(decrypted);
  return decrypted.toUpperCase();
}

export class KeystoreEnvelopeManager {
  /**
   * Atomically writes `keystore.manifest.json` using `.part` + `fsyncSync` + `renameSync`.
   */
  public static saveManifestAtomically(
    manifestPath: string,
    manifest: ExternalKeystoreManifestDto
  ): void {
    mkdirSync(dirname(manifestPath), { recursive: true });
    const partPath = `${manifestPath}.part`;
    const serialized = JSON.stringify(manifest, null, 2);

    const fd = openSync(partPath, 'w');
    try {
      writeSync(fd, Buffer.from(serialized, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(partPath, manifestPath);
  }

  /**
   * Reads and parses `keystore.manifest.json` from disk.
   */
  public static loadManifest(manifestPath: string): ExternalKeystoreManifestDto {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as ExternalKeystoreManifestDto;
    if (parsed.schemaVersion !== 1 || !parsed.dpapiSlot || !parsed.argon2RecoverySlot) {
      throw new Error('Invalid or corrupted keystore.manifest.json structure');
    }
    return parsed;
  }

  /**
   * Initializes a new Dual-KEK `keystore.manifest.json` outside SQLite.
   */
  public static initializeDualKekManifest(params: {
    manifestPath: string;
    rawHexKey64: string;
    machineDpapiSecret: string;
    ownerRecoveryPassphrase: string;
    keyId?: string;
  }): ExternalKeystoreManifestDto {
    assertValidHex64Dek(params.rawHexKey64);
    const normalizedDek = params.rawHexKey64.toUpperCase();
    const dekFingerprintSha256Hex = createHash('sha256')
      .update(normalizedDek, 'utf8')
      .digest('hex');

    const dpapiKek = deriveDpapiKek32(params.machineDpapiSecret);
    const dpapiSlot = sealDekWithKek32(normalizedDek, dpapiKek, 'DPAPI-AES256-GCM');

    const saltHex = randomBytes(16).toString('hex');
    const recoveryKek = deriveRecoveryPassphraseKek32(params.ownerRecoveryPassphrase, saltHex);
    const argon2RecoverySlot = sealDekWithKek32(
      normalizedDek,
      recoveryKek,
      'ARGON2ID-KDF-AES256-GCM',
      saltHex
    );

    const manifest: ExternalKeystoreManifestDto = {
      schemaVersion: 1,
      keyId: params.keyId ?? `KEY-${Date.now()}`,
      dekFingerprintSha256Hex,
      dpapiSlot,
      argon2RecoverySlot,
      updatedAt: new Date().toISOString(),
    };

    KeystoreEnvelopeManager.saveManifestAtomically(params.manifestPath, manifest);
    return manifest;
  }

  /**
   * Primary Boot Path (Slot 1): Unattended Morning Boot via Windows DPAPI / Machine Secret.
   */
  public static unlockWithMachineDpapi(
    manifestPath: string,
    machineDpapiSecret: string
  ): { rawHexKey64: string; keyId: string; unlockedVia: 'DPAPI_SLOT' } {
    const manifest = KeystoreEnvelopeManager.loadManifest(manifestPath);
    const dpapiKek = deriveDpapiKek32(machineDpapiSecret);

    let unwrappedDek: string;
    try {
      unwrappedDek = unsealDekWithKek32(manifest.dpapiSlot, dpapiKek);
    } catch {
      throw new Error(
        'DPAPI_UNSEAL_FAILED: Machine DPAPI key changed or invalid (motherboard replacement or OS password reset). Please use Owner Recovery Passphrase.'
      );
    }

    const fingerprint = createHash('sha256').update(unwrappedDek, 'utf8').digest('hex');
    if (fingerprint !== manifest.dekFingerprintSha256Hex) {
      throw new Error('DEK fingerprint mismatch after DPAPI unseal');
    }

    return {
      rawHexKey64: unwrappedDek,
      keyId: manifest.keyId,
      unlockedVia: 'DPAPI_SLOT',
    };
  }

  /**
   * Emergency Disaster Recovery Path (Slot 2): Unlocks DEK using the Owner's Recovery Passphrase
   * and automatically re-seals `dpapiSlot` with the new host's `newMachineDpapiSecret`.
   */
  public static unlockWithRecoveryPassphraseAndResealDpapi(
    manifestPath: string,
    ownerRecoveryPassphrase: string,
    newMachineDpapiSecret: string
  ): {
    rawHexKey64: string;
    keyId: string;
    unlockedVia: 'ARGON2_RECOVERY_SLOT';
    dpapiResealed: true;
  } {
    const manifest = KeystoreEnvelopeManager.loadManifest(manifestPath);
    const saltHex = manifest.argon2RecoverySlot.kdfSaltHex;
    if (!saltHex) {
      throw new Error('Missing kdfSaltHex in argon2RecoverySlot');
    }

    const recoveryKek = deriveRecoveryPassphraseKek32(ownerRecoveryPassphrase, saltHex);
    let unwrappedDek: string;
    try {
      unwrappedDek = unsealDekWithKek32(manifest.argon2RecoverySlot, recoveryKek);
    } catch {
      throw new Error('RECOVERY_UNSEAL_FAILED: Invalid Owner Recovery Passphrase');
    }

    const fingerprint = createHash('sha256').update(unwrappedDek, 'utf8').digest('hex');
    if (fingerprint !== manifest.dekFingerprintSha256Hex) {
      throw new Error('DEK fingerprint mismatch after Recovery Passphrase unseal');
    }

    // Automatically re-seal Slot 1 (DPAPI) for the new replacement hardware / Windows user profile
    const newDpapiKek = deriveDpapiKek32(newMachineDpapiSecret);
    const newDpapiSlot = sealDekWithKek32(unwrappedDek, newDpapiKek, 'DPAPI-AES256-GCM');

    const updatedManifest: ExternalKeystoreManifestDto = {
      ...manifest,
      dpapiSlot: newDpapiSlot,
      updatedAt: new Date().toISOString(),
    };
    KeystoreEnvelopeManager.saveManifestAtomically(manifestPath, updatedManifest);

    return {
      rawHexKey64: unwrappedDek,
      keyId: manifest.keyId,
      unlockedVia: 'ARGON2_RECOVERY_SLOT',
      dpapiResealed: true,
    };
  }
}
