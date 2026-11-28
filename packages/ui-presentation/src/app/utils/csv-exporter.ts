/**
 * UTF-8 BOM CSV Exporter (`\uFEFF`) for Thai Accounting & Tax Software (Express / Peak / FlowAccount / Excel).
 * Guarantees zero Thai character mojibake when opened directly in Microsoft Excel on Windows.
 */

const NEGATIVE_DECIMAL_RE = /^-\d+(?:\.\d+)?$/;

/**
 * Escapes CSV cells per RFC 4180 and neutralizes spreadsheet formula injection (`=`, `+`, `@`, `\t`, `\r`, non-numeric `-`).
 */
export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let raw = String(value);
  const trimmedStart = raw.trimStart();
  if (
    trimmedStart.length > 0 &&
    (trimmedStart[0] === '=' ||
      trimmedStart[0] === '+' ||
      trimmedStart[0] === '@' ||
      raw[0] === '\t' ||
      raw[0] === '\r' ||
      (trimmedStart[0] === '-' && !NEGATIVE_DECIMAL_RE.test(trimmedStart)))
  ) {
    raw = `'${raw}`;
  }
  if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function buildUtf8BomCsvContent(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>
): string {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const bodyLines = rows.map((row) => row.map(escapeCsvCell).join(','));
  return `\uFEFF${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

export function downloadUtf8BomCsv(
  filename: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>
): void {
  const csvContent = buildUtf8BomCsvContent(headers, rows);

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
