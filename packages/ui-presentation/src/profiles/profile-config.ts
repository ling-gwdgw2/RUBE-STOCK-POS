/**
 * RUBE-STOCK-POS v3.1 Polymorphic Business Profile Feature Matrix (`ARCHITECTURE.md` Section 2)
 */

import type { BusinessProfile } from '../../../shared-contracts/src/ipc-commands.ts';

export interface ProfileFeatureFlags {
  profile: BusinessProfile;
  defaultPosView: 'RETAIL_FAST_GRID' | 'CAFE_TOUCH_TILES' | 'DUAL_SWITCHABLE';
  enableGlobalBarcodeScanner: boolean;
  enableScaleBarcodeParser: boolean;
  enableMultiLevelBom: boolean;
  enableRoleBasedModifiers: boolean;
  enableKitchenDisplaySystem: boolean;
}

export function resolveProfileFeatureFlags(profile: BusinessProfile): ProfileFeatureFlags {
  switch (profile) {
    case 'RETAIL':
      return {
        profile: 'RETAIL',
        defaultPosView: 'RETAIL_FAST_GRID',
        enableGlobalBarcodeScanner: true,
        enableScaleBarcodeParser: true,
        enableMultiLevelBom: false,
        enableRoleBasedModifiers: false,
        enableKitchenDisplaySystem: false,
      };
    case 'HOSPITALITY':
      return {
        profile: 'HOSPITALITY',
        defaultPosView: 'CAFE_TOUCH_TILES',
        enableGlobalBarcodeScanner: true,
        enableScaleBarcodeParser: false,
        enableMultiLevelBom: true,
        enableRoleBasedModifiers: true,
        enableKitchenDisplaySystem: true,
      };
    case 'HYBRID':
      return {
        profile: 'HYBRID',
        defaultPosView: 'DUAL_SWITCHABLE',
        enableGlobalBarcodeScanner: true,
        enableScaleBarcodeParser: true,
        enableMultiLevelBom: true,
        enableRoleBasedModifiers: true,
        enableKitchenDisplaySystem: true,
      };
  }
}

