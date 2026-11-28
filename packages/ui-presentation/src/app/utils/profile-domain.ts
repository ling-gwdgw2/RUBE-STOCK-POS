import type { LocaleCode } from '../../../../shared-contracts/src/currency.ts';
import { pickLocaleText } from '../i18n/translations.ts';
import type {
  BusinessProfile,
  CatalogVariantDetailDto,
  CategoryDto,
  CheckoutOrderRequest,
} from '../types.ts';

export type ShopCategoryDepartment = 'RETAIL' | 'HOSPITALITY' | 'RAW_MATERIAL';

/**
 * Classifies any category (seeded or user-created) into a clear operational department
 * based on its ID and `kitchenStation` so RETAIL and HOSPITALITY never intermingle.
 */
export function getCategoryDepartment(
  category: Pick<CategoryDto, 'id' | 'kitchenStation'>
): ShopCategoryDepartment {
  const station = (category.kitchenStation || 'NONE').toUpperCase();
  if (category.id === 'CAT-RAW' || station === 'PREP') {
    return 'RAW_MATERIAL';
  }
  if (category.id === 'CAT-CAFE' || station === 'BAR' || station === 'MAIN') {
    return 'HOSPITALITY';
  }
  return 'RETAIL';
}

export function getDepartmentLabel(
  dept: ShopCategoryDepartment,
  locale: LocaleCode = 'th'
): string {
  switch (dept) {
    case 'RETAIL':
      return pickLocaleText(
        locale,
        'สินค้าปลีก / ซูเปอร์มาร์เก็ต',
        'ສິນຄ້າຂາຍຍ່ອຍ / ຊຸບເປີມາເກັດ',
        'Retail / Supermarket'
      );
    case 'HOSPITALITY':
      return pickLocaleText(
        locale,
        'เมนูคาเฟ่ / ร้านอาหาร',
        'ເມນູຄາເຟ່ / ຮ້ານອາຫານ',
        'Cafe / Restaurant Menu'
      );
    case 'RAW_MATERIAL':
      return pickLocaleText(
        locale,
        'วัตถุดิบหลังร้าน / ต้มเตรียม',
        'ວັດຖຸດິບຫຼັງຮ້ານ / ກຽມຜະລິດ',
        'Back-of-House Ingredients / Prep'
      );
  }
}

export function getDepartmentThaiLabel(
  dept: ShopCategoryDepartment,
  locale: LocaleCode = 'th'
): string {
  return getDepartmentLabel(dept, locale);
}

export function getDepartmentStationPreset(dept: ShopCategoryDepartment): string {
  switch (dept) {
    case 'RETAIL':
      return 'NONE';
    case 'HOSPITALITY':
      return 'BAR';
    case 'RAW_MATERIAL':
      return 'PREP';
  }
}

/**
 * Filters categories strictly by active `BusinessProfile` and screen context:
 * - `POS`: Never displays `RAW_MATERIAL`; RETAIL shows only `RETAIL`; HOSPITALITY shows only `HOSPITALITY`.
 * - `WAREHOUSE`: RETAIL shows only `RETAIL`; HOSPITALITY shows `HOSPITALITY` + `RAW_MATERIAL`; HYBRID shows all.
 */
export function getCategoriesForProfile(
  categories: readonly CategoryDto[],
  profile: BusinessProfile,
  context: 'POS' | 'WAREHOUSE'
): CategoryDto[] {
  return categories.filter((cat) => {
    const dept = getCategoryDepartment(cat);
    if (context === 'POS' && dept === 'RAW_MATERIAL') {
      return false;
    }
    if (profile === 'RETAIL') {
      return dept === 'RETAIL';
    }
    if (profile === 'HOSPITALITY') {
      return dept === 'HOSPITALITY' || (context === 'WAREHOUSE' && dept === 'RAW_MATERIAL');
    }
    return true;
  });
}

/**
 * Picks the correct default category when adding a new product under the active shop profile
 * (fixes the bug where HOSPITALITY mode defaulted to `CAT-RETAIL` causing items to vanish from POS).
 */
export function getDefaultCategoryForProfile(
  categories: readonly CategoryDto[],
  profile: BusinessProfile
): CategoryDto | undefined {
  const preferredDept: ShopCategoryDepartment =
    profile === 'HOSPITALITY' ? 'HOSPITALITY' : 'RETAIL';
  return (
    categories.find((c) => getCategoryDepartment(c) === preferredDept) ??
    getCategoriesForProfile(categories, profile, 'WAREHOUSE')[0] ??
    categories[0]
  );
}

