/**
 * Thai Kedmanee & Physical Keyboard Digit Resolution Helpers
 *
 * Ensures numeric PIN pads and `<input type="password">` fields remain responsive
 * even when the terminal OS input language is switched to Thai Kedmanee.
 */

const THAI_KEDMANEE_TOP_ROW_DIGIT_MAP: Readonly<Record<string, string>> = {
  จ: '0',
  'ๅ': '1',
  '/': '2',
  '-': '3',
  ภ: '4',
  ถ: '5',
  'ุ': '6',
  'ึ': '7',
  ค: '8',
  ต: '9',
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
};

/**
 * Resolves an ASCII digit (`'0'`–`'9'`) from a `KeyboardEvent`, falling back to
 * physical `Digit0`–`Digit9` and `Numpad0`–`Numpad9` key codes when unshifted
 * (for example, when Thai Kedmanee layout emits `'ๅ'`, `'/'`, `'-'`, `'ภ'`, etc.).
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
 * Maps unshifted Thai Kedmanee top-row characters (`จ=0, ๅ=1, /=2, -=3, ภ=4, ถ=5, ุ=6, ึ=7, ค=8, ต=9`)
 * and Thai numerals (`๐`–`๙`) into ASCII digits while preserving existing characters.
 */
export function mapThaiKedmaneeDigitInput(raw: string): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw) {
    out += THAI_KEDMANEE_TOP_ROW_DIGIT_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Normalizes accidental Thai Kedmanee keystrokes into clean ASCII digits and limits PIN length.
 */
export function sanitizePinInput(raw: string, maxLength = 8): string {
  return mapThaiKedmaneeDigitInput(raw).replace(/\D/g, '').slice(0, maxLength);
}
