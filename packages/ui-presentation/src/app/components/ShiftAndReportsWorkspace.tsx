import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Banknote,
  BarChart3,
  Calculator,
  Download,
  EyeOff,
  FileText,
  HardDriveDownload,
  LockKeyhole,
  Printer,
  Receipt,
  RotateCcw,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import {
  foreignMinorToBaseLakMinor,
  formatForeignMoney,
  getCashDenominationsForCountry,
} from '../../../../shared-contracts/src/currency.ts';
import { parseDecimalStringToScaledInt } from '../../../../shared-contracts/src/fixed-point.ts';
import { posTransport, type ReportsBundleDto } from '../api/pos-transport.ts';
import { useI18n } from '../i18n/index.tsx';
import type { BootstrapPayload, StaffUserDto } from '../types.ts';
import { downloadUtf8BomCsv } from '../utils/csv-exporter.ts';
import { canViewCostAndMarginReports, canViewExpectedDrawerCash } from '../utils/rbac.ts';
import { renderThaiZReportTo203DpiCanvasRaster } from '../utils/thai-canvas-rasterizer.ts';
import { ConfirmDialog, ModalDialog, UI_INTERACTION } from './ui/UiPrimitives.tsx';

interface ShiftAndReportsWorkspaceProps {
  outletId?: string;
  bootstrap: BootstrapPayload;
  currentUser: StaffUserDto;
  onRefreshState: () => Promise<void>;
  onToast: (msg: string, tone?: 'success' | 'warn' | 'error') => void;
}

