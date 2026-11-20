import React, { useEffect, useMemo, useState } from 'react';
import {
  FileCheck2,
  Search,
  Printer,
  FileSpreadsheet,
  ArrowRight,
  TrendingUp,
  Edit3,
  CheckCircle2,
} from 'lucide-react';
import { WorkCategory, WorkItem, VesselSpec, ProjectSchedule } from '../types';
import { TonnageCalculator } from '../utils/tonnageCalculator';
import {
  calculateSatisfactionItemCost,
  computeFinancialTotals,
  deriveSatisfactionStatus,
  getEffectiveOpnameQty,
  getEffectiveOpnameWeightKg,
  getEffectiveRepairQty,
  getItemPriceBasis,
  SatisfactionRabStatus,
} from '../utils/rabHelpers';
import { exportRabSatisfactionExcel, exportRabSatisfactionPdf } from '../utils/rabExport';
import { notifyCloudDirty } from '../services/projectExtrasSync';

interface RabSatisfactionViewProps {
  categories: WorkCategory[];
  opnameItems: WorkItem[];
  repairItems: WorkItem[];
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  overheadPercent: number;
  ppnPercent: number;
  onUpdateOpnameItem?: (item: WorkItem) => void;
  onUpdateWorkItem?: (item: WorkItem) => void;
  onNavigateToSatisfactionNote?: () => void;
  onNotify?: (msg: string) => void;
}

