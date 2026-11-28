import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import { translateKey } from '../i18n/translations.ts';
import type { BootstrapPayload, UserRole, WorkspaceTabId } from '../types.ts';

export const SIMULATION_MODE_STORAGE_KEY = 'rube_pos_v3_simulation_mode';
export const ACTIVE_SESSION_USER_STORAGE_KEY = 'rube_pos_v3_active_session_user_id';

export function getLocalizedRoleLabel(role: UserRole, locale: LocaleCode = 'th'): string {
  switch (role) {
    case 'OWNER':
      return translateKey('role.OWNER', locale);
    case 'MANAGER':
      return translateKey('role.MANAGER', locale);
    case 'CASHIER':
      return translateKey('role.CASHIER', locale);
    case 'WAREHOUSE':
      return translateKey('role.WAREHOUSE', locale);
    case 'KITCHEN':
      return translateKey('role.KITCHEN', locale);
  }
}

const BASE_ROLE_TABS: Readonly<Record<UserRole, readonly WorkspaceTabId[]>> = {
  OWNER: ['POS', 'KDS', 'WAREHOUSE', 'BOM', 'SHIFTS_REPORTS', 'SETTINGS'],
  MANAGER: ['POS', 'KDS', 'WAREHOUSE', 'BOM', 'SHIFTS_REPORTS', 'SETTINGS'],
  CASHIER: ['POS', 'KDS', 'SHIFTS_REPORTS'],
  WAREHOUSE: ['WAREHOUSE', 'BOM'],
  KITCHEN: ['KDS'],
};

/**
 * Returns the ordered list of workspace tabs permitted for `role` under active `featureFlags`.
 */
export function getAllowedTabsForRole(
  role: UserRole,
  featureFlags: BootstrapPayload['featureFlags']
): WorkspaceTabId[] {
  const candidates = BASE_ROLE_TABS[role] ?? ['POS'];
  const filtered = candidates.filter((tab) => {
    if (tab === 'KDS' && !featureFlags.enableKitchenDisplaySystem) return false;
    if (tab === 'BOM' && !featureFlags.enableMultiLevelBom) return false;
    return true;
  });

  if (filtered.length > 0) {
    return filtered;
  }

  // Safe fallback if a role's primary module (e.g. KDS in RETAIL profile) is disabled
  return role === 'WAREHOUSE' ? ['WAREHOUSE'] : ['POS'];
}

export function getDefaultTabForRole(
  role: UserRole,
  featureFlags: BootstrapPayload['featureFlags']
): WorkspaceTabId {
  const allowed = getAllowedTabsForRole(role, featureFlags);
  return allowed[0] ?? 'POS';
}

/**
 * True Blind Drop: Only OWNER and MANAGER may see live `expectedCashSatang` while a shift is OPEN.
 * CASHIER counts cash blindly and only sees closed-shift Z-Report reconciliation after closing.
 */
export function canViewExpectedDrawerCash(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/**
 * Protects MAC inventory valuation and recipe COGS / gross margin reports from frontline roles.
 */
export function canViewCostAndMarginReports(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/**
 * Direct Void privilege without secondary PIN override.
 * CASHIER must obtain stateless PIN approval from MANAGER or OWNER.
 */
export function canApproveVoidWithoutOverride(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/**
 * Controls editing/deleting BOM DAG edges (WAREHOUSE may inspect recipes for prep builds read-only).
 */
export function canEditBomRecipes(role: UserRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}

/**
 * Controls HMAC-guarded Tax ID, PromptPay account, Business Profile switching,
 * Owner account creation, and Developer/Simulation bench toggles.
 */
export function canManageCriticalStoreSettings(role: UserRole): boolean {
  return role === 'OWNER';
}
