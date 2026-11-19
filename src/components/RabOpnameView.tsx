import React, { useMemo, useState } from 'react';
import {
  ClipboardCheck,
  Search,
  Printer,
  FileSpreadsheet,
  RefreshCw,
  ArrowRight,
  Copy,
  CheckCircle2,
  AlertTriangle,
  Building2,
  TrendingUp,
  Edit3,
} from 'lucide-react';
import { WorkCategory, WorkItem, VesselSpec, ProjectSchedule } from '../types';
import { TonnageCalculator } from '../utils/tonnageCalculator';
import {
  calculateOpnameItemCost,
  calculateRepairItemCost,
  computeFinancialTotals,
  getEffectiveOpnameQty,
  getEffectiveOpnameWeightKg,
  getEffectiveRepairQty,
  getItemPriceBasis,
} from '../utils/rabHelpers';
import { exportRabOpnameExcel, exportRabOpnamePdf } from '../utils/rabExport';

interface RabOpnameViewProps {
  categories: WorkCategory[];
  opnameItems: WorkItem[];
  repairItems: WorkItem[];
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  overheadPercent: number;
  ppnPercent: number;
  onUpdateOpnameItem?: (item: WorkItem) => void;
  onBatchUpdateOpnameItems?: (items: WorkItem[]) => void;
  onSyncFromRepairList?: (mode: 'replace' | 'merge_new') => void;
  onNavigateToOpname?: () => void;
  onNotify?: (msg: string) => void;
}