/**
 * Determines whether a catalog variant belongs to the active shop profile.
 */
export function isVariantInProfileDomain(
  variant: Pick<CatalogVariantDetailDto, 'categoryId' | 'kitchenStation'>,
  profile: BusinessProfile,
  context: 'POS' | 'WAREHOUSE'
): boolean {
  const dept = getCategoryDepartment({
    id: variant.categoryId ?? '',
    kitchenStation: variant.kitchenStation,
  });
  if (context === 'POS' && dept === 'RAW_MATERIAL') {
    return false;
  }
  if (profile === 'RETAIL') {
    return dept === 'RETAIL';
  }
  if (profile === 'HOSPITALITY') {
    return dept === 'HOSPITALITY' || (context === 'WAREHOUSE' && dept === 'RAW_MATERIAL');
  }
  return true;
}

export interface OrderTypeOption {
  value: CheckoutOrderRequest['orderType'];
  label: string;
}

/**
 * Returns only the order types that belong to the active business profile:
 * - RETAIL: Retail Counter + Delivery (NO Dine-In / Takeaway)
 * - HOSPITALITY: Dine-In + Takeaway + Delivery (NO Retail)
 * - HYBRID: All 4 order types
 */
export function getAllowedOrderTypesForProfile(
  profile: BusinessProfile,
  locale: LocaleCode = 'th'
): OrderTypeOption[] {
  const retailOpt: OrderTypeOption = {
    value: 'RETAIL',
    label: pickLocaleText(locale, 'ขายปลีกหน้าร้าน (Retail)', 'ຂາຍຍ່ອຍໜ້າຮ້ານ (Retail)', 'Retail Counter'),
  };
  const dineInOpt: OrderTypeOption = {
    value: 'DINE_IN',
    label: pickLocaleText(locale, 'ทานที่ร้าน (Dine-In)', 'ທານທີ່ຮ້ານ (Dine-In)', 'Dine-In'),
  };
  const takeawayOpt: OrderTypeOption = {
    value: 'TAKEAWAY',
    label: pickLocaleText(locale, 'สั่งกลับบ้าน (Takeaway)', 'ສັ່ງກັບບ້ານ (Takeaway)', 'Takeaway'),
  };
  const deliveryOpt: OrderTypeOption = {
    value: 'DELIVERY',
    label: pickLocaleText(locale, 'เดลิเวอรี (Delivery)', 'ສົ່ງເຖິງທີ່ (Delivery)', 'Delivery'),
  };

  if (profile === 'RETAIL') {
    return [retailOpt, deliveryOpt];
  }
  if (profile === 'HOSPITALITY') {
    return [dineInOpt, takeawayOpt, deliveryOpt];
  }
  return [takeawayOpt, dineInOpt, retailOpt, deliveryOpt];
}

export function getOrderReferenceFieldMeta(
  profile: BusinessProfile,
  locale: LocaleCode = 'th'
): {
  ariaLabel: string;
  placeholder: string;
} {
  if (profile === 'RETAIL') {
    return {
      ariaLabel: pickLocaleText(
        locale,
        'รหัสสมาชิกหรือหมายเหตุบิลขายปลีก',
        'ລະຫັດສະມາຊິກ ຫຼື ໝາຍເຫດບິນຂາຍຍ່ອຍ',
        'Member ID or retail order note'
      ),
      placeholder: pickLocaleText(
        locale,
        'รหัสสมาชิก / หมายเหตุบิล (ถ้ามี)',
        'ລະຫັດສະມາຊິກ / ໝາຍເຫດບິນ (ຖ້າມີ)',
        'Member ID / Order note (optional)'
      ),
    };
  }
  return {
    ariaLabel: pickLocaleText(
      locale,
      'หมายเลขโต๊ะหรือป้ายคิว',
      'ເລກໂຕະ ຫຼື ເລກຄິວ',
      'Table or queue reference'
    ),
    placeholder: pickLocaleText(
      locale,
      'ป้ายคิว / โต๊ะ (เช่น โต๊ะ 4, A-04)',
      'ເລກຄິວ / ໂຕະ (ເຊັ່ນ ໂຕະ 4, A-04)',
      'Queue / Table (e.g. T04, A-04)'
    ),
  };
}

