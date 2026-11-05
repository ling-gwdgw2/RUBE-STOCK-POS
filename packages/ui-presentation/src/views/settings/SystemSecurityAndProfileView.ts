/**
 * RUBE-STOCK-POS v3.1 Phase 4: Polymorphic Profile Switcher & Recovery Kit Wizard (`WBS-18`)
 *
 * Provides Squad C's UI Controller for:
 * 1. Switching between `RETAIL`, `HOSPITALITY`, and `HYBRID` polymorphic business profiles
 *    with HMAC-SHA256 tamper protection in `store_config` (`is_protected = 1`).
 * 2. Resolving the live `ProfileFeatureFlags` matrix after cryptographic verification.
 * 3. Managing the External Dual-KEK `keystore.manifest.json`:
 *    - Initializing Dual-KEK envelope (Slot 1 Machine DPAPI + Slot 2 Owner Recovery Kit Passphrase)
 *    - Unattended Morning Boot via Machine DPAPI
 *    - Disaster Recovery & Automatic DPAPI Re-Sealing on replacement hardware via Owner Recovery Passphrase
 */

import type { BusinessProfile } from '../../../../shared-contracts/src/ipc-commands.ts';
import {
  KeystoreEnvelopeManager,
  type ExternalKeystoreManifestDto,
} from '../../../../core-engine/src/runtime/keystore-envelope.ts';
import type { LocalIpcBridge } from '../../../../cluster-gateway/src/local-ipc-bridge.ts';
import {
  resolveProfileFeatureFlags,
  type ProfileFeatureFlags,
} from '../../profiles/profile-config.ts';

export class SystemSecurityAndProfileViewController {
  private readonly ipc: LocalIpcBridge;

  constructor(ipc: LocalIpcBridge) {
    this.ipc = ipc;
  }

  /**
   * Switches the store's active Polymorphic Business Profile (`RETAIL` | `HOSPITALITY` | `HYBRID`),
   * signs the configuration row with HMAC-SHA256, and returns the updated `ProfileFeatureFlags`.
   */
  public async switchBusinessProfile(
    profile: BusinessProfile,
    updatedByUserId = 'USR-OWNER-01'
  ): Promise<{
    profile: BusinessProfile;
    featureFlags: ProfileFeatureFlags;
    hmacSignatureHex: string;
    auditLogId: number;
  }> {
    const res = await this.ipc.setBusinessProfileMode(profile, updatedByUserId);
    const verifiedProfile = this.ipc.getVerifiedBusinessProfileMode();
    return {
      profile: verifiedProfile,
      featureFlags: resolveProfileFeatureFlags(verifiedProfile),
      hmacSignatureHex: res.hmacSignatureHex,
      auditLogId: res.auditLogId,
    };
  }

  /**
   * Reads the current Business Profile from `store_config`, verifies its HMAC-SHA256 signature,
   * and resolves the Polymorphic UI Feature Matrix.
   */
  public getActiveProfileWithFeatureFlags(): {
    profile: BusinessProfile;
    featureFlags: ProfileFeatureFlags;
  } {
    const verifiedProfile = this.ipc.getVerifiedBusinessProfileMode();
    return {
      profile: verifiedProfile,
      featureFlags: resolveProfileFeatureFlags(verifiedProfile),
    };
  }

  /**
   * Initializes the external `keystore.manifest.json` with Dual-KEK Envelope Encryption.
   */
  public initializeKeystoreManifest(params: {
    manifestPath: string;
    rawHexKey64: string;
    machineDpapiSecret: string;
    ownerRecoveryPassphrase: string;
    keyId?: string;
  }): ExternalKeystoreManifestDto {
    return KeystoreEnvelopeManager.initializeDualKekManifest(params);
  }

  /**
   * Unattended Morning Boot (Slot 1: Machine DPAPI).
   */
  public bootUnattendedWithDpapi(
    manifestPath: string,
    machineDpapiSecret: string
  ): { rawHexKey64: string; keyId: string; unlockedVia: 'DPAPI_SLOT' } {
    return KeystoreEnvelopeManager.unlockWithMachineDpapi(manifestPath, machineDpapiSecret);
  }

  /**
   * Emergency Disaster Recovery Wizard (Slot 2: Owner Recovery Passphrase + Automatic DPAPI Re-Sealing).
   */
  public recoverAndResealKeystoreWithPassphrase(
    manifestPath: string,
    ownerRecoveryPassphrase: string,
    newMachineDpapiSecret: string
  ): {
    rawHexKey64: string;
    keyId: string;
    unlockedVia: 'ARGON2_RECOVERY_SLOT';
    dpapiResealed: true;
  } {
    return KeystoreEnvelopeManager.unlockWithRecoveryPassphraseAndResealDpapi(
      manifestPath,
      ownerRecoveryPassphrase,
      newMachineDpapiSecret
    );
  }
}