export const RabOpnameView: React.FC<RabOpnameViewProps> = ({
  categories,
  opnameItems,
  repairItems,
  vessel,
  schedule,
  overheadPercent,
  ppnPercent,
  onUpdateOpnameItem,
  onBatchUpdateOpnameItems,
  onSyncFromRepairList,
  onNavigateToOpname,
  onNotify,
}) => {
  const [viewMode, setViewMode] = useState<'detailed' | 'summary'>('detailed');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedVendor, setSelectedVendor] = useState<string>('all');
  const [verifiedOnlyCost, setVerifiedOnlyCost] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState(false);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder),
    [categories]
  );

  // Map repair items by ID and category+itemNo for variance comparison and price copying
  const repairLookup = useMemo(() => {
    const byId = new Map<string, WorkItem>();
    const byKey = new Map<string, WorkItem>();
    repairItems.forEach((r) => {
      byId.set(r.id, r);
      if (r.itemNo) byKey.set(`${r.categoryId}::${r.itemNo}`, r);
    });
    return { byId, byKey };
  }, [repairItems]);

  const getMatchedRepair = (item: WorkItem): WorkItem | undefined => {
    return repairLookup.byId.get(item.id) || repairLookup.byKey.get(`${item.categoryId}::${item.itemNo}`);
  };

  // Extract distinct vendors
  const vendors = useMemo(() => {
    const set = new Set<string>();
    opnameItems.forEach((item) => {
      const v = (item.subcontractor || item.assignedTo || '').trim();
      if (v) set.add(v);
    });
    return Array.from(set).sort();
  }, [opnameItems]);

  // Metrics & KPI computations
  const metrics = useMemo(() => {
    let activeBaseCost = 0;
    let verifiedBaseCost = 0;
    let repairBaselineCost = 0;
    let totalOpnameWeight = 0;
    let verifiedCount = 0;
    let zeroPricedCount = 0;

    opnameItems.forEach((item) => {
      const opCost = calculateOpnameItemCost(item, { excludeRejected: true });
      const isVerified = item.opnameStatus === 'Terverifikasi' || (item.opnamePercent || 0) >= 100;
      activeBaseCost += opCost;
      if (isVerified) {
        verifiedBaseCost += opCost;
        verifiedCount++;
      }
      totalOpnameWeight += getEffectiveOpnameWeightKg(item);
      if ((item.unitPrice || 0) <= 0 && (item.itemLevel === 3 || (!item.isAreaHeader && getEffectiveOpnameQty(item) > 0))) {
        zeroPricedCount++;
      }
    });

    repairItems.forEach((r) => {
      repairBaselineCost += calculateRepairItemCost(r);
    });

    const effectiveBase = verifiedOnlyCost ? verifiedBaseCost : activeBaseCost;
    const financials = computeFinancialTotals(effectiveBase, overheadPercent, ppnPercent);
    const verifiedFinancials = computeFinancialTotals(verifiedBaseCost, overheadPercent, ppnPercent);
    const varianceBase = effectiveBase - repairBaselineCost;
    const realizationPct = repairBaselineCost > 0 ? (effectiveBase / repairBaselineCost) * 100 : 0;

    return {
      activeBaseCost,
      verifiedBaseCost,
      repairBaselineCost,
      totalOpnameWeight,
      verifiedCount,
      zeroPricedCount,
      financials,
      verifiedFinancials,
      varianceBase,
      realizationPct,
    };
  }, [opnameItems, repairItems, overheadPercent, ppnPercent, verifiedOnlyCost]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return opnameItems.filter((item) => {
      if (selectedCategory !== 'all' && item.categoryId !== selectedCategory) return false;
      if (selectedStatus !== 'all') {
        const status = item.opnameStatus || 'Belum Diperiksa';
        if (status !== selectedStatus) return false;
      }
      if (selectedVendor !== 'all') {
        const vendor = (item.subcontractor || item.assignedTo || '').trim();
        if (selectedVendor === '__unassigned__') {
          if (vendor !== '') return false;
        } else if (vendor !== selectedVendor) {
          return false;
        }
      }
      if (verifiedOnlyCost) {
        const isVerified = item.opnameStatus === 'Terverifikasi' || (item.opnamePercent || 0) >= 100;
        if (!isVerified) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const match =
          item.itemNo?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) ||
          (item.subcontractor || '').toLowerCase().includes(q) ||
          (item.assignedTo || '').toLowerCase().includes(q) ||
          (item.opnameBapoNo || '').toLowerCase().includes(q) ||
          (item.notes || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [opnameItems, selectedCategory, selectedStatus, selectedVendor, verifiedOnlyCost, searchQuery]);

  // Category & Vendor Summaries
  const categoryBreakdown = useMemo(() => {
    return sortedCategories.map((cat) => {
      const catOpItems = opnameItems.filter((i) => i.categoryId === cat.id);
      const catRepItems = repairItems.filter((i) => i.categoryId === cat.id);

      const opCost = catOpItems.reduce((sum, i) => {
        if (verifiedOnlyCost && i.opnameStatus !== 'Terverifikasi' && (i.opnamePercent || 0) < 100) return sum;
        return sum + calculateOpnameItemCost(i, { excludeRejected: true });
      }, 0);
      const repCost = catRepItems.reduce((sum, i) => sum + calculateRepairItemCost(i), 0);
      const tonnage = catOpItems.reduce((sum, i) => sum + getEffectiveOpnameWeightKg(i), 0);
      const verified = catOpItems.filter((i) => i.opnameStatus === 'Terverifikasi' || (i.opnamePercent || 0) >= 100).length;

      return {
        category: cat,
        itemsCount: catOpItems.length,
        verifiedCount: verified,
        tonnage,
        opnameCost: opCost,
        repairCost: repCost,
        variance: opCost - repCost,
      };
    });
  }, [sortedCategories, opnameItems, repairItems, verifiedOnlyCost]);

  const vendorBreakdown = useMemo(() => {
    const map = new Map<string, { vendor: string; count: number; verifiedCount: number; baseCost: number; tonnage: number }>();
    opnameItems.forEach((item) => {
      if (verifiedOnlyCost && item.opnameStatus !== 'Terverifikasi' && (item.opnamePercent || 0) < 100) return;
      const vendor = (item.subcontractor || item.assignedTo || '').trim() || 'Belum Ditentukan / In-House';
      const current = map.get(vendor) || { vendor, count: 0, verifiedCount: 0, baseCost: 0, tonnage: 0 };
      current.count += 1;
      if (item.opnameStatus === 'Terverifikasi' || (item.opnamePercent || 0) >= 100) {
        current.verifiedCount += 1;
      }
      current.baseCost += calculateOpnameItemCost(item, { excludeRejected: true });
      current.tonnage += getEffectiveOpnameWeightKg(item);
      map.set(vendor, current);
    });
    return Array.from(map.values()).sort((a, b) => b.baseCost - a.baseCost);
  }, [opnameItems, verifiedOnlyCost]);

  // Handlers
  const handleUnitPriceChange = (item: WorkItem, newPrice: number) => {
    if (!onUpdateOpnameItem) return;
    const nextTotal = calculateOpnameItemCost(item, { excludeRejected: true, overrideUnitPrice: newPrice });
    onUpdateOpnameItem({
      ...item,
      unitPrice: newPrice,
      totalPrice: nextTotal,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleBasisChange = (item: WorkItem, newBasis: 'qty' | 'weight') => {
    if (!onUpdateOpnameItem) return;
    const nextTotal = calculateOpnameItemCost(item, { excludeRejected: true, overrideBasis: newBasis });
    onUpdateOpnameItem({
      ...item,
      priceBasis: newBasis,
      totalPrice: nextTotal,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleOpnameQtyChange = (item: WorkItem, rawVal: string) => {
    if (!onUpdateOpnameItem) return;
    const parsedQty = Math.max(0, parseFloat(rawVal) || 0);
    const planQty = getEffectiveRepairQty(item);
    const pct = planQty > 0 ? Math.round((parsedQty / planQty) * 100) : (parsedQty > 0 ? 100 : 0);
    const nextStatus: WorkItem['opnameStatus'] =
      item.opnameStatus === 'Ditolak'
        ? 'Ditolak'
        : pct >= 100
        ? 'Terverifikasi'
        : pct > 0
        ? 'Dalam Pemeriksaan'
        : 'Belum Diperiksa';

    const tempItem: WorkItem = {
      ...item,
      opnameQty: parsedQty,
      opnamePercent: pct,
      opnameStatus: nextStatus,
    };
    const nextTotal = calculateOpnameItemCost(tempItem, { excludeRejected: true });
    onUpdateOpnameItem({
      ...tempItem,
      totalPrice: nextTotal,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleCopyRatesFromRepairList = () => {
    if (!onBatchUpdateOpnameItems || opnameItems.length === 0) return;
    let updatedCount = 0;
    const updatedList = opnameItems.map((opItem) => {
      const matched = getMatchedRepair(opItem);
      if (!matched) return opItem;
      const targetPrice = matched.unitPrice || 0;
      const targetBasis = matched.priceBasis;
      if (targetPrice > 0 && ((opItem.unitPrice || 0) === 0 || opItem.unitPrice !== targetPrice || opItem.priceBasis !== targetBasis)) {
        updatedCount++;
        const updatedItem: WorkItem = {
          ...opItem,
          unitPrice: targetPrice,
          priceBasis: targetBasis,
          updatedAt: new Date().toISOString(),
        };
        updatedItem.totalPrice = calculateOpnameItemCost(updatedItem, { excludeRejected: true });
        return updatedItem;
      }
      return opItem;
    });

    if (updatedCount > 0) {
      onBatchUpdateOpnameItems(updatedList);
      onNotify?.(`Tarif satuan dari Repair List disalin ke ${updatedCount} item Opname.`);
    } else {
      onNotify?.('Semua tarif item Opname sudah sesuai dengan Repair List.');
    }
  };

  const handleExportExcel = async () => {
    try {
      setIsExporting(true);
      await exportRabOpnameExcel({
        vessel,
        schedule,
        categories,
        opnameItems: verifiedOnlyCost
          ? opnameItems.filter((i) => i.opnameStatus === 'Terverifikasi' || (i.opnamePercent || 0) >= 100)
          : opnameItems,
        repairItems,
        overheadPercent,
        ppnPercent,
      });
      onNotify?.('File Excel RAB Opname berhasil diunduh.');
    } catch (err) {
      console.error(err);
      onNotify?.('Gagal mengekspor Excel RAB Opname.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportPdf = async () => {
    try {
      setIsExporting(true);
      await exportRabOpnamePdf({
        vessel,
        schedule,
        categories,
        opnameItems: verifiedOnlyCost
          ? opnameItems.filter((i) => i.opnameStatus === 'Terverifikasi' || (i.opnamePercent || 0) >= 100)
          : opnameItems,
        repairItems,
        overheadPercent,
        ppnPercent,
      });
      onNotify?.('File PDF RAB Opname berhasil diunduh.');
    } catch (err) {
      console.error(err);
      onNotify?.('Gagal mengekspor PDF RAB Opname.');
    } finally {
      setIsExporting(false);
    }
  };

  if (opnameItems.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center mx-auto">
          <ClipboardCheck className="w-6 h-6" />
        </div>
        <div className="max-w-md mx-auto space-y-1.5">
          <h3 className="text-sm font-bold text-slate-900">Data Opname &amp; Subcont Belum Tersedia</h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            Tabel Opname saat ini masih kosong. Tarik data awal dari Repair List atau buka tab Opname &amp; Subcont untuk memulai verifikasi volume lapangan dan perhitungan biaya Opname.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          {onSyncFromRepairList && (
            <button
              type="button"
              onClick={() => onSyncFromRepairList('replace')}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Tarik Data dari Repair List</span>
            </button>
          )}
          {onNavigateToOpname && (
            <button
              type="button"
              onClick={onNavigateToOpname}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Buka Tab Opname &amp; Subcont</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action Header */}
      <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-50 text-sky-700 border border-sky-200/80 rounded-lg shrink-0">
            <ClipboardCheck className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 leading-tight">
              Rincian Biaya Opname &amp; Subcont (Realisasi Lapangan)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Perhitungan biaya berdasarkan volume opname aktual ({opnameItems.length} item · {metrics.verifiedCount} terverifikasi) dibandingkan anggaran Repair List
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setViewMode('detailed')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5 ${
                viewMode === 'detailed' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Rincian Item Opname</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('summary')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5 ${
                viewMode === 'summary' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Rekap Kategori &amp; Vendor</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopyRatesFromRepairList}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="Salin tarif satuan dan basis harga dari Repair List ke Opname"
          >
            <Copy className="w-3.5 h-3.5 text-slate-500" />
            <span>Salin Tarif Repair List</span>
          </button>

          <button
            type="button"
            onClick={handleExportExcel}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 text-emerald-700 border border-emerald-300 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Export Excel</span>
          </button>

          <button
            type="button"
            onClick={handleExportPdf}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Cetak PDF</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">DPP Biaya Opname ({verifiedOnlyCost ? 'Terverifikasi' : 'Aktif'})</div>
          <div className="text-base font-bold text-slate-900 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.financials.baseCost)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
            Tonase: {TonnageCalculator.formatWeight(metrics.totalOpnameWeight)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">Nilai Terverifikasi 100% (Approved)</div>
          <div className="text-base font-bold text-emerald-700 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.verifiedBaseCost)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {metrics.verifiedCount} dari {opnameItems.length} item disetujui
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">Selisih Biaya vs Repair List</div>
          <div
            className={`text-base font-bold font-mono tabular-nums mt-1 ${
              metrics.varianceBase > 0 ? 'text-rose-700' : metrics.varianceBase < 0 ? 'text-emerald-700' : 'text-slate-700'
            }`}
          >
            {metrics.varianceBase > 0 ? '+' : ''}
            {TonnageCalculator.formatRupiah(metrics.varianceBase)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
            Realisasi: {metrics.realizationPct.toFixed(1)}% dari plan
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-900 rounded-xl p-3.5 text-white">
          <div className="text-[11px] font-medium text-slate-300">Grand Total RAB Opname</div>
          <div className="text-base font-bold text-amber-300 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.financials.grandTotalCost)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums">
            Inc. OH {overheadPercent}% &amp; PPN {ppnPercent}%
          </div>
        </div>
      </div>

      {/* Scope Alert if unpriced items exist */}
      {metrics.zeroPricedCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Terdapat <strong className="font-mono tabular-nums">{metrics.zeroPricedCount}</strong> item Opname dengan tarif satuan Rp 0. Anda dapat menyalin tarif dari Repair List atau mengisi tarif langsung di tabel.
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopyRatesFromRepairList}
            className="text-xs font-bold text-amber-900 underline hover:text-amber-700 whitespace-nowrap shrink-0 cursor-pointer text-left sm:text-right"
          >
            Salin Tarif Sekarang &rarr;
          </button>
        </div>
      )}

      {/* VIEW MODE 1: DETAILED OPNAME COSTING TABLE */}
      {viewMode === 'detailed' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {/* Toolbar Filters */}
          <div className="p-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Cari no, uraian, vendor, BAPO..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-56 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-slate-700 focus:outline-hidden"
              >
                <option value="all">Semua Kategori ({sortedCategories.length})</option>
                {sortedCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}. {c.name}
                  </option>
                ))}
              </select>

              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-slate-700 focus:outline-hidden"
              >
                <option value="all">Semua Status Opname</option>
                <option value="Terverifikasi">Terverifikasi</option>
                <option value="Dalam Pemeriksaan">Dalam Pemeriksaan</option>
                <option value="Belum Diperiksa">Belum Diperiksa</option>
                <option value="Revisi / Temuan">Revisi / Temuan</option>
                <option value="Ditolak">Ditolak</option>
              </select>

              <select
                value={selectedVendor}
                onChange={(e) => setSelectedVendor(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-slate-700 focus:outline-hidden"
              >
                <option value="all">Semua Vendor / Subcont</option>
                {vendors.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                <option value="__unassigned__">Belum Ditentukan Vendor</option>
              </select>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={verifiedOnlyCost}
                onChange={(e) => setVerifiedOnlyCost(e.target.checked)}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
              />
              <span>Hitung khusus item Terverifikasi</span>
            </label>
          </div>

          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-left text-xs border-collapse min-w-[1180px]">
              <thead>
                <tr className="bg-slate-900 text-white text-[10px] uppercase tracking-wider font-semibold">
                  <th className="py-2.5 px-2.5 w-16 text-center border-r border-slate-800 whitespace-nowrap">No</th>
                  <th className="py-2.5 px-3 min-w-[260px] border-r border-slate-800">Uraian Pekerjaan &amp; Vendor</th>
                  <th className="py-2.5 px-2.5 w-28 text-center border-r border-slate-800 whitespace-nowrap">Status</th>
                  <th className="py-2.5 px-2.5 w-24 text-right border-r border-slate-800 whitespace-nowrap">Vol. Kontrak</th>
                  <th className="py-2.5 px-2.5 w-28 text-right border-r border-slate-800 whitespace-nowrap bg-sky-950">Vol. Opname</th>
                  <th className="py-2.5 px-2 w-16 text-center border-r border-slate-800 whitespace-nowrap">Sat</th>
                  <th className="py-2.5 px-2.5 w-24 text-right border-r border-slate-800 whitespace-nowrap">Tonase</th>
                  <th className="py-2.5 px-3 w-40 text-right border-r border-slate-800 whitespace-nowrap">Tarif Satuan (Rp)</th>
                  <th className="py-2.5 px-3 w-36 text-right border-r border-slate-800 whitespace-nowrap bg-emerald-950 text-emerald-200">
                    Biaya Opname (Rp)
                  </th>
                  <th className="py-2.5 px-3 w-32 text-right whitespace-nowrap">Selisih vs Plan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedCategories.map((cat) => {
                  const catItems = filteredItems.filter((i) => i.categoryId === cat.id);
                  if (catItems.length === 0) return null;

                  const catOpTotal = catItems.reduce(
                    (sum, i) => sum + calculateOpnameItemCost(i, { excludeRejected: true }),
                    0
                  );
                  const catRepTotal = catItems.reduce((sum, i) => {
                    const matched = getMatchedRepair(i);
                    return sum + (matched ? calculateRepairItemCost(matched) : calculateRepairItemCost(i));
                  }, 0);

                  return (
                    <React.Fragment key={cat.id}>
                      <tr className="bg-emerald-900 text-white font-bold text-xs">
                        <td colSpan={8} className="py-2 px-3">
                          {cat.code}. {cat.name.toUpperCase()} ({catItems.length} item)
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-300 whitespace-nowrap">
                          {TonnageCalculator.formatRupiah(catOpTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-emerald-200 whitespace-nowrap">
                          {catOpTotal - catRepTotal > 0 ? '+' : ''}
                          {TonnageCalculator.formatRupiah(catOpTotal - catRepTotal)}
                        </td>
                      </tr>

                      {catItems.map((item) => {
                        const matchedRepair = getMatchedRepair(item);
                        const planQty = getEffectiveRepairQty(item);
                        const opQty = getEffectiveOpnameQty(item);
                        const opWeight = getEffectiveOpnameWeightKg(item);
                        const opCost = calculateOpnameItemCost(item, { excludeRejected: true });
                        const repCost = matchedRepair
                          ? calculateRepairItemCost(matchedRepair)
                          : calculateRepairItemCost(item);
                        const diff = opCost - repCost;
                        const basis = getItemPriceBasis(item);
                        const vendor = (item.subcontractor || item.assignedTo || '').trim();
                        const status = item.opnameStatus || 'Belum Diperiksa';
                        const isRejected = status === 'Ditolak';
                        const isArea = item.itemLevel === 1 || item.isAreaHeader;

                        return (
                          <tr
                            key={item.id}
                            className={`transition-colors hover:bg-slate-50 ${isArea ? 'bg-slate-50/70 font-semibold' : 'bg-white'}`}
                          >
                            <td className="py-2 px-2.5 text-center font-mono text-[11px] text-slate-600 border-r border-slate-100 whitespace-nowrap">
                              {item.itemNo}
                            </td>
                            <td className="py-2 px-3 border-r border-slate-100">
                              <div className="text-xs text-slate-900 leading-snug">{item.description}</div>
                              {(vendor || item.opnameBapoNo) && (
                                <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-2">
                                  {vendor && <span>{vendor}</span>}
                                  {vendor && item.opnameBapoNo && <span>&middot;</span>}
                                  {item.opnameBapoNo && <span className="font-mono">BAPO: {item.opnameBapoNo}</span>}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-center border-r border-slate-100 whitespace-nowrap">
                              <span
                                className={`text-[11px] font-semibold ${
                                  status === 'Terverifikasi'
                                    ? 'text-emerald-700'
                                    : status === 'Dalam Pemeriksaan'
                                    ? 'text-sky-700'
                                    : status === 'Revisi / Temuan'
                                    ? 'text-amber-700'
                                    : status === 'Ditolak'
                                    ? 'text-rose-700'
                                    : 'text-slate-500'
                                }`}
                              >
                                {status}
                              </span>
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-600 border-r border-slate-100 whitespace-nowrap">
                              {planQty > 0 ? planQty.toLocaleString('id-ID', { maximumFractionDigits: 2 }) : '-'}
                            </td>
                            <td className="py-1.5 px-2 border-r border-slate-100 bg-sky-50/30 whitespace-nowrap">
                              <input
                                type="number"
                                step="any"
                                min="0"
                                value={opQty}
                                onChange={(e) => handleOpnameQtyChange(item, e.target.value)}
                                className="w-full text-right font-mono tabular-nums text-xs px-2 py-1 bg-white border border-slate-300 rounded focus:outline-hidden focus:border-sky-600 font-semibold text-slate-900"
                              />
                            </td>
                            <td className="py-2 px-2 text-center font-mono text-slate-600 border-r border-slate-100 whitespace-nowrap">
                              {item.unit || '-'}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-700 border-r border-slate-100 whitespace-nowrap">
                              {opWeight > 0 ? `${opWeight.toLocaleString('id-ID', { maximumFractionDigits: 2 })} kg` : '-'}
                            </td>
                            <td className="py-1.5 px-2 border-r border-slate-100 whitespace-nowrap">
                              <div className="flex flex-col items-end gap-1">
                                <input
                                  type="number"
                                  step="500"
                                  min="0"
                                  value={item.unitPrice || ''}
                                  placeholder="0"
                                  onChange={(e) => handleUnitPriceChange(item, parseFloat(e.target.value) || 0)}
                                  className="w-full text-right font-mono tabular-nums text-xs px-2 py-1 bg-white border border-slate-300 rounded focus:outline-hidden focus:border-emerald-600 font-semibold"
                                />
                                <div className="inline-flex items-center gap-0.5 bg-slate-100 p-0.5 rounded border border-slate-200 text-[10px]">
                                  <button
                                    type="button"
                                    onClick={() => handleBasisChange(item, 'qty')}
                                    className={`px-1.5 py-0.5 rounded font-semibold cursor-pointer ${
                                      basis === 'qty' ? 'bg-slate-800 text-white' : 'text-slate-600 hover:text-slate-900'
                                    }`}
                                  >
                                    /{item.unit || 'Qty'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleBasisChange(item, 'weight')}
                                    className={`px-1.5 py-0.5 rounded font-semibold cursor-pointer ${
                                      basis === 'weight' ? 'bg-amber-600 text-white' : 'text-slate-600 hover:text-slate-900'
                                    }`}
                                  >
                                    /Kg
                                  </button>
                                </div>
                              </div>
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-mono tabular-nums font-bold border-r border-slate-100 whitespace-nowrap ${
                                isRejected ? 'text-slate-400 line-through' : 'text-emerald-800'
                              }`}
                            >
                              {TonnageCalculator.formatRupiah(opCost)}
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
                                diff > 0 ? 'text-rose-700 font-semibold' : diff < 0 ? 'text-emerald-700 font-semibold' : 'text-slate-500'
                              }`}
                            >
                              {diff > 0 ? '+' : ''}
                              {TonnageCalculator.formatRupiah(diff)}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-10 text-center text-xs text-slate-500">
                      Tidak ada item Opname yang sesuai dengan filter pencarian saat ini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW MODE 2: REKAPITULASI KATEGORI & VENDOR */}
      {viewMode === 'summary' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-bold text-xs text-slate-800">
              Rekapitulasi RAB Opname vs Repair List per Kategori
            </div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 text-[10px] uppercase border-b border-slate-200">
                    <th className="py-2.5 px-3">Kategori</th>
                    <th className="py-2.5 px-2 text-center whitespace-nowrap">Verified</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Repair List</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Biaya Opname</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Selisih</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {categoryBreakdown.map((row) => (
                    <tr key={row.category.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-medium text-slate-900">
                        <span className="font-bold text-emerald-700 mr-1.5">{row.category.code}.</span>
                        {row.category.name}
                      </td>
                      <td className="py-2 px-2 text-center font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {row.verifiedCount}/{row.itemsCount}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {TonnageCalculator.formatRupiah(row.repairCost)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {TonnageCalculator.formatRupiah(row.opnameCost)}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
                          row.variance > 0 ? 'text-rose-700' : row.variance < 0 ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {row.variance > 0 ? '+' : ''}
                        {TonnageCalculator.formatRupiah(row.variance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-bold text-xs text-slate-800 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-600" />
              <span>Rekap Tagihan Biaya per Subcontractor / Vendor</span>
            </div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 text-[10px] uppercase border-b border-slate-200">
                    <th className="py-2.5 px-3">Vendor / Pelaksana</th>
                    <th className="py-2.5 px-2 text-center whitespace-nowrap">Item</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Tonase</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">DPP Biaya</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Inc. OH &amp; PPN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vendorBreakdown.map((v) => {
                    const vf = computeFinancialTotals(v.baseCost, overheadPercent, ppnPercent);
                    return (
                      <tr key={v.vendor} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-medium text-slate-900">
                          <div>{v.vendor}</div>
                          <div className="text-[10px] text-slate-500">
                            {v.verifiedCount} dari {v.count} item terverifikasi
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-center font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {v.count}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {v.tonnage > 0 ? `${v.tonnage.toFixed(1)} kg` : '-'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                          {TonnageCalculator.formatRupiah(v.baseCost)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold text-emerald-800 whitespace-nowrap">
                          {TonnageCalculator.formatRupiah(vf.grandTotalCost)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Financial Footer Breakdown */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <span className="text-slate-500 block text-[11px]">1. DPP Biaya Opname:</span>
          <span className="font-mono tabular-nums font-bold text-slate-900 text-sm">
            {TonnageCalculator.formatRupiah(metrics.financials.baseCost)}
          </span>
        </div>
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <span className="text-slate-500 block text-[11px]">2. Overhead ({overheadPercent}%):</span>
          <span className="font-mono tabular-nums font-bold text-slate-900 text-sm">
            {TonnageCalculator.formatRupiah(metrics.financials.overheadCost)}
          </span>
        </div>
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <span className="text-slate-500 block text-[11px]">3. PPN ({ppnPercent}%):</span>
          <span className="font-mono tabular-nums font-bold text-slate-900 text-sm">
            {TonnageCalculator.formatRupiah(metrics.financials.ppnTaxCost)}
          </span>
        </div>
        <div className="p-3 rounded-lg bg-slate-900 text-white border border-slate-900 flex flex-col justify-between">
          <span className="text-slate-300 font-semibold text-[10px] uppercase tracking-wider">4. Grand Total RAB Opname:</span>
          <span className="font-mono tabular-nums font-black text-amber-300 text-base">
            {TonnageCalculator.formatRupiah(metrics.financials.grandTotalCost)}
          </span>
        </div>
      </div>
    </div>
  );
};