export const RabSatisfactionView: React.FC<RabSatisfactionViewProps> = ({
  categories,
  opnameItems,
  repairItems,
  vessel,
  schedule,
  overheadPercent,
  ppnPercent,
  onUpdateOpnameItem,
  onUpdateWorkItem,
  onNavigateToSatisfactionNote,
  onNotify,
}) => {
  const hasOpnameSource = opnameItems.length > 0;
  const effectiveItems = hasOpnameSource ? opnameItems : repairItems;
  const projectKey = vessel?.id || vessel?.projectNo || 'default';
  const notesStorageKey = `satisfaction_notes_${projectKey}`;
  const statusStorageKey = `satisfaction_rab_status_${projectKey}`;

  const [notesMap, setNotesMap] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(notesStorageKey);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [statusMap, setStatusMap] = useState<Record<string, SatisfactionRabStatus>>(() => {
    try {
      const saved = localStorage.getItem(statusStorageKey);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [viewMode, setViewMode] = useState<'detailed' | 'summary'>('detailed');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'accepted' | 'noted' | 'conditional'>('all');
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    const reload = () => {
      try {
        const savedNotes = localStorage.getItem(notesStorageKey);
        setNotesMap(savedNotes ? JSON.parse(savedNotes) : {});
      } catch {
        setNotesMap({});
      }
      try {
        const savedStatus = localStorage.getItem(statusStorageKey);
        setStatusMap(savedStatus ? JSON.parse(savedStatus) : {});
      } catch {
        setStatusMap({});
      }
    };
    reload();
    window.addEventListener('shipyard-cloud-hydrated', reload);
    return () => window.removeEventListener('shipyard-cloud-hydrated', reload);
  }, [notesStorageKey, statusStorageKey]);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder),
    [categories]
  );

  const handleNoteChange = (itemId: string, text: string) => {
    setNotesMap((prev) => {
      const next = { ...prev, [itemId]: text };
      try {
        localStorage.setItem(notesStorageKey, JSON.stringify(next));
        notifyCloudDirty(schedule?.id);
      } catch (e) {
        console.warn(e);
      }
      return next;
    });
  };

  const handleStatusChange = (itemId: string, status: SatisfactionRabStatus) => {
    setStatusMap((prev) => {
      const next = { ...prev, [itemId]: status };
      try {
        localStorage.setItem(statusStorageKey, JSON.stringify(next));
        notifyCloudDirty(schedule?.id);
      } catch (e) {
        console.warn(e);
      }
      return next;
    });
  };

  const handleUnitPriceChange = (item: WorkItem, newPrice: number) => {
    const basis = getItemPriceBasis(item);
    const qty = hasOpnameSource ? getEffectiveOpnameQty(item) : getEffectiveRepairQty(item);
    const weight = hasOpnameSource ? getEffectiveOpnameWeightKg(item) : (item.weightKg || 0);
    const factor = basis === 'weight' ? (weight > 0 ? weight : qty) : qty;
    const updatedItem: WorkItem = {
      ...item,
      unitPrice: newPrice,
      totalPrice: Math.round(factor * newPrice),
      updatedAt: new Date().toISOString(),
    };

    if (hasOpnameSource && onUpdateOpnameItem) {
      onUpdateOpnameItem(updatedItem);
    } else if (!hasOpnameSource && onUpdateWorkItem) {
      onUpdateWorkItem(updatedItem);
    }
  };

  const handleBasisChange = (item: WorkItem, newBasis: 'qty' | 'weight') => {
    const qty = hasOpnameSource ? getEffectiveOpnameQty(item) : getEffectiveRepairQty(item);
    const weight = hasOpnameSource ? getEffectiveOpnameWeightKg(item) : (item.weightKg || 0);
    const factor = newBasis === 'weight' ? (weight > 0 ? weight : qty) : qty;
    const updatedItem: WorkItem = {
      ...item,
      priceBasis: newBasis,
      totalPrice: Math.round(factor * (item.unitPrice || 0)),
      updatedAt: new Date().toISOString(),
    };

    if (hasOpnameSource && onUpdateOpnameItem) {
      onUpdateOpnameItem(updatedItem);
    } else if (!hasOpnameSource && onUpdateWorkItem) {
      onUpdateWorkItem(updatedItem);
    }
  };

  const metrics = useMemo(() => {
    let acceptedCost = 0;
    let conditionalCost = 0;
    let pendingCost = 0;
    let acceptedCount = 0;
    let notedCount = 0;

    effectiveItems.forEach((item) => {
      const cost = calculateSatisfactionItemCost(item, hasOpnameSource);
      const st = deriveSatisfactionStatus(item, notesMap, statusMap);
      if (notesMap[item.id] && notesMap[item.id].trim().length > 0) {
        notedCount++;
      }
      if (st === 'Accepted') {
        acceptedCost += cost;
        acceptedCount++;
      } else if (st === 'Conditional') {
        conditionalCost += cost;
      } else {
        pendingCost += cost;
      }
    });

    const activeBase =
      scopeFilter === 'accepted'
        ? acceptedCost
        : scopeFilter === 'conditional'
        ? conditionalCost
        : scopeFilter === 'noted'
        ? effectiveItems.reduce((sum, i) => (notesMap[i.id]?.trim() ? sum + calculateSatisfactionItemCost(i, hasOpnameSource) : sum), 0)
        : acceptedCost + conditionalCost + pendingCost;

    const financials = computeFinancialTotals(activeBase, overheadPercent, ppnPercent);
    const acceptedFinancials = computeFinancialTotals(acceptedCost, overheadPercent, ppnPercent);

    return {
      acceptedCost,
      conditionalCost,
      pendingCost,
      acceptedCount,
      notedCount,
      financials,
      acceptedFinancials,
    };
  }, [effectiveItems, hasOpnameSource, notesMap, statusMap, scopeFilter, overheadPercent, ppnPercent]);

  const filteredItems = useMemo(() => {
    return effectiveItems.filter((item) => {
      if (selectedCategory !== 'all' && item.categoryId !== selectedCategory) return false;

      const st = deriveSatisfactionStatus(item, notesMap, statusMap);
      if (scopeFilter === 'accepted' && st !== 'Accepted') return false;
      if (scopeFilter === 'conditional' && st !== 'Conditional') return false;
      if (scopeFilter === 'noted' && !(notesMap[item.id] && notesMap[item.id].trim())) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const noteText = (notesMap[item.id] || '').toLowerCase();
        const match =
          item.itemNo?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) ||
          noteText.includes(q) ||
          (item.remark || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [effectiveItems, selectedCategory, scopeFilter, searchQuery, notesMap, statusMap]);

  const categoryBreakdown = useMemo(() => {
    return sortedCategories.map((cat) => {
      const catItems = filteredItems.filter((i) => i.categoryId === cat.id);
      const totalCost = catItems.reduce((sum, i) => sum + calculateSatisfactionItemCost(i, hasOpnameSource), 0);
      const acceptedItems = catItems.filter((i) => deriveSatisfactionStatus(i, notesMap, statusMap) === 'Accepted').length;
      const tonnage = catItems.reduce(
        (sum, i) => sum + (hasOpnameSource ? getEffectiveOpnameWeightKg(i) : (i.weightKg || 0)),
        0
      );

      return {
        category: cat,
        itemsCount: catItems.length,
        acceptedCount: acceptedItems,
        tonnage,
        totalCost,
      };
    });
  }, [sortedCategories, filteredItems, hasOpnameSource, notesMap, statusMap]);

  const handleExportExcel = async () => {
    try {
      setIsExporting(true);
      await exportRabSatisfactionExcel({
        vessel,
        schedule,
        categories,
        items: filteredItems,
        hasOpnameSource,
        notesMap,
        statusMap,
        overheadPercent,
        ppnPercent,
      });
      onNotify?.('File Excel RAB Satisfaction Note berhasil diunduh.');
    } catch (err) {
      console.error(err);
      onNotify?.('Gagal mengekspor Excel RAB Satisfaction Note.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportPdf = async () => {
    try {
      setIsExporting(true);
      await exportRabSatisfactionPdf({
        vessel,
        schedule,
        categories,
        items: filteredItems,
        hasOpnameSource,
        notesMap,
        statusMap,
        overheadPercent,
        ppnPercent,
      });
      onNotify?.('File PDF RAB Satisfaction Note berhasil diunduh.');
    } catch (err) {
      console.error(err);
      onNotify?.('Gagal mengekspor PDF RAB Satisfaction Note.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Action Header */}
      <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 text-emerald-700 border border-emerald-200/80 rounded-lg shrink-0">
            <FileCheck2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 leading-tight">
              Rincian Biaya Satisfaction Note (Serah Terima &amp; Owner Surveyor)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Sumber volume: {hasOpnameSource ? 'Hasil Opname Aktual' : 'Repair List'} · {metrics.acceptedCount}/{effectiveItems.length} item berstatus Accepted · {metrics.notedCount} item memiliki catatan surveyor
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
              <span>Rincian Satisfaction</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('summary')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5 ${
                viewMode === 'summary' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Rekap Kategori</span>
            </button>
          </div>

          {onNavigateToSatisfactionNote && (
            <button
              type="button"
              onClick={onNavigateToSatisfactionNote}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Buka Tab Satisfaction Note</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}

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
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Cetak PDF</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">Nilai Pekerjaan Accepted / Satisfied</div>
          <div className="text-base font-bold text-emerald-700 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.acceptedCost)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {metrics.acceptedCount} dari {effectiveItems.length} item disetujui
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">Nilai Item Bersyarat / Catatan</div>
          <div className="text-base font-bold text-amber-700 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.conditionalCost)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Pending / Belum Dinilai: {TonnageCalculator.formatRupiah(metrics.pendingCost)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5">
          <div className="text-[11px] font-medium text-slate-500">Cakupan Catatan Surveyor</div>
          <div className="text-base font-bold text-slate-900 font-mono tabular-nums mt-1">
            {metrics.notedCount} / {effectiveItems.length} Item
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Tersinkron dengan tab Satisfaction Note
          </div>
        </div>

        <div className="bg-emerald-950 border border-emerald-900 rounded-xl p-3.5 text-white">
          <div className="text-[11px] font-medium text-emerald-200">
            Grand Total RAB ({scopeFilter === 'accepted' ? 'Accepted Only' : 'Cakupan Aktif'})
          </div>
          <div className="text-base font-bold text-amber-300 font-mono tabular-nums mt-1">
            {TonnageCalculator.formatRupiah(metrics.financials.grandTotalCost)}
          </div>
          <div className="text-[11px] text-emerald-300 mt-1 font-mono tabular-nums">
            Inc. OH {overheadPercent}% &amp; PPN {ppnPercent}%
          </div>
        </div>
      </div>

      {/* VIEW MODE 1: DETAILED SATISFACTION TABLE */}
      {viewMode === 'detailed' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Cari no, uraian, catatan surveyor..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-60 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
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
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value as any)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-slate-700 focus:outline-hidden"
              >
                <option value="all">Semua Item Proyek</option>
                <option value="accepted">Hanya Accepted / Satisfied</option>
                <option value="noted">Hanya Ada Catatan Satisfaction</option>
                <option value="conditional">Hanya Bersyarat / Revisi</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>Edit catatan &amp; status langsung tersimpan ke dokumen Satisfaction Note</span>
            </div>
          </div>

          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-left text-xs border-collapse min-w-[1140px]">
              <thead>
                <tr className="bg-slate-900 text-white text-[10px] uppercase tracking-wider font-semibold">
                  <th className="py-2.5 px-2.5 w-16 text-center border-r border-slate-800 whitespace-nowrap">No</th>
                  <th className="py-2.5 px-3 min-w-[240px] border-r border-slate-800">Uraian Pekerjaan</th>
                  <th className="py-2.5 px-3 min-w-[230px] border-r border-slate-800">Catatan Satisfaction Note</th>
                  <th className="py-2.5 px-2.5 w-36 text-center border-r border-slate-800 whitespace-nowrap">Status Acceptance</th>
                  <th className="py-2.5 px-2.5 w-20 text-right border-r border-slate-800 whitespace-nowrap">Vol / Qty</th>
                  <th className="py-2.5 px-2 w-16 text-center border-r border-slate-800 whitespace-nowrap">Sat</th>
                  <th className="py-2.5 px-2.5 w-24 text-right border-r border-slate-800 whitespace-nowrap">Tonase</th>
                  <th className="py-2.5 px-3 w-40 text-right border-r border-slate-800 whitespace-nowrap">Tarif Satuan (Rp)</th>
                  <th className="py-2.5 px-3 w-36 text-right whitespace-nowrap bg-emerald-950 text-emerald-200">
                    Biaya Satisfaction (Rp)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedCategories.map((cat) => {
                  const catItems = filteredItems.filter((i) => i.categoryId === cat.id);
                  if (catItems.length === 0) return null;

                  const catTotal = catItems.reduce(
                    (sum, i) => sum + calculateSatisfactionItemCost(i, hasOpnameSource),
                    0
                  );

                  return (
                    <React.Fragment key={cat.id}>
                      <tr className="bg-emerald-900 text-white font-bold text-xs">
                        <td colSpan={8} className="py-2 px-3">
                          {cat.code}. {cat.name.toUpperCase()} ({catItems.length} item)
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-300 whitespace-nowrap">
                          {TonnageCalculator.formatRupiah(catTotal)}
                        </td>
                      </tr>

                      {catItems.map((item) => {
                        const qty = hasOpnameSource ? getEffectiveOpnameQty(item) : getEffectiveRepairQty(item);
                        const weight = hasOpnameSource ? getEffectiveOpnameWeightKg(item) : (item.weightKg || 0);
                        const cost = calculateSatisfactionItemCost(item, hasOpnameSource);
                        const basis = getItemPriceBasis(item);
                        const satStatus = deriveSatisfactionStatus(item, notesMap, statusMap);
                        const isArea = item.itemLevel === 1 || item.isAreaHeader;

                        return (
                          <tr
                            key={item.id}
                            className={`transition-colors hover:bg-slate-50 ${isArea ? 'bg-slate-50/70 font-semibold' : 'bg-white'}`}
                          >
                            <td className="py-2 px-2.5 text-center font-mono text-[11px] text-slate-600 border-r border-slate-100 whitespace-nowrap">
                              {item.itemNo}
                            </td>
                            <td className="py-2 px-3 border-r border-slate-100 text-slate-900 leading-snug">
                              {item.description}
                            </td>
                            <td className="py-1.5 px-2.5 border-r border-slate-100">
                              <input
                                type="text"
                                value={notesMap[item.id] || ''}
                                onChange={(e) => handleNoteChange(item.id, e.target.value)}
                                placeholder="Catatan acceptance / surveyor..."
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded bg-white text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:border-emerald-600"
                              />
                            </td>
                            <td className="py-1.5 px-2 border-r border-slate-100 whitespace-nowrap">
                              <select
                                value={satStatus}
                                onChange={(e) => handleStatusChange(item.id, e.target.value as SatisfactionRabStatus)}
                                className={`w-full px-2 py-1 text-[11px] font-semibold border rounded bg-white focus:outline-hidden cursor-pointer ${
                                  satStatus === 'Accepted'
                                    ? 'border-emerald-300 text-emerald-800'
                                    : satStatus === 'Conditional'
                                    ? 'border-amber-300 text-amber-800'
                                    : 'border-slate-300 text-slate-600'
                                }`}
                              >
                                <option value="Accepted">Accepted / Satisfied</option>
                                <option value="Conditional">Bersyarat / Catatan</option>
                                <option value="Pending">Belum Dinilai</option>
                              </select>
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-800 border-r border-slate-100 whitespace-nowrap">
                              {qty > 0 ? qty.toLocaleString('id-ID', { maximumFractionDigits: 2 }) : '-'}
                            </td>
                            <td className="py-2 px-2 text-center font-mono text-slate-600 border-r border-slate-100 whitespace-nowrap">
                              {item.unit || '-'}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-700 border-r border-slate-100 whitespace-nowrap">
                              {weight > 0 ? `${weight.toLocaleString('id-ID', { maximumFractionDigits: 2 })} kg` : '-'}
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
                            <td className="py-2 px-3 text-right font-mono tabular-nums font-bold text-emerald-800 whitespace-nowrap">
                              {TonnageCalculator.formatRupiah(cost)}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {filteredItems.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-xs text-slate-500">
                      Tidak ada item yang cocok dengan filter Satisfaction Note saat ini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW MODE 2: REKAP PER KATEGORI */}
      {viewMode === 'summary' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-bold text-xs text-slate-800">
            Rekapitulasi Biaya Satisfaction Note per Kategori Pekerjaan
          </div>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-slate-100 text-slate-600 text-[10px] uppercase border-b border-slate-200">
                  <th className="py-2.5 px-3">Kategori</th>
                  <th className="py-2.5 px-3 text-center whitespace-nowrap">Accepted / Item</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Tonase (kg)</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Subtotal Biaya</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Porsi (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {categoryBreakdown.map((row) => {
                  const pct = metrics.financials.baseCost > 0 ? (row.totalCost / metrics.financials.baseCost) * 100 : 0;
                  return (
                    <tr key={row.category.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-medium text-slate-900">
                        <span className="font-bold text-emerald-700 mr-1.5">{row.category.code}.</span>
                        {row.category.name}
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {row.acceptedCount} / {row.itemsCount}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {row.tonnage > 0 ? `${row.tonnage.toFixed(2)} kg` : '-'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {TonnageCalculator.formatRupiah(row.totalCost)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {pct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Financial Footer Breakdown */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <span className="text-slate-500 block text-[11px]">1. DPP Satisfaction Note:</span>
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
        <div className="p-3 rounded-lg bg-emerald-900 text-white border border-emerald-900 flex flex-col justify-between">
          <span className="text-emerald-200 font-semibold text-[10px] uppercase tracking-wider">
            4. Grand Total Satisfaction Note:
          </span>
          <span className="font-mono tabular-nums font-black text-amber-300 text-base">
            {TonnageCalculator.formatRupiah(metrics.financials.grandTotalCost)}
          </span>
        </div>
      </div>
    </div>
  );
};
