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

export function getDepartmentThaiLabel(dept: ShopCategoryDepartment): string {
  switch (dept) {
    case 'RETAIL':
      return 'สินค้าปลีก / ซูเปอร์มาร์เก็ต';
    case 'HOSPITALITY':
      return 'เมนูคาเฟ่ / ร้านอาหาร';
    case 'RAW_MATERIAL':
      return 'วัตถุดิบหลังร้าน / ต้มเตรียม';
  }
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
export function getAllowedOrderTypesForProfile(profile: BusinessProfile): OrderTypeOption[] {
  if (profile === 'RETAIL') {
    return [
      { value: 'RETAIL', label: 'ขายปลีกหน้าร้าน (Retail)' },
      { value: 'DELIVERY', label: 'จัดส่ง / เดลิเวอรี (Delivery)' },
    ];
  }
  if (profile === 'HOSPITALITY') {
    return [
      { value: 'DINE_IN', label: 'ทานที่ร้าน (Dine-In)' },
      { value: 'TAKEAWAY', label: 'สั่งกลับบ้าน (Takeaway)' },
      { value: 'DELIVERY', label: 'เดลิเวอรี (Delivery)' },
    ];
  }
  return [
    { value: 'TAKEAWAY', label: 'สั่งกลับบ้าน (Takeaway)' },
    { value: 'DINE_IN', label: 'ทานที่ร้าน (Dine-In)' },
    { value: 'RETAIL', label: 'ขายปลีกหน้าร้าน (Retail)' },
    { value: 'DELIVERY', label: 'เดลิเวอรี (Delivery)' },
  ];
}

export function getOrderReferenceFieldMeta(profile: BusinessProfile): {
  ariaLabel: string;
  placeholder: string;
} {
  if (profile === 'RETAIL') {
    return {
      ariaLabel: 'รหัสสมาชิกหรือหมายเหตุบิลขายปลีก',
      placeholder: 'รหัสสมาชิก / หมายเหตุบิล (ถ้ามี)',
    };
  }
  return {
    ariaLabel: 'หมายเลขโต๊ะหรือป้ายคิว',
    placeholder: 'ป้ายคิว / โต๊ะ (เช่น โต๊ะ 4, A-04)',
  };
}

export function getProfileMeta(profile: BusinessProfile): {
  shortBadge: string;
  titleThai: string;
  newItemButtonLabel: string;
  catalogTitleThai: string;
  defaultUnit: string;
} {
  if (profile === 'RETAIL') {
    return {
      shortBadge: 'ค้าปลีก · RETAIL',
      titleThai: 'โหมดร้านค้าปลีก / ซูเปอร์มาร์เก็ต',
      newItemButtonLabel: 'เพิ่มสินค้าปลีกใหม่',
      catalogTitleThai: 'ทะเบียนสินค้าปลีก สต็อก และต้นทุนเฉลี่ย (MAC)',
      defaultUnit: 'ชิ้น',
    };
  }
  if (profile === 'HOSPITALITY') {
    return {
      shortBadge: 'คาเฟ่/อาหาร · HOSPITALITY',
      titleThai: 'โหมดคาเฟ่ / ร้านอาหาร',
      newItemButtonLabel: 'เพิ่มเมนู / วัตถุดิบใหม่',
      catalogTitleThai: 'ทะเบียนเมนูอาหาร เครื่องดื่ม และวัตถุดิบหลังร้าน',
      defaultUnit: 'แก้ว',
    };
  }
  return {
    shortBadge: 'ผสมครบวงจร · HYBRID',
    titleThai: 'โหมดร้านค้าผสมครบวงจร (ค้าปลีก + คาเฟ่)',
    newItemButtonLabel: 'เพิ่มสินค้า / เมนูใหม่',
    catalogTitleThai: 'ทะเบียนสินค้าปลีก เมนูคาเฟ่ และวัตถุดิบ (แยกตามแผนก)',
    defaultUnit: 'ชิ้น',
  };
}