export function getProfileMeta(
  profile: BusinessProfile,
  locale: LocaleCode = 'th'
): {
  shortBadge: string;
  titleThai: string;
  newItemButtonLabel: string;
  catalogTitleThai: string;
  defaultUnit: string;
} {
  if (profile === 'RETAIL') {
    return {
      shortBadge: pickLocaleText(locale, 'ค้าปลีก · RETAIL', 'ຂາຍຍ່ອຍ · RETAIL', 'RETAIL'),
      titleThai: pickLocaleText(
        locale,
        'โหมดร้านค้าปลีก / ซูเปอร์มาร์เก็ต',
        'ໂໝດຮ້ານຂາຍຍ່ອຍ / ຊຸບເປີມາເກັດ',
        'Retail / Supermarket Mode'
      ),
      newItemButtonLabel: pickLocaleText(
        locale,
        'เพิ่มสินค้าปลีกใหม่',
        'ເພີ່ມສິນຄ້າຂາຍຍ່ອຍໃໝ່',
        'Add Retail Product'
      ),
      catalogTitleThai: pickLocaleText(
        locale,
        'ทะเบียนสินค้าปลีก สต็อก และต้นทุนเฉลี่ย (MAC)',
        'ທະບຽນສິນຄ້າຂາຍຍ່ອຍ, ສະຕັອກ ແລະ ຕົ້ນທຶນສະເລ່ຍ (MAC)',
        'Retail Catalog, Stock Levels & Moving Average Cost (MAC)'
      ),
      defaultUnit: pickLocaleText(locale, 'ชิ้น', 'ອັນ', 'pcs'),
    };
  }
  if (profile === 'HOSPITALITY') {
    return {
      shortBadge: pickLocaleText(locale, 'คาเฟ่/อาหาร · HOSPITALITY', 'ຄາເຟ່/ອາຫານ · HOSPITALITY', 'HOSPITALITY'),
      titleThai: pickLocaleText(
        locale,
        'โหมดคาเฟ่ / ร้านอาหาร',
        'ໂໝດຄາເຟ່ / ຮ້ານອາຫານ',
        'Cafe & Restaurant Mode'
      ),
      newItemButtonLabel: pickLocaleText(
        locale,
        'เพิ่มเมนู / วัตถุดิบใหม่',
        'ເພີ່ມເມນູ / ວັດຖຸດິບໃໝ່',
        'Add Menu / Ingredient'
      ),
      catalogTitleThai: pickLocaleText(
        locale,
        'ทะเบียนเมนูอาหาร เครื่องดื่ม และวัตถุดิบหลังร้าน',
        'ທະບຽນເມນູອາຫານ, ເຄື່ອງດື່ມ ແລະ ວັດຖຸດິບຫຼັງຮ້ານ',
        'Food/Beverage Menu & Kitchen Ingredient Catalog'
      ),
      defaultUnit: pickLocaleText(locale, 'แก้ว', 'ຈອກ', 'cup'),
    };
  }
  return {
    shortBadge: pickLocaleText(locale, 'ผสมครบวงจร · HYBRID', 'ຄົບວົງຈອນ · HYBRID', 'HYBRID'),
    titleThai: pickLocaleText(
      locale,
      'โหมดร้านค้าผสมครบวงจร (ค้าปลีก + คาเฟ่)',
      'ໂໝດຮ້ານຄົບວົງຈອນ (ຂາຍຍ່ອຍ + ຄາເຟ່)',
      'Hybrid Mode (Retail + Hospitality)'
    ),
    newItemButtonLabel: pickLocaleText(
      locale,
      'เพิ่มสินค้า / เมนูใหม่',
      'ເພີ່ມສິນຄ້າ / ເມນູໃໝ່',
      'Add Product / Menu Item'
    ),
    catalogTitleThai: pickLocaleText(
      locale,
      'ทะเบียนสินค้าปลีก เมนูคาเฟ่ และวัตถุดิบ (แยกตามแผนก)',
      'ທະບຽນສິນຄ້າຂາຍຍ່ອຍ, ເມນູຄາເຟ່ ແລະ ວັດຖຸດິບ (ແຍກຕາມພະແນກ)',
      'Unified Retail, Menu & Ingredient Catalog (Department-Scoped)'
    ),
    defaultUnit: pickLocaleText(locale, 'ชิ้น', 'ອັນ', 'pcs'),
  };
}
