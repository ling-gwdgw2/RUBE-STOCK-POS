import React, { createContext, useContext, useEffect, useMemo } from 'react';
import {
  DEFAULT_TH_FISCAL_CONFIG,
  type CountryCode,
  type CurrencyCode,
  type FiscalConfigDto,
  type LocaleCode,
  formatFiscalDateTime,
  formatMicroUnitCost,
  formatMinorAmountForInput,
  formatMinorAmountPlain,
  formatMoney,
  formatVatRatePercent,
  parseMoneyInputToMinor,
} from '../../../../shared-contracts/src/currency.ts';
import { type UiStringKey, pickLocaleText, translateKey } from './translations.ts';

export interface I18nContextValue {
  fiscal: FiscalConfigDto;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  locale: LocaleCode;
  receiptLocale: LocaleCode;
  vatRatePercentLabel: string;
  t: (key: UiStringKey) => string;
  pick: (thText: string, loText: string, enText: string) => string;
  money: (minorSatang: number) => string;
  moneyPlain: (minorSatang: number) => string;
  moneyInput: (minorSatang: number) => string;
  unitCost: (microUnits: number) => string;
  parseMoney: (raw: string) => number;
  dateTime: (isoOrDate: string | Date) => string;
  onChangeLocale?: ((locale: LocaleCode) => Promise<void> | void) | undefined;
}

const defaultValue: I18nContextValue = {
  fiscal: DEFAULT_TH_FISCAL_CONFIG,
  countryCode: 'TH',
  currencyCode: 'THB',
  locale: 'th',
  receiptLocale: 'th',
  vatRatePercentLabel: '7',
  t: (key) => translateKey(key, 'th'),
  pick: (thText, _loText, _enText) => thText,
  money: (s) => formatMoney(s, 'THB'),
  moneyPlain: (s) => formatMinorAmountPlain(s, 'THB'),
  moneyInput: (s) => formatMinorAmountForInput(s, 'THB'),
  unitCost: (m) => formatMicroUnitCost(m, 'THB'),
  parseMoney: (raw) => parseMoneyInputToMinor(raw, 'THB'),
  dateTime: (d) => formatFiscalDateTime(d, 'TH', 'th'),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

export const I18nProvider: React.FC<{
  fiscalConfig?: FiscalConfigDto | undefined;
  overrideLocale?: LocaleCode | undefined;
  onChangeLocale?: ((locale: LocaleCode) => Promise<void> | void) | undefined;
  children: React.ReactNode;
}> = ({ fiscalConfig, overrideLocale, onChangeLocale, children }) => {
  const effectiveLocale = overrideLocale ?? (fiscalConfig ?? DEFAULT_TH_FISCAL_CONFIG).uiLocale;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = effectiveLocale;
      document.title = translateKey('app.windowTitle', effectiveLocale);
    }
  }, [effectiveLocale]);

  const value = useMemo<I18nContextValue>(() => {
    const fiscal = fiscalConfig ?? DEFAULT_TH_FISCAL_CONFIG;
    const locale = overrideLocale ?? fiscal.uiLocale;
    return {
      fiscal,
      countryCode: fiscal.countryCode,
      currencyCode: fiscal.currencyCode,
      locale,
      receiptLocale: fiscal.receiptLocale,
      vatRatePercentLabel: formatVatRatePercent(fiscal.vatRateBps),
      t: (key) => translateKey(key, locale),
      pick: (thText, loText, enText) => pickLocaleText(locale, thText, loText, enText),
      money: (minorSatang) => formatMoney(minorSatang, fiscal.currencyCode),
      moneyPlain: (minorSatang) => formatMinorAmountPlain(minorSatang, fiscal.currencyCode),
      moneyInput: (minorSatang) => formatMinorAmountForInput(minorSatang, fiscal.currencyCode),
      unitCost: (microUnits) => formatMicroUnitCost(microUnits, fiscal.currencyCode),
      parseMoney: (raw) => parseMoneyInputToMinor(raw, fiscal.currencyCode),
      dateTime: (isoOrDate) => formatFiscalDateTime(isoOrDate, fiscal.countryCode, locale),
      onChangeLocale,
    };
  }, [fiscalConfig, onChangeLocale, overrideLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export { pickLocaleText, translateKey, type UiStringKey };
