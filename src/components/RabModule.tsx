import React, { useEffect, useMemo, useState } from 'react';
import {
  FileSpreadsheet,
  ClipboardCheck,
  FileCheck2,
  Calculator,
} from 'lucide-react';
import { WorkCategory, WorkItem, VesselSpec, ProjectSchedule } from '../types';
import { TonnageCalculator } from '../utils/tonnageCalculator';
import {
  calculateOpnameItemCost,
  calculateRepairItemCost,
  calculateSatisfactionItemCost,
  computeFinancialTotals,
  deriveSatisfactionStatus,
  SatisfactionRabStatus,
} from '../utils/rabHelpers';
import { CostEstimationSummary } from './CostEstimationSummary';
import { RabOpnameView } from './RabOpnameView';
import { RabSatisfactionView } from './RabSatisfactionView';
import { notifyCloudDirty } from '../services/projectExtrasSync';

export type RabSubTab = 'repair-list' | 'opname' | 'satisfaction-note';

interface RabModuleProps {
  categories: WorkCategory[];
  workItems: WorkItem[];
  opnameItems: WorkItem[];
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  onOpenPdfModal: () => void;
  onExportExcel?: () => void;
  onExportWord?: () => void;
  onOpenImportModal?: () => void;
  onDownloadTemplate?: () => void;
  onOpenFullModal?: (tab?: 'export' | 'import') => void;
  onAddItem?: (item: Omit<WorkItem, 'id'>) => void;
  onUpdateItem?: (updatedItem: WorkItem) => void;
  onDeleteItem?: (id: string) => void;
  onBulkDeleteItems?: (ids: string[]) => void;
  onUpdateItemsBatch?: (updatedItems: WorkItem[]) => void;
  onUpdateOpnameItem?: (updatedItem: WorkItem) => void;
  onBatchUpdateOpnameItems?: (updatedItems: WorkItem[]) => void;
  onSyncOpnameFromRepairList?: (mode: 'replace' | 'merge_new') => void;
  onNavigateToMaterialEstimation?: () => void;
  onNavigateToOpname?: () => void;
  onNavigateToSatisfactionNote?: () => void;
  onNotify?: (msg: string) => void;
}

