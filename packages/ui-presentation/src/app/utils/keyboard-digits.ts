/**
 * Thai Kedmanee, Lao Standard (`KBDLAO.DLL`) & Physical Keyboard Digit Resolution Helpers
 *
 * Ensures numeric PIN pads, barcode fields, and cash/price inputs remain responsive
 * even when the terminal OS input language is switched to Thai Kedmanee (`0000041E`)
 * or Lao Standard (`00000454`).
 */

const THAI_AND_LAO_TOP_ROW_DIGIT_MAP: Readonly<Record<string, string>> = {
  // Thai Kedmanee (`0000041E`) unshifted number row: 1..0
  'ๅ': '1',
  '/': '2',
  '-': '3',
  ภ: '4',
  ถ: '5',
  'ุ': '6',
  'ึ': '7',
  ค: '8',
  ต: '9',
  จ: '0',
  // Thai Unicode digits (`U+0E50`..`U+0E59`)
  '๐': '0',
  '๑': '1',
  '๒': '2',
  '๓': '3',
  '๔': '4',
  '๕': '5',
  '๖': '6',
  '๗': '7',
  '๘': '8',
  '๙': '9',
  // Windows Lao Standard (`KBDLAO.DLL`, `00000454`) hardware-verified unshifted number row: 1..0
  ຢ: '1', // U+0EA2
  ຟ: '2', // U+0E9F
  ໂ: '3', // U+0EC2
  ຖ: '4', // U+0E96
  'ຸ': '5', // U+0EB8
  'ູ': '6', // U+0EB9
  ຄ: '7', // U+0E84
  ຕ: '8', // U+0E95
  ຈ: '9', // U+0E88
  ຂ: '0', // U+0E82
  // Lao Unicode digits (`U+0ED0`..`U+0ED9`)
  '໐': '0',
  '໑': '1',
  '໒': '2',
  '໓': '3',
  '໔': '4',
  '໕': '5',
  '໖': '6',
  '໗': '7',
  '໘': '8',
  '໙': '9',
};

/**
 * Resolves an ASCII digit (`'0'`–`'9'`) from a `KeyboardEvent`, falling back to
 * physical `Digit0`–`Digit9` and `Numpad0`–`Numpad9` key codes when unshifted
 * (completely immune to Thai Kedmanee and Lao Standard Windows keyboard layouts).
 */
export function resolveDigitFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (/^\d$/.test(e.key)) {
    return e.key;
  }
  if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? null;
  }
  return null;
}

/**
 * Maps unshifted Thai Kedmanee and Lao Standard (`KBDLAO.DLL`) top-row characters,
 * plus Thai (`๐`–`๙`) and Lao (`໐`–`໙`) Unicode numerals, into ASCII digits while preserving other characters.
 */
export function mapThaiKedmaneeDigitInput(raw: string): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw) {
    out += THAI_AND_LAO_TOP_ROW_DIGIT_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Alias emphasizing multi-country (Thai + Lao) keyboard layout normalization.
 */
export const mapThaiLaoKeyboardDigitInput = mapThaiKedmaneeDigitInput;

/**
 * Normalizes accidental Thai/Lao keyboard layout keystrokes into clean ASCII digits and limits PIN length.
 */
export function sanitizePinInput(raw: string, maxLength = 8): string {
  return mapThaiKedmaneeDigitInput(raw).replace(/\D/g, '').slice(0, maxLength);
}