export const ShiftAndReportsWorkspace: React.FC<ShiftAndReportsWorkspaceProps> = ({
  outletId = 'OUTLET-HQ',
  bootstrap,
  currentUser,
  onRefreshState,
  onToast,
}) => {
  const {
    fiscal,
    countryCode,
    currencyCode,
    receiptLocale,
    vatRatePercentLabel,
    t,
    pick,
    money,
    moneyInput,
    parseMoney,
    dateTime,
  } = useI18n();
  const isLaos = countryCode === 'LA';
  const currencyUnitLabel = isLaos ? t('currency.unit.LAK') : t('currency.unit.THB');
  const activeDenominations = useMemo(
    () =>
      getCashDenominationsForCountry(countryCode).map((d) => ({
        ...d,
        label: `${d.kind === 'NOTE' ? t('rep.noteLabel') : t('rep.coinLabel')} ${money(d.satang)}`,
      })),
    [countryCode, money, t]
  );

  const uid = useId();
  const showExpectedCash = canViewExpectedDrawerCash(currentUser.role);
  const showCostReports = canViewCostAndMarginReports(currentUser.role);

  const [reportTab, setReportTab] = useState<
    'SHIFT_DRAWER' | 'Z_REPORT' | 'ABB_TAX' | 'VALUATION' | 'MARGIN'
  >('SHIFT_DRAWER');
  const [reports, setReports] = useState<ReportsBundleDto | null>(null);
  const [selectedShiftIdForZ, setSelectedShiftIdForZ] = useState<string>(
    bootstrap.activeShift?.id ?? ''
  );
  const [reportStartDate, setReportStartDate] = useState<string>('');
  const [reportEndDate, setReportEndDate] = useState<string>('');

  // Cash Drawer Movement Form
  const [mvType, setMvType] = useState<'PAID_IN' | 'PAID_OUT' | 'CASH_DROP'>('PAID_IN');
  const [mvAmountBaht, setMvAmountBaht] = useState(isLaos ? '50000' : '200.00');
  const [mvReason, setMvReason] = useState(
    pick('แลกเหรียญทอนเข้าลิ้นชัก', 'ແລກເງິນທອນເຂົ້າລິ້ນຊັກ', 'Cash float replenishment')
  );

  // True Blind Drop Shift Close (NEVER pre-filled with expectedCashSatang!)
  const [countedCashBaht, setCountedCashBaht] = useState<string>('');
  const [showDenomHelper, setShowDenomHelper] = useState<boolean>(true);
  const [denomCounts, setDenomCounts] = useState<Record<string, string>>({});
  const [countedForeignThbInput, setCountedForeignThbInput] = useState<string>('');
  const [countedForeignUsdInput, setCountedForeignUsdInput] = useState<string>('');
  const [openingCashInput, setOpeningCashInput] = useState<string>(isLaos ? '500000' : '1000.00');
  const [closeNotes, setCloseNotes] = useState(
    pick('ปิดกะตรวจนับเงินสดประจำวัน', 'ປິດກະກວດນັບເງິນສົດປະຈຳວັນ', 'Daily shift blind drop close')
  );
  const [confirmCloseOpen, setConfirmCloseOpen] = useState<boolean>(false);
  const [zPrintPaperMm, setZPrintPaperMm] = useState<80 | 58>(
    bootstrap.printerConfig?.paperWidthMm === 58 ? 58 : 80
  );
  const [zRasterPreview, setZRasterPreview] = useState<{
    previewUrl: string;
    shiftNumber: string;
    transportMode?: string | undefined;
    spoolStatus?: string | undefined;
    hardwareError?: string | undefined;
  } | null>(null);
  const [printingZ, setPrintingZ] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const reportsLoadSeqRef = useRef(0);

  useEffect(() => {
    setOpeningCashInput(isLaos ? '500000' : '1000.00');
    setMvAmountBaht(isLaos ? '50000' : '200.00');
  }, [isLaos]);

  useEffect(() => {
    if (!showCostReports && (reportTab === 'VALUATION' || reportTab === 'MARGIN')) {
      setReportTab('SHIFT_DRAWER');
    }
  }, [reportTab, showCostReports]);

  const fxDrawerEnabled = isLaos && fiscal.fxRates.enabled;

  const computeCombinedBlindDrop = (
    nextDenomMap: Record<string, string>,
    nextThbRaw: string,
    nextUsdRaw: string
  ) => {
    let totalSatang = 0;
    let hasAnyEntry = false;
    const parts: string[] = [];
    for (const d of activeDenominations) {
      const raw = (nextDenomMap[d.id] ?? '').trim();
      if (!raw) continue;
      const qty = Math.max(0, Math.floor(Number(raw) || 0));
      if (qty > 0) {
        hasAnyEntry = true;
        totalSatang += qty * d.satang;
        parts.push(`${money(d.satang)}×${qty}`);
      }
    }
    let thbSatang = 0;
    let thbEquivSatang = 0;
    if (fxDrawerEnabled && nextThbRaw.trim()) {
      try {
        thbSatang = Math.max(0, parseDecimalStringToScaledInt(nextThbRaw.trim(), 2));
        if (thbSatang > 0) {
          hasAnyEntry = true;
          thbEquivSatang = foreignMinorToBaseLakMinor(thbSatang, fiscal.fxRates.thbToLakRate);
          totalSatang += thbEquivSatang;
          parts.push(`THB ${formatForeignMoney(thbSatang, 'THB')}=${money(thbEquivSatang)}`);
        }
      } catch {
        // ignore partial typing
      }
    }
    let usdSatang = 0;
    let usdEquivSatang = 0;
    if (fxDrawerEnabled && nextUsdRaw.trim()) {
      try {
        usdSatang = Math.max(0, parseDecimalStringToScaledInt(nextUsdRaw.trim(), 2));
        if (usdSatang > 0) {
          hasAnyEntry = true;
          usdEquivSatang = foreignMinorToBaseLakMinor(usdSatang, fiscal.fxRates.usdToLakRate);
          totalSatang += usdEquivSatang;
          parts.push(`USD ${formatForeignMoney(usdSatang, 'USD')}=${money(usdEquivSatang)}`);
        }
      } catch {
        // ignore partial typing
      }
    }
    return {
      totalSatang,
      summaryText: parts.join(', '),
      hasAnyEntry,
      thbEquivSatang,
      usdEquivSatang,
    };
  };

  const denomBreakdownSummary = useMemo(
    () =>
      computeCombinedBlindDrop(denomCounts, countedForeignThbInput, countedForeignUsdInput),
    [
      activeDenominations,
      countedForeignThbInput,
      countedForeignUsdInput,
      denomCounts,
      fiscal.fxRates.thbToLakRate,
      fiscal.fxRates.usdToLakRate,
      fxDrawerEnabled,
      money,
    ]
  );

  const handleDenomChange = (denomId: string, rawVal: string) => {
    const digitsOnly = rawVal.replace(/[^\d]/g, '');
    const nextMap = { ...denomCounts, [denomId]: digitsOnly };
    setDenomCounts(nextMap);
    const combined = computeCombinedBlindDrop(
      nextMap,
      countedForeignThbInput,
      countedForeignUsdInput
    );
    setCountedCashBaht(combined.hasAnyEntry ? moneyInput(combined.totalSatang) : '');
  };

  const handleForeignCashCountChange = (currency: 'THB' | 'USD', rawVal: string) => {
    const cleaned = rawVal.replace(/[^0-9.]/g, '');
    const nextThb = currency === 'THB' ? cleaned : countedForeignThbInput;
    const nextUsd = currency === 'USD' ? cleaned : countedForeignUsdInput;
    if (currency === 'THB') setCountedForeignThbInput(cleaned);
    else setCountedForeignUsdInput(cleaned);
    const combined = computeCombinedBlindDrop(denomCounts, nextThb, nextUsd);
    setCountedCashBaht(combined.hasAnyEntry ? moneyInput(combined.totalSatang) : '');
  };

  const clearDenominationCounts = () => {
    setDenomCounts({});
    setCountedForeignThbInput('');
    setCountedForeignUsdInput('');
    setCountedCashBaht('');
  };

  const handleOpenNewShift = async () => {
    setBusy(true);
    try {
      const openingCashSatang = Math.max(0, parseMoney(openingCashInput || '0'));
      await posTransport.openShift({
        outletId,
        openedByUserId: currentUser.id,
        openingCashSatang,
        notes: 'Opened from Shifts & Reports workspace',
      });
      await onRefreshState();
      await loadReports();
      onToast('เปิดกะแคชเชียร์ใหม่เรียบร้อยแล้ว', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const formatLocalYyyyMmDd = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const applyDatePreset = (preset: 'ALL' | 'TODAY' | 'THIS_MONTH' | 'LAST_MONTH') => {
    const now = new Date();
    if (preset === 'ALL') {
      setReportStartDate('');
      setReportEndDate('');
      return;
    }
    if (preset === 'TODAY') {
      const today = formatLocalYyyyMmDd(now);
      setReportStartDate(today);
      setReportEndDate(today);
      return;
    }
    if (preset === 'THIS_MONTH') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setReportStartDate(formatLocalYyyyMmDd(first));
      setReportEndDate(formatLocalYyyyMmDd(last));
      return;
    }
    const prevFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevLast = new Date(now.getFullYear(), now.getMonth(), 0);
    setReportStartDate(formatLocalYyyyMmDd(prevFirst));
    setReportEndDate(formatLocalYyyyMmDd(prevLast));
  };

  const loadReports = async (shiftId?: string) => {
    const reqSeq = ++reportsLoadSeqRef.current;
    try {
      const res = await posTransport.getReports(outletId, shiftId || undefined, {
        ...(reportStartDate ? { startDate: reportStartDate } : {}),
        ...(reportEndDate ? { endDate: reportEndDate } : {}),
      });
      if (reqSeq !== reportsLoadSeqRef.current) return;
      setReports(res);
    } catch (err) {
      if (reqSeq !== reportsLoadSeqRef.current) return;
      onToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  useEffect(() => {
    reportsLoadSeqRef.current += 1;
    setSelectedShiftIdForZ('');
    setReports(null);
  }, [outletId]);

  useEffect(() => {
    void loadReports(selectedShiftIdForZ || bootstrap.activeShift?.id);
  }, [bootstrap.activeShift?.id, outletId, reportEndDate, reportStartDate, selectedShiftIdForZ]);

  const handleRecordMovement = async () => {
    setBusy(true);
    try {
      const amountSatang = parseMoney(mvAmountBaht);
      await posTransport.recordCashMovement({
        outletId,
        movementType: mvType,
        amountSatang,
        reason: mvReason,
        performedByUserId: currentUser.id,
      });
      await onRefreshState();
      await loadReports();
      onToast(
        `${pick('บันทึกรายการลิ้นชักเงินสด', 'ບັນທຶກລາຍການລິ້ນຊັກເງິນສົດ', 'Drawer movement recorded')} (${mvType})`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const parsedCountedSatang = useMemo(() => {
    if (!countedCashBaht.trim()) return null;
    try {
      return Math.max(0, parseMoney(countedCashBaht.trim()));
    } catch {
      return null;
    }
  }, [countedCashBaht, parseMoney]);

  const requestBlindDropClose = () => {
    if (parsedCountedSatang === null) {
      onToast(
        'กรุณาระบุยอดเงินสดในลิ้นชักที่นับได้จริง หรือกรอกจำนวนธนบัตร/เหรียญก่อนปิดกะ',
        'warn'
      );
      return;
    }
    setConfirmCloseOpen(true);
  };

  const executeBlindDropClose = async () => {
    if (parsedCountedSatang === null) return;
    setBusy(true);
    try {
      const composedNotes = denomBreakdownSummary.hasAnyEntry
        ? `${closeNotes.trim()} [นับจริง: ${denomBreakdownSummary.summaryText}]`
        : closeNotes.trim();
      const res = await posTransport.closeShiftAndBackup({
        outletId,
        countedCashSatang: parsedCountedSatang,
        closedByUserId: currentUser.id,
        reopenNextShift: true,
        notes: composedNotes,
      });
      setConfirmCloseOpen(false);
      clearDenominationCounts();
      await onRefreshState();
      setSelectedShiftIdForZ(res.closedShift.id);
      await loadReports(res.closedShift.id);
      setReportTab('Z_REPORT');
      onToast(
        `ปิดกะ ${res.closedShift.shiftNumber} & สำรองข้อมูลเข้ารหัสลง USB (${res.usbBackup.retainedBackupsCount}/14 กะ) สำเร็จ`,
        'success'
      );
      if (res.backupWarningThai) {
        onToast(res.backupWarningThai, 'warn');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const visibleSubTabs = [
    {
      id: 'SHIFT_DRAWER' as const,
      label: t('rep.tab.drawer'),
      icon: Wallet,
      visible: true,
    },
    {
      id: 'Z_REPORT' as const,
      label: t('rep.tab.zreport'),
      icon: FileText,
      visible: true,
    },
    {
      id: 'ABB_TAX' as const,
      label: isLaos ? t('rep.tab.tax.LA') : t('rep.tab.tax.TH'),
      icon: Receipt,
      visible: true,
    },
    {
      id: 'VALUATION' as const,
      label: t('rep.tab.valuation'),
      icon: BarChart3,
      visible: showCostReports,
    },
    {
      id: 'MARGIN' as const,
      label: t('rep.tab.margin'),
      icon: TrendingUp,
      visible: showCostReports,
    },
  ].filter((tabItem) => tabItem.visible);

  const isViewingOpenShiftAsBlindCashier =
    !showExpectedCash && reports?.zReport?.status === 'OPEN';

  const cleanNumericString = (formattedCurrency: string | null | undefined): string => {
    if (!formattedCurrency) return currencyCode === 'LAK' ? '0' : '0.00';
    return formattedCurrency.replace(/[฿₭,\s]/g, '');
  };

  const handlePrintThermalZReport = async (overrideWidthMm?: 80 | 58) => {
    const z = reports?.zReport;
    if (!z || isViewingOpenShiftAsBlindCashier) return;
    const widthMm = overrideWidthMm ?? zPrintPaperMm;
    setPrintingZ(true);
    try {
      const raster = renderThaiZReportTo203DpiCanvasRaster({
        paperWidthMm: widthMm,
        countryCode,
        receiptLocale,
        vatRatePercentLabel,
        storeName: bootstrap.storeSettings.storeName,
        storeAddress: fiscal.storeAddress,
        taxId: bootstrap.storeSettings.taxId,
        branchCode: bootstrap.storeSettings.branchCode,
        posRegNo: bootstrap.storeSettings.rdPosRegNo,
        shiftNumber: z.shiftNumber,
        status: z.status,
        openedAtText: dateTime(z.openedAt),
        closedAtText: z.closedAt
          ? dateTime(z.closedAt)
          : pick('ยังไม่ปิดกะ', 'ຍັງບໍ່ປິດກະ', 'Open'),
        printedByName: currentUser.displayName,
        completedOrdersCount: z.completedOrdersCount,
        voidedOrdersCount: z.voidedOrdersCount,
        voidedTotalText: z.voidedTotalFormatted,
        grossSalesText: z.grossSalesFormatted,
        discountsText: z.discountsFormatted,
        netBeforeTaxText: z.netBeforeTaxFormatted,
        vat7PercentText: z.vat7PercentFormatted,
        netSalesTotalText: z.netSalesTotalFormatted,
        cashSalesText: z.cashSalesFormatted,
        promptPaySalesText: z.promptPaySalesFormatted,
        cardSalesText: z.cardSalesFormatted,
        voucherSalesText: z.voucherSalesFormatted,
        openingCashText: z.openingCashFormatted,
        paidInText: z.paidInFormatted,
        paidOutText: z.paidOutFormatted,
        cashDropText: z.cashDropFormatted,
        expectedCashText: z.expectedDrawerCashFormatted,
        countedCashText: z.countedDrawerCashFormatted ?? '—',
        cashVarianceText:
          z.cashVarianceFormatted ?? pick('ยังไม่ปิดกะ', 'ຍັງບໍ່ປິດກະ', 'Open'),
        ...(z.fxCashSummaryFormatted && z.fxCashSummaryFormatted.fxTransactionsCount > 0
          ? {
              fxDrawerLines: [
                t('fx.drawerSummaryTitle'),
                `${pick('เงินสดกีบแท้ (LAK)', 'ເງິນສົດກີບແທ້ (LAK)', 'Native LAK')}: ${z.fxCashSummaryFormatted.expectedNativeBaseCashFormatted}`,
                ...(z.fxCashSummaryFormatted.thbCollectedSatang > 0
                  ? [
                      `THB: ${z.fxCashSummaryFormatted.thbCollectedFormatted} (= ${z.fxCashSummaryFormatted.thbEquivalentFormatted})`,
                    ]
                  : []),
                ...(z.fxCashSummaryFormatted.usdCollectedSatang > 0
                  ? [
                      `USD: ${z.fxCashSummaryFormatted.usdCollectedFormatted} (= ${z.fxCashSummaryFormatted.usdEquivalentFormatted})`,
                    ]
                  : []),
              ],
            }
          : {}),
      });

      const hwRes = await posTransport.printCanvasRaster({
        packedBitmapBase64: raster.packedBitmapBase64,
        widthPx: raster.widthPx,
        heightPx: raster.heightPx,
        kickCashDrawer: false,
        receiptNumber: `Z-${z.shiftNumber}`,
      });

      setZRasterPreview({
        previewUrl: raster.previewDataUrl,
        shiftNumber: z.shiftNumber,
        transportMode: hwRes.hardwareOutcome.transportMode,
        spoolStatus: hwRes.spoolResult.status,
        ...(hwRes.hardwareOutcome.errorMessage
          ? { hardwareError: hwRes.hardwareOutcome.errorMessage }
          : {}),
      });
      await onRefreshState();
      if (hwRes.hardwareOutcome.errorMessage) {
        onToast(
          `ส่งพิมพ์ใบ Z-Report (${z.shiftNumber}) ไปยังเครื่องพิมพ์ไม่สำเร็จ: ${hwRes.hardwareOutcome.errorMessage}`,
          'error'
        );
      } else if (hwRes.spoolResult.status !== 'PRINTED_IMMEDIATELY') {
        onToast(
          `เครื่องพิมพ์ยังไม่พร้อม — เก็บใบ Z-Report (${z.shiftNumber}) เข้าคิว Spooler (${hwRes.spoolResult.pendingQueueLength} ใบ) แล้ว`,
          'warn'
        );
      } else {
        onToast(`สร้างและส่งพิมพ์ใบสรุปปิดกะ Z-Report (${z.shiftNumber}) สำเร็จ`, 'success');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPrintingZ(false);
    }
  };

  const handleExportZReportCsv = () => {
    const z = reports?.zReport;
    if (!z || isViewingOpenShiftAsBlindCashier) return;
    downloadUtf8BomCsv(
      `Z_Report_${outletId}_${z.shiftNumber}.csv`,
      ['Item', `Amount (${currencyCode})`],
      [
        ['Outlet', outletId],
        ['Shift', z.shiftNumber],
        ['Status', z.status],
        ['Opened At', z.openedAt],
        ['Closed At', z.closedAt ?? 'OPEN'],
        ['Completed Orders', z.completedOrdersCount],
        ['Voided Orders', z.voidedOrdersCount],
        ['Voided Total', cleanNumericString(z.voidedTotalFormatted)],
        ['Gross Sales', cleanNumericString(z.grossSalesFormatted)],
        ['Discounts', cleanNumericString(z.discountsFormatted)],
        ['Net Before Tax', cleanNumericString(z.netBeforeTaxFormatted)],
        [`Output VAT ${vatRatePercentLabel}%`, cleanNumericString(z.vat7PercentFormatted)],
        ['Net Sales Total', cleanNumericString(z.netSalesTotalFormatted)],
        ['Cash Sales', cleanNumericString(z.cashSalesFormatted)],
        [isLaos ? 'LAOQR / OnePay Sales' : 'PromptPay QR Sales', cleanNumericString(z.promptPaySalesFormatted)],
        ['Card / EDC Sales', cleanNumericString(z.cardSalesFormatted)],
        ['Opening Float', cleanNumericString(z.openingCashFormatted)],
        ['Paid-In', cleanNumericString(z.paidInFormatted)],
        ['Paid-Out', cleanNumericString(z.paidOutFormatted)],
        ['Cash Drop', cleanNumericString(z.cashDropFormatted)],
        ['Expected Drawer Cash', cleanNumericString(z.expectedDrawerCashFormatted)],
        ['Counted Drawer Cash', z.countedDrawerCashFormatted ? cleanNumericString(z.countedDrawerCashFormatted) : ''],
        ['Cash Variance', z.cashVarianceFormatted ? cleanNumericString(z.cashVarianceFormatted) : ''],
      ]
    );
    onToast(`Exported Z_Report_${outletId}_${z.shiftNumber}.csv`, 'success');
  };

  const handleExportAbbTaxCsv = () => {
    if (!reports) return;
    const rangeTag =
      reportStartDate || reportEndDate
        ? `${reportStartDate || 'start'}_to_${reportEndDate || 'now'}`
        : new Date().toISOString().slice(0, 10);
    downloadUtf8BomCsv(
      `${isLaos ? 'LAO_TaxRIS_VAT' : 'ABB_SalesTax_VAT'}${vatRatePercentLabel}_${outletId}_${rangeTag}.csv`,
      [
        isLaos ? 'Invoice No (INV-LA)' : 'เลขที่ใบกำกับภาษีอย่างย่อ (ABB)',
        'Receipt No',
        'Timestamp',
        'Order Type',
        'Status',
        `Taxable Base (${currencyCode})`,
        `VAT ${vatRatePercentLabel}% (${currencyCode})`,
        `Grand Total (${currencyCode})`,
      ],
      reports.abbReport.invoices.map((inv) => [
        inv.abbTaxInvoiceNo,
        inv.receiptNumber,
        inv.createdAt,
        inv.orderType,
        inv.status,
        cleanNumericString(inv.netBeforeTaxFormatted),
        cleanNumericString(inv.taxFormatted),
        cleanNumericString(inv.totalFormatted),
      ])
    );
    onToast(`Exported VAT ${vatRatePercentLabel}% (${currencyCode}) CSV`, 'success');
  };

  const handleExportValuationCsv = () => {
    if (!reports) return;
    const dateTag = new Date().toISOString().slice(0, 10);
    downloadUtf8BomCsv(
      `Stock_Valuation_MAC_${outletId}_${dateTag}.csv`,
      ['SKU', 'Item', 'In Stock', `MAC (${currencyCode})`, `Valuation (${currencyCode})`],
      reports.valuationReport.lines.map((l) => [
        l.sku,
        l.itemName,
        l.stockFormatted,
        cleanNumericString(l.macFormatted),
        cleanNumericString(l.valuationFormatted),
      ])
    );
    onToast('Exported Stock Valuation CSV', 'success');
  };

  const handleExportMarginCsv = () => {
    if (!reports) return;
    const rangeTag =
      reportStartDate || reportEndDate
        ? `${reportStartDate || 'start'}_to_${reportEndDate || 'now'}`
        : new Date().toISOString().slice(0, 10);
    downloadUtf8BomCsv(
      `Menu_COGS_Margin_${outletId}_${rangeTag}.csv`,
      ['Item', 'Qty Sold', `Revenue (${currencyCode})`, `COGS (${currencyCode})`, `Gross Profit (${currencyCode})`, '% GP Margin'],
      reports.marginReport.lines.map((l) => [
        l.itemName,
        l.soldQtyFormatted,
        cleanNumericString(l.revenueFormatted),
        cleanNumericString(l.cogsFormatted),
        cleanNumericString(l.grossProfitFormatted),
        l.grossMarginPercentFormatted,
      ])
    );
    onToast('Exported COGS & Margin CSV', 'success');
  };

  return (
    <div className="space-y-6">
      {/* Canonical Google Underline Sub-Navigation Tabs */}
      <div className="border-b border-hairline bg-canvas">
        <div
          className="flex items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="หมวดหมู่รายงานและปิดกะ"
        >
          {visibleSubTabs.map((t) => {
            const Icon = t.icon;
            const active = reportTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setReportTab(t.id)}
                className={`relative flex h-12 items-center gap-2 px-3.5 font-google-display text-[15px] font-medium tracking-[0.25px] whitespace-nowrap ${UI_INTERACTION.focusButton} ${
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-primary' : ''}`} />
                <span>{t.label}</span>
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {(reportTab === 'ABB_TAX' || (reportTab === 'MARGIN' && showCostReports)) && (
        <div className="rounded-[4px] border border-hairline bg-surface-1 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink mr-1">กรองช่วงวันที่ (ภ.พ.30 / สรุปยอด):</span>
            {(
              [
                { id: 'ALL', label: 'ทั้งหมด' },
                { id: 'TODAY', label: 'วันนี้' },
                { id: 'THIS_MONTH', label: 'เดือนนี้ (ภ.พ.30)' },
                { id: 'LAST_MONTH', label: 'เดือนที่แล้ว' },
              ] as const
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyDatePreset(preset.id)}
                className={`rounded-[48px] border border-hairline bg-canvas px-3 py-1 font-google-display text-[11px] font-medium text-ink hover:border-primary hover:text-primary ${UI_INTERACTION.focusButton}`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 tabular-nums-google">
            <label htmlFor={`${uid}-rep-start`} className="text-ink-muted">
              ตั้งแต่:
            </label>
            <input
              id={`${uid}-rep-start`}
              type="date"
              value={reportStartDate}
              onChange={(e) => setReportStartDate(e.target.value)}
              className={`h-9 rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
            />
            <label htmlFor={`${uid}-rep-end`} className="text-ink-muted">
              ถึง:
            </label>
            <input
              id={`${uid}-rep-end`}
              type="date"
              value={reportEndDate}
              onChange={(e) => setReportEndDate(e.target.value)}
              className={`h-9 rounded-[4px] border border-hairline bg-canvas px-2.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
            />
          </div>
        </div>
      )}

      {/* TAB 1: SHIFT CASH DRAWER (NO ACTIVE SHIFT FALLBACK) */}
      {reportTab === 'SHIFT_DRAWER' && !bootstrap.activeShift && (
        <div className="max-w-lg rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="bg-hero p-6 text-white">
            <div className="text-xs uppercase tracking-[0.5px] text-white/75">POS Shift</div>
            <h3 className="mt-1 font-google-display text-[26px] font-normal leading-[34px] tracking-[-0.25px]">
              ยังไม่มีกะแคชเชียร์ที่เปิดใช้งาน
            </h3>
            <p className="mt-1 text-xs text-white/75">
              กรุณาระบุเงินทอนตั้งต้นเพื่อเปิดกะใหม่ก่อนเริ่มบันทึกการขายหน้าร้าน
            </p>
          </div>
          <div className="p-6 space-y-4">
            <div>
              <label
                htmlFor={`${uid}-open-cash`}
                className="block text-xs font-medium text-ink-muted mb-1.5"
              >
                {pick('เงินสดทอนตั้งต้นในลิ้นชัก', 'ເງິນສົດທອນຕັ້ງຕົ້ນໃນລິ້ນຊັກ', 'Opening Cash Float')} ({currencyUnitLabel})
              </label>
              <input
                id={`${uid}-open-cash`}
                type="text"
                value={openingCashInput}
                onChange={(e) => setOpeningCashInput(e.target.value)}
                className={`h-12 w-full rounded-[4px] border border-hairline bg-canvas px-4 font-google-display text-[22px] font-normal text-ink tabular-nums-google ${UI_INTERACTION.focusControl}`}
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleOpenNewShift()}
              className={`h-[50px] w-full rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              เปิดกะแคชเชียร์ใหม่
            </button>
          </div>
        </div>
      )}

      {/* TAB 1: SHIFT CASH DRAWER & TRUE BLIND DROP CLOSE */}
      {reportTab === 'SHIFT_DRAWER' && bootstrap.activeShift && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left: Active Shift Hero + Cash In/Out */}
          <div className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas overflow-hidden">
            <div className="bg-hero p-6 text-white flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 rounded-[48px] border border-white/25 px-3 py-1 text-xs font-medium text-white">
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  <span>กะกำลังเปิดใช้งาน (OPEN SHIFT)</span>
                </div>
                <h2 className="mt-2 font-google-display text-[28px] font-normal leading-[36px] tracking-[-0.25px] text-white tabular-nums-google">
                  {bootstrap.activeShift.shiftNumber}
                </h2>
              </div>

              <div className="text-left sm:text-right">
                {showExpectedCash ? (
                  <>
                    <div className="text-xs text-white/75">
                      เงินสดคาดหวังในลิ้นชัก (Expected Cash · สิทธิ์ผู้จัดการ)
                    </div>
                    <div className="mt-1 font-google-display text-[32px] sm:text-[38px] font-normal leading-[40px] sm:leading-[46px] tracking-[-0.5px] text-white tabular-nums-google">
                      {money(bootstrap.activeShift.expectedCashSatang)}
                    </div>
                  </>
                ) : (
                  <div className="rounded-[8px] border border-white/20 bg-white/10 px-4 py-2.5">
                    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-white">
                      <EyeOff className="h-3.5 w-3.5 text-primary" />
                      <span>ซ่อนยอดเงินสดตามกฎ Blind Drop</span>
                    </div>
                    <p className="text-[11px] text-white/75 mt-0.5">
                      นับเงินจริงจากลิ้นชักเพื่อดูผลกระทบยอดในใบ Z-Report หลังปิดกะ
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 space-y-5 bg-canvas">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="rounded-[4px] border border-hairline bg-surface-1 p-4">
                  <div className="text-ink-muted">เงินทอนตั้งต้นเปิดกะ (Opening Float)</div>
                  <div className="mt-1 font-google-display text-[22px] font-normal text-ink tabular-nums-google">
                    {money(bootstrap.activeShift.openingCashSatang)}
                  </div>
                </div>
                <div className="rounded-[4px] border border-hairline bg-surface-1 p-4">
                  <div className="text-ink-muted">{pick('เวลาเปิดกะ', 'ເວລາເປີດກະ', 'Opened At')}</div>
                  <div className="mt-1.5 font-google-display text-[16px] font-normal text-ink tabular-nums-google">
                    {dateTime(bootstrap.activeShift.openedAt)}
                  </div>
                </div>
              </div>

              {/* Record Paid-In / Paid-Out / Safe Drop */}
              <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 space-y-3">
                <div className="font-google-display text-sm font-medium text-ink">
                  บันทึกนำเงินเข้า / จ่ายเงินสดย่อย / ดึงเงินเก็บเซฟ (Cash Drawer Movements)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <select
                    aria-label="ประเภทรายการเคลื่อนไหวเงินสด"
                    value={mvType}
                    onChange={(e) =>
                      setMvType(e.target.value as 'PAID_IN' | 'PAID_OUT' | 'CASH_DROP')
                    }
                    className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink ${UI_INTERACTION.focusSelect}`}
                  >
                    <option value="PAID_IN">PAID_IN (+ นำเงินทอนเข้า)</option>
                    <option value="PAID_OUT">PAID_OUT (- จ่ายค่าใช้จ่ายย่อย)</option>
                    <option value="CASH_DROP">CASH_DROP (- นำฝากตู้เซฟ)</option>
                  </select>
                  <input
                    type="text"
                    aria-label={`${pick('จำนวนเงิน', 'ຈຳນວນເງິນ', 'Amount')} (${currencyUnitLabel})`}
                    value={mvAmountBaht}
                    onChange={(e) => setMvAmountBaht(e.target.value)}
                    placeholder={`${pick('จำนวนเงิน', 'ຈຳນວນເງິນ', 'Amount')} (${currencyUnitLabel})`}
                    className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-right text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                  />
                  <input
                    type="text"
                    aria-label="หมายเหตุรายการเคลื่อนไหวเงินสด"
                    value={mvReason}
                    onChange={(e) => setMvReason(e.target.value)}
                    placeholder="หมายเหตุ..."
                    className={`h-11 rounded-[4px] border border-hairline bg-canvas px-3 text-ink placeholder:text-ink-muted ${UI_INTERACTION.focusControl}`}
                  />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRecordMovement()}
                  className={`h-[46px] w-full rounded-[48px] border border-hairline bg-canvas px-5 font-google-display text-xs font-medium tracking-[0.5px] text-primary hover:border-primary hover:bg-primary-soft/40 hover:text-primary-dark ${UI_INTERACTION.focusButton}`}
                >
                  บันทึกรายการเคลื่อนไหวเงินสดในลิ้นชัก
                </button>
              </div>

              {/* Drawer Movements Log */}
              <div className="divide-y divide-hairline rounded-[4px] border border-hairline max-h-60 overflow-y-auto">
                {bootstrap.drawerMovements.length === 0 ? (
                  <div className="py-6 text-center text-xs text-ink-muted">
                    ยังไม่มีรายการเคลื่อนไหวเงินสดในลิ้นชักของกะนี้
                  </div>
                ) : (
                  bootstrap.drawerMovements.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between bg-canvas px-4 py-3 text-xs hover:bg-surface-1 transition-colors duration-150"
                    >
                      <div className="flex items-center gap-2.5">
                        {m.movementType === 'OPENING_FLOAT' || m.movementType === 'PAID_IN' ? (
                          <ArrowUpCircle className="h-4 w-4 text-primary shrink-0" />
                        ) : (
                          <ArrowDownCircle className="h-4 w-4 text-ink-muted shrink-0" />
                        )}
                        <div>
                          <div className="font-medium text-ink">
                            {m.movementType} — {m.reason}
                          </div>
                          <div className="text-[11px] text-ink-muted tabular-nums-google">
                            {m.performedByName} · {dateTime(m.createdAt)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right tabular-nums-google">
                        <div className="font-google-display text-sm font-medium text-ink">
                          {m.movementType === 'OPENING_FLOAT' || m.movementType === 'PAID_IN'
                            ? '+'
                            : '-'}
                          {money(m.amountSatang)}
                        </div>
                        {showExpectedCash && (
                          <div className="text-[11px] text-ink-muted">
                            {pick('คงเหลือคาดหวัง', 'ຄົງເຫຼືອຄາດຫວັງ', 'Expected')}{' '}
                            {money(m.expectedCashAfterSatang)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: True Blind Drop + Thai Denomination Counter + 14-Shift USB Backup */}
          <div className="xl:col-span-6 rounded-[4px] border border-hairline bg-canvas p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-dark">
                  <LockKeyhole className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-google-display text-[20px] font-normal leading-[28px] text-ink">
                    ปิดกะนับเงินสดจริง (True Blind Drop) &amp; สำรอง USB
                  </h3>
                  <p className="text-xs text-ink-muted mt-1">
                    ไม่ดึงยอดอัตโนมัติ — นับจำนวนธนบัตรและเหรียญจริงเพื่อป้องกันการตกแต่งตัวเลข
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowDenomHelper((v) => !v)}
                className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <Calculator className="h-3.5 w-3.5" />
                <span>{showDenomHelper ? 'ซ่อนตารางนับแบงก์/เหรียญ' : 'เปิดตารางนับแบงก์/เหรียญ'}</span>
              </button>
            </div>

            {showDenomHelper && (
              <div className="rounded-[4px] border border-hairline bg-surface-1 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-google-display text-xs font-medium text-ink flex items-center gap-1.5">
                    <Banknote className="h-4 w-4 text-primary" />
                    {isLaos
                      ? pick(
                          'เครื่องช่วยนับธนบัตรกีบลาว (LAK 500–100,000 ₭)',
                          'ເຄື່ອງຊ່ວຍນັບທະນະບັດເງິນກີບລາວ (500–100,000 ₭)',
                          'Lao Kip Banknote Counter (500–100,000 ₭)'
                        )
                      : 'เครื่องช่วยนับธนบัตรและเหรียญไทย (คำนวณยอดรวมอัตโนมัติ)'}
                  </span>
                  {denomBreakdownSummary.hasAnyEntry && (
                    <button
                      type="button"
                      onClick={clearDenominationCounts}
                      className={`inline-flex items-center gap-1 rounded-[48px] px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:bg-canvas hover:text-ink ${UI_INTERACTION.focusButton}`}
                    >
                      <RotateCcw className="h-3 w-3" /> {pick('ล้างจำนวนที่นับ', 'ລ້າງຈຳນວນ', 'Clear')}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                  {activeDenominations.map((d) => {
                    const countVal = denomCounts[d.id] ?? '';
                    const qty = Math.max(0, Math.floor(Number(countVal || '0') || 0));
                    const lineSatang = qty * d.satang;
                    return (
                      <div
                        key={d.id}
                        className="rounded-[4px] border border-hairline bg-canvas p-2.5 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <label htmlFor={`${uid}-denom-${d.id}`} className="font-medium text-ink">
                            {d.label}
                          </label>
                          {qty > 0 && (
                            <span className="text-[11px] font-medium text-primary-dark tabular-nums-google">
                              {money(lineSatang)}
                            </span>
                          )}
                        </div>
                        <input
                          id={`${uid}-denom-${d.id}`}
                          type="text"
                          inputMode="numeric"
                          value={countVal}
                          onChange={(e) => handleDenomChange(d.id, e.target.value)}
                          placeholder={isLaos ? '0 ໃບ' : '0 ใบ/เหรียญ'}
                          className={`h-9 w-full rounded-[4px] border border-hairline bg-surface-1 px-2.5 text-right text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                        />
                      </div>
                    );
                  })}
                </div>

                {fxDrawerEnabled && (
                  <div className="border-t border-hairline pt-3 space-y-2">
                    <div className="text-xs font-medium text-ink">
                      {pick(
                        'ธนบัตรต่างประเทศในลิ้นชัก (แปลงเป็น LAK รวมในยอดปิดกะอัตโนมัติ)',
                        'ທະນະບັດຕ່າງປະເທດໃນລິ້ນຊັກ (ແປງເປັນ LAK ລວມໃນຍອດປິດກະອັດຕະໂນມັດ)',
                        'Foreign Cash Counted in Drawer (Auto-converted to LAK)'
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                      <div className="rounded-[4px] border border-hairline bg-canvas p-2.5 space-y-1">
                        <div className="flex items-center justify-between gap-1">
                          <label htmlFor={`${uid}-blind-thb`} className="font-medium text-ink">
                            THB ฿ (@ {fiscal.fxRates.thbToLakRate.toLocaleString('en-US')} ₭)
                          </label>
                          {denomBreakdownSummary.thbEquivSatang > 0 && (
                            <span className="text-[11px] font-medium text-primary-dark tabular-nums-google">
                              = {money(denomBreakdownSummary.thbEquivSatang)}
                            </span>
                          )}
                        </div>
                        <input
                          id={`${uid}-blind-thb`}
                          type="text"
                          inputMode="decimal"
                          value={countedForeignThbInput}
                          onChange={(e) => handleForeignCashCountChange('THB', e.target.value)}
                          placeholder="0.00 THB"
                          className={`h-9 w-full rounded-[4px] border border-hairline bg-surface-1 px-2.5 text-right text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                        />
                      </div>
                      <div className="rounded-[4px] border border-hairline bg-canvas p-2.5 space-y-1">
                        <div className="flex items-center justify-between gap-1">
                          <label htmlFor={`${uid}-blind-usd`} className="font-medium text-ink">
                            USD $ (@ {fiscal.fxRates.usdToLakRate.toLocaleString('en-US')} ₭)
                          </label>
                          {denomBreakdownSummary.usdEquivSatang > 0 && (
                            <span className="text-[11px] font-medium text-primary-dark tabular-nums-google">
                              = {money(denomBreakdownSummary.usdEquivSatang)}
                            </span>
                          )}
                        </div>
                        <input
                          id={`${uid}-blind-usd`}
                          type="text"
                          inputMode="decimal"
                          value={countedForeignUsdInput}
                          onChange={(e) => handleForeignCashCountChange('USD', e.target.value)}
                          placeholder="0.00 USD"
                          className={`h-9 w-full rounded-[4px] border border-hairline bg-surface-1 px-2.5 text-right text-xs text-ink placeholder:text-ink-muted tabular-nums-google ${UI_INTERACTION.focusControl}`}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-[8px] bg-primary-soft p-4 space-y-3">
              <div>
                <label
                  htmlFor={`${uid}-counted-cash`}
                  className="block text-xs font-medium text-ink mb-1.5"
                >
                  {pick(
                    'ยอดเงินสดในลิ้นชักที่พนักงานนับได้จริงรวมทั้งสิ้น',
                    'ຍອດເງິນສົດໃນລິ້ນຊັກທີ່ນັບໄດ້ຈິງລວມທັງໝົດ',
                    'Total Counted Cash in Drawer'
                  )}{' '}
                  ({currencyUnitLabel})
                </label>
                <input
                  id={`${uid}-counted-cash`}
                  type="text"
                  inputMode="decimal"
                  value={countedCashBaht}
                  onChange={(e) => setCountedCashBaht(e.target.value)}
                  placeholder={isLaos ? 'ເຊັ່ນ 1250000' : 'ระบุยอดที่นับได้จริง เช่น 1850.00'}
                  className={`h-14 w-full rounded-[4px] border border-hairline bg-canvas px-4 font-google-display text-[28px] font-normal text-ink placeholder:text-ink-muted placeholder:text-base tabular-nums-google ${UI_INTERACTION.focusControl}`}
                />
              </div>
              <div>
                <label
                  htmlFor={`${uid}-close-notes`}
                  className="block text-xs font-medium text-ink-muted mb-1"
                >
                  บันทึกเพิ่มเติมท้ายกะ
                </label>
                <input
                  id={`${uid}-close-notes`}
                  type="text"
                  value={closeNotes}
                  onChange={(e) => setCloseNotes(e.target.value)}
                  className={`h-11 w-full rounded-[4px] border border-hairline bg-canvas px-3.5 text-xs text-ink ${UI_INTERACTION.focusControl}`}
                />
              </div>
            </div>

            <button
              type="button"
              disabled={busy || parsedCountedSatang === null}
              onClick={requestBlindDropClose}
              className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
            >
              <HardDriveDownload className="h-4 w-4 shrink-0" />
              <span>ยืนยันปิดกะ · ออกใบ Z-Report &amp; สำรองข้อมูล USB</span>
            </button>

            <div className="border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <div className="font-google-display text-xs font-medium text-ink">
                  ไฟล์สำรองข้อมูลเข้ารหัส 14 กะล่าสุด (USB Ring Buffer)
                </div>
                {bootstrap.usbBackupConfig && (
                  <span className="text-[11px] text-ink-muted truncate max-w-xs">
                    ปลายทาง:{' '}
                    {bootstrap.usbBackupConfig.isExternalCustomDir
                      ? bootstrap.usbBackupConfig.activeEffectiveDir
                      : 'โฟลเดอร์สำรองในเครื่อง (ตั้งค่า USB ได้ในตั้งค่าระบบ)'}
                  </span>
                )}
              </div>
              <div className="divide-y divide-hairline rounded-[4px] border border-hairline max-h-44 overflow-y-auto">
                {bootstrap.usbBackups.length === 0 ? (
                  <p className="text-xs text-ink-muted py-4 text-center">ยังไม่มีไฟล์สำรองข้อมูล</p>
                ) : (
                  bootstrap.usbBackups.map((b) => (
                    <div
                      key={b.filename}
                      className="bg-surface-1 px-3.5 py-2 flex items-center justify-between text-xs tabular-nums-google"
                    >
                      <span className="text-ink truncate">{b.filename}</span>
                      <span className="text-ink-muted shrink-0 ml-2">
                        {Math.max(1, Math.round(b.sizeBytes / 1024))} KB
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SHIFT Z-REPORT */}
      {reportTab === 'Z_REPORT' &&
        reports &&
        (reports.zReport === null ? (
          <div className="rounded-[4px] border border-hairline bg-canvas p-10 text-center text-sm text-ink-muted max-w-4xl">
            ยังไม่มีข้อมูลกะแคชเชียร์สำหรับออกรายงาน Z-Report
          </div>
        ) : (
          <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden max-w-4xl">
            <div className="bg-hero p-6 text-white flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.5px] text-white/75">
                  End-of-Shift Z-Report Reconciliation · {reports.zReport.shiftNumber} (
                  {reports.zReport.status})
                </div>
                <h3 className="mt-1 font-google-display text-[24px] sm:text-[28px] font-normal leading-[32px] sm:leading-[36px] tracking-[-0.25px] text-white">
                  รายงานสรุปยอดขายและกระทบยอดเงินสดประจำกะ
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!isViewingOpenShiftAsBlindCashier && (
                  <>
                    <button
                      type="button"
                      disabled={printingZ}
                      onClick={() => void handlePrintThermalZReport()}
                      className={`inline-flex h-11 items-center gap-1.5 rounded-[48px] bg-primary px-4 font-google-display text-xs font-medium text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
                    >
                      <Printer className="h-3.5 w-3.5" />
                      <span>{printingZ ? 'กำลังพิมพ์...' : 'พิมพ์ใบ Z-Report ความร้อน'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportZReportCsv}
                      className="inline-flex h-11 items-center gap-1.5 rounded-[48px] border border-white/30 bg-white/10 px-4 font-google-display text-xs font-medium text-white hover:bg-white/20 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export CSV</span>
                    </button>
                  </>
                )}
                <select
                  aria-label="เลือกกะสำหรับดูรายงาน Z-Report"
                  value={selectedShiftIdForZ || reports.zReport.shiftId}
                  onChange={(e) => setSelectedShiftIdForZ(e.target.value)}
                  className="h-11 rounded-[4px] border border-white/25 bg-white/10 px-3.5 text-xs text-white tabular-nums-google transition-colors duration-200 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary cursor-pointer"
                >
                  {(reports.shiftsHistory.length > 0
                    ? reports.shiftsHistory
                    : bootstrap.shiftsHistory
                  ).map((s) => (
                    <option key={s.id} value={s.id} className="bg-canvas text-ink">
                      {s.shiftNumber} ({s.status})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {isViewingOpenShiftAsBlindCashier ? (
              <div className="p-8 text-center space-y-3">
                <EyeOff className="h-9 w-9 text-primary mx-auto" />
                <h4 className="font-google-display text-[20px] font-normal text-ink">
                  ซ่อนตัวเลขกระทบยอดเงินสดชั่วคราวตามกฎ Blind Drop
                </h4>
                <p className="text-sm text-ink-muted max-w-lg mx-auto">
                  กะ {reports.zReport.shiftNumber} ยังเปิดใช้งานอยู่ — แคชเชียร์สามารถดูใบ Z-Report ฉบับสมบูรณ์พร้อมผลต่างเงินสด (Variance) ได้ทันทีหลังกดยืนยันปิดกะ หรือสลับเลือกดูประวัติกะที่ปิดไปแล้วด้านบน
                </p>
              </div>
            ) : (
              <div className="p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-[4px] border border-hairline bg-canvas p-4">
                    <div className="text-xs text-ink-muted">ยอดขายสุทธิรวม VAT</div>
                    <div className="mt-1 font-google-display text-[24px] font-normal text-ink tabular-nums-google">
                      {reports.zReport.netSalesTotalFormatted}
                    </div>
                  </div>
                  <div className="rounded-[4px] border border-hairline bg-canvas p-4">
                    <div className="text-xs text-ink-muted">
                      {pick(`ภาษีขาย VAT ${vatRatePercentLabel}%`, `ອາກອນຂາຍ ອມພ ${vatRatePercentLabel}%`, `Output VAT ${vatRatePercentLabel}%`)}
                    </div>
                    <div className="mt-1 font-google-display text-[24px] font-normal text-ink tabular-nums-google">
                      {reports.zReport.vat7PercentFormatted}
                    </div>
                  </div>
                  <div className="rounded-[4px] border border-hairline bg-canvas p-4">
                    <div className="text-xs text-ink-muted">บิลสำเร็จ / ยกเลิก</div>
                    <div className="mt-1 font-google-display text-[24px] font-normal text-ink tabular-nums-google">
                      {reports.zReport.completedOrdersCount} / {reports.zReport.voidedOrdersCount}
                    </div>
                    {reports.zReport.voidedOrdersCount > 0 && (
                      <div className="text-[11px] text-ink-muted tabular-nums-google mt-0.5">
                        ยอดยกเลิก {reports.zReport.voidedTotalFormatted}
                      </div>
                    )}
                  </div>
                  <div className="rounded-[4px] border border-primary bg-primary-soft/50 p-4">
                    <div className="text-xs font-medium text-primary-dark">
                      ส่วนต่างเงินสด (Variance)
                    </div>
                    <div className="mt-1 font-google-display text-[24px] font-normal text-ink tabular-nums-google">
                      {reports.zReport.cashVarianceFormatted ?? 'ยังไม่ปิดกะ'}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 space-y-2.5">
                    <div className="font-google-display text-sm font-medium text-ink">
                      แยกตามช่องทางรับชำระเงิน &amp; ฐานภาษี
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">ยอดขายก่อนส่วนลด (Gross Sales)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.grossSalesFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">ส่วนลดรวม</span>
                      <span className="font-medium text-primary-hover tabular-nums-google">
                        -{reports.zReport.discountsFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-hairline pb-2">
                      <span className="text-ink-muted">มูลค่าขายก่อนภาษี (Net Before Tax)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.netBeforeTaxFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">รับชำระด้วยเงินสด (Cash)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.cashSalesFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">
                        {isLaos
                          ? pick('รับชำระด้วย LAOQR / OnePay', 'ຮັບຊຳລະດ້ວຍ LAOQR / OnePay', 'LAOQR / OnePay')
                          : 'รับชำระด้วย PromptPay QR'}
                      </span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.promptPaySalesFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">รับชำระด้วยบัตรเครดิต / EDC</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.cardSalesFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">คูปองเงินสด (Voucher)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.voucherSalesFormatted}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-[4px] border border-hairline bg-surface-1 p-5 space-y-2.5">
                    <div className="font-google-display text-sm font-medium text-ink">
                      สมการกระทบยอดเงินสดในลิ้นชัก (Cash Conservation)
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">เงินทอนตั้งต้นเปิดกะ (Opening Float)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.openingCashFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">+ ยอดรับเงินสดจากการขาย (Cash Sales)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        +{reports.zReport.cashSalesFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">+ นำเงินสดเข้าลิ้นชัก (Paid-In)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        +{reports.zReport.paidInFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">- จ่ายเงินสดย่อย (Paid-Out)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        -{reports.zReport.paidOutFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-hairline pb-2">
                      <span className="text-ink-muted">- เก็บเงินเข้าเซฟ (Cash Drop)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        -{reports.zReport.cashDropFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">เงินสดตามสมการบัญชี (Expected)</span>
                      <span className="font-medium text-primary-hover tabular-nums-google">
                        {reports.zReport.expectedDrawerCashFormatted}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-muted">เงินสดที่นับได้จริง (Counted)</span>
                      <span className="font-medium text-ink tabular-nums-google">
                        {reports.zReport.countedDrawerCashFormatted ?? '—'}
                      </span>
                    </div>
                  </div>
                </div>

                {reports.zReport.fxCashSummaryFormatted &&
                  reports.zReport.fxCashSummaryFormatted.fxTransactionsCount > 0 && (
                    <div className="rounded-[4px] border border-primary/40 bg-surface-1 p-5 space-y-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-google-display text-sm font-medium text-ink">
                          {t('fx.drawerSummaryTitle')}
                        </span>
                        <span className="rounded-[48px] border border-hairline bg-canvas px-2.5 py-0.5 text-[11px] text-ink-muted tabular-nums-google">
                          {reports.zReport.fxCashSummaryFormatted.fxTransactionsCount}{' '}
                          {pick('บิลรับเงินต่างประเทศ', 'ບິນຮັບເງິນຕ່າງປະເທດ', 'FX Bills')}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                        <div className="rounded-[4px] border border-hairline bg-canvas p-3">
                          <div className="text-ink-muted">
                            {pick('เงินสดกีบแท้ในลิ้นชัก (Native LAK)', 'ເງິນສົດກີບແທ້ໃນລິ້ນຊັກ (Native LAK)', 'Expected Native LAK')}
                          </div>
                          <div className="mt-1 font-google-display text-lg font-medium text-ink tabular-nums-google">
                            {reports.zReport.fxCashSummaryFormatted.expectedNativeBaseCashFormatted}
                          </div>
                        </div>
                        <div className="rounded-[4px] border border-hairline bg-canvas p-3">
                          <div className="text-ink-muted">
                            {pick('ธนบัตรบาทไทยที่รับเข้า (THB)', 'ທະນະບັດບາດໄທທີ່ຮັບເຂົ້າ (THB)', 'THB Cash Collected')}
                          </div>
                          <div className="mt-1 font-google-display text-lg font-medium text-primary-hover tabular-nums-google">
                            {reports.zReport.fxCashSummaryFormatted.thbCollectedFormatted}
                          </div>
                          <div className="text-[11px] text-ink-muted tabular-nums-google">
                            = {reports.zReport.fxCashSummaryFormatted.thbEquivalentFormatted}
                          </div>
                        </div>
                        <div className="rounded-[4px] border border-hairline bg-canvas p-3">
                          <div className="text-ink-muted">
                            {pick('ธนบัตรดอลลาร์ที่รับเข้า (USD)', 'ທະນະບັດໂດລາທີ່ຮັບເຂົ້າ (USD)', 'USD Cash Collected')}
                          </div>
                          <div className="mt-1 font-google-display text-lg font-medium text-primary-hover tabular-nums-google">
                            {reports.zReport.fxCashSummaryFormatted.usdCollectedFormatted}
                          </div>
                          <div className="text-[11px] text-ink-muted tabular-nums-google">
                            = {reports.zReport.fxCashSummaryFormatted.usdEquivalentFormatted}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
              </div>
            )}
          </div>
        ))}

      {/* TAB 3: ABB SALES TAX REGISTER */}
      {reportTab === 'ABB_TAX' && reports && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="p-5 border-b border-hairline bg-surface-1 flex flex-wrap items-center justify-between gap-4">
            <h3 className="font-google-display text-[20px] font-normal text-ink">
              {isLaos
                ? pick(
                    `รายงานภาษีขาย สปป.ลาว (TaxRIS / VAT ${vatRatePercentLabel}%)`,
                    `ລາຍງານອາກອນມູນຄ່າເພີ່ມ ສປປ.ລາວ (TaxRIS / ອມພ ${vatRatePercentLabel}%)`,
                    `Lao PDR Sales Tax Register (TaxRIS / VAT ${vatRatePercentLabel}%)`
                  )
                : `รายงานภาษีขายใบกำกับภาษีอย่างย่อ (Thai RD ABB VAT ${vatRatePercentLabel}% Register)`}
            </h3>
            <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums-google">
              <span className="text-ink-muted">
                {pick('บิลปกติ / ยกเลิก', 'ບິນປົກກະຕິ / ຍົກເລີກ', 'Active / Voided')}:{' '}
                <strong className="font-medium text-ink">
                  {reports.abbReport.activeInvoiceCount} / {reports.abbReport.voidedInvoiceCount}
                </strong>
              </span>
              <span className="text-ink-muted">
                {pick('ฐานภาษีรวม', 'ຖານອາກອນລວມ', 'Taxable Base')}:{' '}
                <strong className="font-medium text-ink">
                  {reports.abbReport.totalTaxableBaseFormatted}
                </strong>
              </span>
              <span className="text-ink-muted">
                VAT {vatRatePercentLabel}%:{' '}
                <strong className="font-medium text-ink">
                  {reports.abbReport.totalVatFormatted}
                </strong>
              </span>
              <span className="text-ink-muted">
                {pick('ยอดรวมสุทธิ', 'ຍອດລວມສຸດທິ', 'Gross Total')}:{' '}
                <strong className="font-medium text-primary-hover">
                  {reports.abbReport.totalGrossFormatted}
                </strong>
              </span>
              <button
                type="button"
                onClick={handleExportAbbTaxCsv}
                className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:bg-primary-soft/50 ${UI_INTERACTION.focusButton}`}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-3 px-4">
                    {isLaos ? 'Invoice No (INV-LA)' : 'เลขที่ใบกำกับภาษี ABB'}
                  </th>
                  <th scope="col" className="py-3 px-4">
                    {pick('เลขที่ใบเสร็จ / เวลา', 'ເລກທີບິນ / ເວລາ', 'Receipt / Time')}
                  </th>
                  <th scope="col" className="py-3 px-4">
                    {pick('ประเภท / สถานะ', 'ປະເພດ / ສະຖານະ', 'Type / Status')}
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    {pick('มูลค่าก่อนภาษี', 'ມູນຄ່າກ່ອນອາກອນ', 'Net Before Tax')}
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    VAT {vatRatePercentLabel}%
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    {pick('ยอดสุทธิ', 'ຍອດສຸດທິ', 'Total')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {reports.abbReport.invoices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-ink-muted">
                      ยังไม่มีรายการใบกำกับภาษีอย่างย่อ (ABB) ในระบบ
                    </td>
                  </tr>
                ) : (
                  reports.abbReport.invoices.map((inv) => (
                    <tr
                      key={inv.abbTaxInvoiceNo}
                      className="hover:bg-surface-1 transition-colors duration-150"
                    >
                      <td className="py-3 px-4 font-medium text-ink tabular-nums-google">
                        {inv.abbTaxInvoiceNo}
                      </td>
                      <td className="py-3 px-4 text-ink-muted tabular-nums-google">
                        <div>{inv.receiptNumber}</div>
                        <div className="text-[11px]">{dateTime(inv.createdAt)}</div>
                      </td>
                      <td className="py-3 px-4 space-x-1.5">
                        <span className="rounded-[4px] border border-hairline bg-surface-1 px-2 py-0.5 text-[11px] text-ink-muted">
                          {inv.orderType}
                        </span>
                        <span
                          className={`rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${
                            inv.status === 'COMPLETED'
                              ? 'border-hairline bg-surface-1 text-ink'
                              : 'border-ink bg-ink text-white'
                          }`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-ink tabular-nums-google">
                        {inv.netBeforeTaxFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                        {inv.taxFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-ink tabular-nums-google">
                        {inv.totalFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: STOCK VALUATION (OWNER / MANAGER ONLY) */}
      {reportTab === 'VALUATION' && showCostReports && reports && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="p-5 border-b border-hairline bg-surface-1 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-google-display text-[20px] font-normal text-ink">
              รายงานมูลค่าสินค้าและวัตถุดิบคงคลัง (Warehouse Stock Valuation)
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <div className="font-google-display text-lg font-normal text-primary-hover tabular-nums-google">
                มูลค่ารวมทั้งคลัง: {reports.valuationReport.totalWarehouseValuationFormatted}
              </div>
              <button
                type="button"
                onClick={handleExportValuationCsv}
                className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:bg-primary-soft/50 ${UI_INTERACTION.focusButton}`}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-3 px-4">
                    SKU
                  </th>
                  <th scope="col" className="py-3 px-4">
                    ชื่อรายการ
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    สต็อกคงเหลือ
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    ต้นทุนเฉลี่ย MAC
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    มูลค่าคงคลังสุทธิ
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {reports.valuationReport.lines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-ink-muted">
                      ยังไม่มีสินค้าหรือวัตถุดิบคงคลังในระบบ
                    </td>
                  </tr>
                ) : (
                  reports.valuationReport.lines.map((l) => (
                    <tr
                      key={l.variantId}
                      className="hover:bg-surface-1 transition-colors duration-150"
                    >
                      <td className="py-3 px-4 text-ink-muted tabular-nums-google">{l.sku}</td>
                      <td className="py-3 px-4 font-medium text-ink">{l.itemName}</td>
                      <td className="py-3 px-4 text-right text-ink tabular-nums-google">
                        {l.stockFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                        {l.macFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-ink tabular-nums-google">
                        {l.valuationFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: MENU GROSS MARGIN & COGS (OWNER / MANAGER ONLY) */}
      {reportTab === 'MARGIN' && showCostReports && reports && (
        <div className="rounded-[4px] border border-hairline bg-canvas overflow-hidden">
          <div className="p-5 border-b border-hairline bg-surface-1 flex flex-wrap items-center justify-between gap-4">
            <h3 className="font-google-display text-[20px] font-normal text-ink">
              รายงานต้นทุนขายจริง (COGS) และกำไรขั้นต้นรายเมนู (Gross Margin Analysis)
            </h3>
            <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums-google">
              <span className="text-ink-muted">
                รายได้รวม:{' '}
                <strong className="font-medium text-ink">
                  {reports.marginReport.totalRevenueFormatted}
                </strong>
              </span>
              <span className="text-ink-muted">
                ต้นทุนขาย COGS:{' '}
                <strong className="font-medium text-ink">
                  {reports.marginReport.totalCogsFormatted}
                </strong>
              </span>
              <span className="text-ink-muted">
                กำไรขั้นต้น:{' '}
                <strong className="font-medium text-primary-hover">
                  {reports.marginReport.totalGrossProfitFormatted} (
                  {reports.marginReport.totalGrossMarginPercentFormatted})
                </strong>
              </span>
              <button
                type="button"
                onClick={handleExportMarginCsv}
                className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[48px] border border-primary bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:bg-primary-soft/50 ${UI_INTERACTION.focusButton}`}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-1 text-ink-muted font-medium border-b border-hairline">
                <tr>
                  <th scope="col" className="py-3 px-4">
                    รายการที่ขาย
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    จำนวนขาย
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    ยอดขายรวม
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    ต้นทุนวัตถุดิบจริง (COGS)
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    กำไรขั้นต้น
                  </th>
                  <th scope="col" className="py-3 px-4 text-right">
                    % GP Margin
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-canvas">
                {reports.marginReport.lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-ink-muted">
                      ยังไม่มีรายการขายสำเร็จเพื่อคำนวณกำไรขั้นต้น
                    </td>
                  </tr>
                ) : (
                  reports.marginReport.lines.map((l) => (
                    <tr
                      key={l.variantId}
                      className="hover:bg-surface-1 transition-colors duration-150"
                    >
                      <td className="py-3 px-4 font-medium text-ink">{l.itemName}</td>
                      <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                        {l.soldQtyFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-ink tabular-nums-google">
                        {l.revenueFormatted}
                      </td>
                      <td className="py-3 px-4 text-right text-ink-muted tabular-nums-google">
                        {l.cogsFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-ink tabular-nums-google">
                        {l.grossProfitFormatted}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-primary-hover tabular-nums-google">
                        {l.grossMarginPercentFormatted}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* THERMAL 203-DPI Z-REPORT PREVIEW MODAL */}
      <ModalDialog
        open={Boolean(zRasterPreview)}
        onClose={() => setZRasterPreview(null)}
        labelledBy={`${uid}-z-print-title`}
        maxWidthClass="max-w-lg"
      >
        {zRasterPreview && (
          <>
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4 shrink-0">
              <div>
                <h3
                  id={`${uid}-z-print-title`}
                  className="font-google-display text-[18px] font-normal text-ink"
                >
                  ใบสรุปปิดกะความร้อน Z-Report · {zRasterPreview.shiftNumber} ({zPrintPaperMm}mm)
                </h3>
                <p className="text-xs text-ink-muted">
                  {zRasterPreview.hardwareError
                    ? `ส่งพิมพ์เครื่องพิมพ์ล้มเหลว (${zRasterPreview.hardwareError}) · เก็บเข้าคิว Spooler แล้ว`
                    : zRasterPreview.spoolStatus && zRasterPreview.spoolStatus !== 'PRINTED_IMMEDIATELY'
                      ? `เก็บใบ Z-Report เข้าคิว Spooler แล้ว (${zRasterPreview.spoolStatus})`
                      : 'ส่งออกคำสั่งพิมพ์ 203-DPI 1-Bit Raster สำเร็จ'}
                  {zRasterPreview.transportMode ? ` · พอร์ต ${zRasterPreview.transportMode}` : ''}
                </p>
              </div>
              <button
                type="button"
                aria-label="ปิดตัวอย่างใบ Z-Report"
                onClick={() => setZRasterPreview(null)}
                className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-surface-1 hover:text-ink ${UI_INTERACTION.focusButton}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="border-b border-hairline bg-canvas px-5 py-2.5 flex items-center justify-between gap-2 text-xs shrink-0">
              <span className="text-ink-muted">ขนาดกระดาษความร้อน</span>
              <div className="inline-flex rounded-[48px] border border-hairline p-0.5">
                {([80, 58] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setZPrintPaperMm(w);
                      void handlePrintThermalZReport(w);
                    }}
                    className={`rounded-[48px] px-3 py-1 font-medium ${UI_INTERACTION.focusButton} ${
                      zPrintPaperMm === w
                        ? 'bg-ink text-white hover:bg-hero'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {w}mm
                  </button>
                ))}
              </div>
            </div>

            <div className="p-5 bg-surface-1 overflow-y-auto flex-1 flex justify-center">
              <div
                id="rube-printable-receipt"
                className={`thermal-receipt-paper rounded-[4px] p-3 overflow-x-auto ${
                  zPrintPaperMm === 58 ? 'paper-58mm max-w-[260px]' : 'max-w-[380px]'
                } w-full`}
              >
                <img
                  src={zRasterPreview.previewUrl}
                  alt={`203-DPI Z-Report ${zRasterPreview.shiftNumber}`}
                  className="w-full h-auto block"
                />
              </div>
            </div>

            <div className="border-t border-hairline bg-canvas px-5 py-3.5 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={() => window.print()}
                className={`flex h-[42px] items-center gap-1.5 rounded-[48px] border border-hairline bg-canvas px-4 font-google-display text-xs font-medium text-primary hover:border-primary hover:bg-surface-1 ${UI_INTERACTION.focusButton}`}
              >
                <Printer className="h-4 w-4" />
                Windows Print ({zPrintPaperMm}mm)
              </button>
              <button
                type="button"
                onClick={() => setZRasterPreview(null)}
                className={`h-[42px] rounded-[48px] bg-primary px-6 font-google-display text-sm font-medium tracking-[0.5px] text-white hover:bg-primary-hover ${UI_INTERACTION.focusButtonPrimary}`}
              >
                เสร็จสิ้น
              </button>
            </div>
          </>
        )}
      </ModalDialog>

      <ConfirmDialog
        open={confirmCloseOpen}
        title={`ยืนยันปิดกะ ${bootstrap.activeShift?.shiftNumber ?? ''}?`}
        description={
          parsedCountedSatang === 0
            ? pick(
                `คุณระบุยอดเงินสดที่นับได้จริงเป็น ${money(0)}! โปรดตรวจสอบให้แน่ใจก่อนยืนยัน`,
                `ທ່ານລະບຸຍອດເງິນສົດທີ່ນັບໄດ້ເປັນ ${money(0)}! ກະລຸນາກວດສອບກ່ອນຢືນຢັນ`,
                `Counted cash is ${money(0)}! Please double check before closing.`
              )
            : `${pick('ยอดเงินสดในลิ้นชักที่นับได้จริง', 'ຍອດເງິນສົດໃນລິ້ນຊັກທີ່ນັບໄດ້ຈິງ', 'Counted drawer cash')}: ${money(parsedCountedSatang ?? 0)}`
        }
        confirmLabel="ยืนยันปิดกะ & ออกใบ Z-Report"
        tone={parsedCountedSatang === 0 ? 'danger' : 'primary'}
        busy={busy}
        onCancel={() => {
          if (!busy) setConfirmCloseOpen(false);
        }}
        onConfirm={() => {
          void executeBlindDropClose();
        }}
      />
    </div>
  );
};