export const RabModule: React.FC<RabModuleProps> = ({
  categories,
  workItems,
  opnameItems,
  vessel,
  schedule,
  onOpenPdfModal,
  onExportExcel,
  onExportWord,
  onOpenImportModal,
  onDownloadTemplate,
  onOpenFullModal,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onBulkDeleteItems,
  onUpdateItemsBatch,
  onUpdateOpnameItem,
  onBatchUpdateOpnameItems,
  onSyncOpnameFromRepairList,
  onNavigateToMaterialEstimation,
  onNavigateToOpname,
  onNavigateToSatisfactionNote,
  onNotify,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<RabSubTab>(() => {
    try {
      const saved = localStorage.getItem('shipyard_rab_active_subtab');
      if (saved === 'repair-list' || saved === 'opname' || saved === 'satisfaction-note') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'repair-list';
  });

  useEffect(() => {
    try {
      localStorage.setItem('shipyard_rab_active_subtab', activeSubTab);
    } catch {
      // ignore
    }
  }, [activeSubTab]);

  const [hydrationTick, setHydrationTick] = useState(0);

  const [overheadPercent, setOverheadPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(`shipyard_overhead_percent_${vessel.id || 'default'}`);
      if (saved) return parseFloat(saved) || 0;
    } catch {
      // ignore
    }
    return 5;
  });

  const [ppnPercent, setPpnPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(`shipyard_ppn_percent_${vessel.id || 'default'}`);
      if (saved) return parseFloat(saved) || 0;
    } catch {
      // ignore
    }
    return 11;
  });

  useEffect(() => {
    const reload = () => {
      try {
        const savedOh = localStorage.getItem(`shipyard_overhead_percent_${vessel.id || 'default'}`);
        setOverheadPercent(savedOh !== null ? parseFloat(savedOh) || 0 : 5);
      } catch {
        // ignore
      }
      try {
        const savedPpn = localStorage.getItem(`shipyard_ppn_percent_${vessel.id || 'default'}`);
        setPpnPercent(savedPpn !== null ? parseFloat(savedPpn) || 0 : 11);
      } catch {
        // ignore
      }
      setHydrationTick((t) => t + 1);
    };
    reload();
    window.addEventListener('shipyard-cloud-hydrated', reload);
    return () => window.removeEventListener('shipyard-cloud-hydrated', reload);
  }, [vessel.id]);

  const handleOverheadChange = (val: number) => {
    setOverheadPercent(val);
    try {
      localStorage.setItem(`shipyard_overhead_percent_${vessel.id || 'default'}`, String(val));
      notifyCloudDirty(schedule?.id);
    } catch {
      // ignore
    }
  };

  const handlePpnChange = (val: number) => {
    setPpnPercent(val);
    try {
      localStorage.setItem(`shipyard_ppn_percent_${vessel.id || 'default'}`, String(val));
      notifyCloudDirty(schedule?.id);
    } catch {
      // ignore
    }
  };

  // Compute live comparative totals across all 3 RAB types
  const comparativeSummary = useMemo(() => {
    // 1. Repair List
    const repairBase = workItems.reduce((sum, item) => sum + (item.totalPrice || calculateRepairItemCost(item)), 0);
    const repairTotals = computeFinancialTotals(repairBase, overheadPercent, ppnPercent);

    // 2. Opname
    const opnameBase = opnameItems.reduce(
      (sum, item) => sum + calculateOpnameItemCost(item, { excludeRejected: true }),
      0
    );
    const opnameTotals = computeFinancialTotals(opnameBase, overheadPercent, ppnPercent);
    const opnameVerifiedCount = opnameItems.filter(
      (i) => i.opnameStatus === 'Terverifikasi' || (i.opnamePercent || 0) >= 100
    ).length;

    // 3. Satisfaction Note
    const projectKey = vessel?.id || vessel?.projectNo || 'default';
    let notesMap: Record<string, string> = {};
    let statusMap: Record<string, SatisfactionRabStatus> = {};
    try {
      const savedNotes = localStorage.getItem(`satisfaction_notes_${projectKey}`);
      if (savedNotes) notesMap = JSON.parse(savedNotes);
      const savedStatus = localStorage.getItem(`satisfaction_rab_status_${projectKey}`);
      if (savedStatus) statusMap = JSON.parse(savedStatus);
    } catch {
      // ignore
    }

    const hasOpnameSource = opnameItems.length > 0;
    const satItems = hasOpnameSource ? opnameItems : workItems;
    let satisfactionAcceptedBase = 0;
    let satisfactionTotalBase = 0;
    let satisfactionAcceptedCount = 0;

    satItems.forEach((item) => {
      const c = calculateSatisfactionItemCost(item, hasOpnameSource);
      satisfactionTotalBase += c;
      if (deriveSatisfactionStatus(item, notesMap, statusMap) === 'Accepted') {
        satisfactionAcceptedBase += c;
        satisfactionAcceptedCount++;
      }
    });

    const satisfactionTotals = computeFinancialTotals(satisfactionTotalBase, overheadPercent, ppnPercent);
    const satisfactionAcceptedTotals = computeFinancialTotals(satisfactionAcceptedBase, overheadPercent, ppnPercent);

    return {
      repairTotals,
      opnameTotals,
      opnameVerifiedCount,
      satisfactionTotals,
      satisfactionAcceptedTotals,
      satisfactionAcceptedCount,
      satisfactionItemCount: satItems.length,
    };
  }, [workItems, opnameItems, vessel?.id, vessel?.projectNo, overheadPercent, ppnPercent, activeSubTab, hydrationTick]);

  return (
    <div className="space-y-4">
      {/* Unified RAB Module Header & Shared Commercial Parameters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200/80 flex items-center justify-center shrink-0">
              <Calculator className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                Modul Rencana Anggaran Biaya (RAB)
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                {vessel.name} &middot; {vessel.projectNo || 'No. Proyek'} &middot; {vessel.companyOwner || 'Owner'}
              </p>
            </div>
          </div>

          {/* Shared Commercial Overhead & PPN Parameters */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <label htmlFor="rab-overhead-input" className="text-slate-600 font-medium whitespace-nowrap">
                Overhead
              </label>
              <div className="inline-flex items-center border border-slate-300 rounded-lg bg-slate-50 px-2 py-1">
                <input
                  id="rab-overhead-input"
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={overheadPercent}
                  onChange={(e) => handleOverheadChange(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-12 text-right font-mono tabular-nums font-bold text-slate-900 bg-transparent focus:outline-hidden"
                />
                <span className="text-slate-500 font-mono ml-1">%</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="rab-ppn-input" className="text-slate-600 font-medium whitespace-nowrap">
                PPN
              </label>
              <div className="inline-flex items-center border border-slate-300 rounded-lg bg-slate-50 px-2 py-1">
                <input
                  id="rab-ppn-input"
                  type="number"
                  min={0}
                  max={30}
                  step={0.5}
                  value={ppnPercent}
                  onChange={(e) => handlePpnChange(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-12 text-right font-mono tabular-nums font-bold text-slate-900 bg-transparent focus:outline-hidden"
                />
                <span className="text-slate-500 font-mono ml-1">%</span>
              </div>
            </div>
          </div>
        </div>

        {/* 3-Type RAB Comparative Switcher Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* 1. RAB Repair List */}
          <button
            type="button"
            onClick={() => setActiveSubTab('repair-list')}
            className={`text-left rounded-xl p-3.5 border transition-colors cursor-pointer ${
              activeSubTab === 'repair-list'
                ? 'bg-emerald-50/70 border-emerald-500 ring-1 ring-emerald-500'
                : 'bg-slate-50/50 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900">
                <FileSpreadsheet className={`w-4 h-4 ${activeSubTab === 'repair-list' ? 'text-emerald-700' : 'text-slate-500'}`} />
                <span>1. RAB Repair List</span>
              </span>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {workItems.length} item
              </span>
            </div>
            <div className="text-base font-bold text-slate-900 font-mono tabular-nums mt-2">
              {TonnageCalculator.formatRupiah(comparativeSummary.repairTotals.grandTotalCost)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              DPP: {TonnageCalculator.formatRupiah(comparativeSummary.repairTotals.baseCost)}
            </div>
          </button>

          {/* 2. RAB Opname */}
          <button
            type="button"
            onClick={() => setActiveSubTab('opname')}
            className={`text-left rounded-xl p-3.5 border transition-colors cursor-pointer ${
              activeSubTab === 'opname'
                ? 'bg-sky-50/70 border-sky-500 ring-1 ring-sky-500'
                : 'bg-slate-50/50 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900">
                <ClipboardCheck className={`w-4 h-4 ${activeSubTab === 'opname' ? 'text-sky-700' : 'text-slate-500'}`} />
                <span>2. RAB Opname</span>
              </span>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {comparativeSummary.opnameVerifiedCount}/{opnameItems.length} verified
              </span>
            </div>
            <div className="text-base font-bold text-slate-900 font-mono tabular-nums mt-2">
              {TonnageCalculator.formatRupiah(comparativeSummary.opnameTotals.grandTotalCost)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              DPP: {TonnageCalculator.formatRupiah(comparativeSummary.opnameTotals.baseCost)}
            </div>
          </button>

          {/* 3. RAB Satisfaction Note */}
          <button
            type="button"
            onClick={() => setActiveSubTab('satisfaction-note')}
            className={`text-left rounded-xl p-3.5 border transition-colors cursor-pointer ${
              activeSubTab === 'satisfaction-note'
                ? 'bg-emerald-50/70 border-emerald-600 ring-1 ring-emerald-600'
                : 'bg-slate-50/50 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900">
                <FileCheck2 className={`w-4 h-4 ${activeSubTab === 'satisfaction-note' ? 'text-emerald-700' : 'text-slate-500'}`} />
                <span>3. RAB Satisfaction Note</span>
              </span>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {comparativeSummary.satisfactionAcceptedCount}/{comparativeSummary.satisfactionItemCount} accepted
              </span>
            </div>
            <div className="text-base font-bold text-slate-900 font-mono tabular-nums mt-2">
              {TonnageCalculator.formatRupiah(comparativeSummary.satisfactionAcceptedTotals.grandTotalCost)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              Total Proyek: {TonnageCalculator.formatRupiah(comparativeSummary.satisfactionTotals.grandTotalCost)}
            </div>
          </button>
        </div>

        {/* Sub-Tab Bar */}
        <div className="flex items-center gap-2 overflow-x-auto pt-1">
          <button
            type="button"
            onClick={() => setActiveSubTab('repair-list')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              activeSubTab === 'repair-list'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Rincian Biaya Repair List</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('opname')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              activeSubTab === 'opname'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            <ClipboardCheck className="w-3.5 h-3.5" />
            <span>Rincian Biaya Opname</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('satisfaction-note')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              activeSubTab === 'satisfaction-note'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            <FileCheck2 className="w-3.5 h-3.5" />
            <span>Rincian Biaya Satisfaction Note</span>
          </button>
        </div>
      </div>

      {/* Sub-module Content */}
      {activeSubTab === 'repair-list' && (
        <CostEstimationSummary
          categories={categories}
          workItems={workItems}
          vessel={vessel}
          onOpenPdfModal={onOpenPdfModal}
          onExportExcel={onExportExcel}
          onExportWord={onExportWord}
          onOpenImportModal={onOpenImportModal}
          onDownloadTemplate={onDownloadTemplate}
          onOpenFullModal={onOpenFullModal}
          onAddItem={onAddItem}
          onUpdateItem={onUpdateItem}
          onDeleteItem={onDeleteItem}
          onBulkDeleteItems={onBulkDeleteItems}
          onUpdateItemsBatch={onUpdateItemsBatch}
          onNavigateToMaterialEstimation={onNavigateToMaterialEstimation}
          overheadPercent={overheadPercent}
          onOverheadPercentChange={setOverheadPercent}
          ppnPercent={ppnPercent}
          onPpnPercentChange={setPpnPercent}
          embeddedInRabModule={true}
        />
      )}

      {activeSubTab === 'opname' && (
        <RabOpnameView
          categories={categories}
          opnameItems={opnameItems}
          repairItems={workItems}
          vessel={vessel}
          schedule={schedule}
          overheadPercent={overheadPercent}
          ppnPercent={ppnPercent}
          onUpdateOpnameItem={onUpdateOpnameItem}
          onBatchUpdateOpnameItems={onBatchUpdateOpnameItems}
          onSyncFromRepairList={onSyncOpnameFromRepairList}
          onNavigateToOpname={onNavigateToOpname}
          onNotify={onNotify}
        />
      )}

      {activeSubTab === 'satisfaction-note' && (
        <RabSatisfactionView
          categories={categories}
          opnameItems={opnameItems}
          repairItems={workItems}
          vessel={vessel}
          schedule={schedule}
          overheadPercent={overheadPercent}
          ppnPercent={ppnPercent}
          onUpdateOpnameItem={onUpdateOpnameItem}
          onUpdateWorkItem={onUpdateItem}
          onNavigateToSatisfactionNote={onNavigateToSatisfactionNote}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
