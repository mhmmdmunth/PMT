import React, { useState } from 'react';
import {
  FileText,
  Ship,
  Calendar,
  FileDown,
  Search,
  CheckCircle2,
  Clock,
  Scale,
  Building2,
  Check,
  FileSpreadsheet,
} from 'lucide-react';
import { WorkItem, WorkCategory, VesselSpec, ProjectSchedule } from '../types';
import { TonnageCalculator } from '../utils/tonnageCalculator';
import { generateWorkDoneReportPdf } from '../utils/pdfExport';
import { exportWorkDoneReportExcel } from '../utils/excelExport';

interface WorkDoneReportModuleProps {
  opnameItems: WorkItem[];
  categories: WorkCategory[];
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  workItems?: WorkItem[];
  onNotify?: (msg: string) => void;
}

export const WorkDoneReportModule: React.FC<WorkDoneReportModuleProps> = ({
  opnameItems,
  categories,
  vessel,
  schedule,
  workItems = [],
  onNotify,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'Terverifikasi' | 'Dalam Pengerjaan' | 'Belum'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Fallback to workItems if opnameItems is not yet initialized
  const effectiveItems = opnameItems && opnameItems.length > 0 ? opnameItems : workItems;

  const storageKey = `satisfaction_notes_${vessel?.id || vessel?.projectNo || 'default'}`;
  const [notesMap, setNotesMap] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const handleNoteChange = (itemId: string, text: string) => {
    setNotesMap((prev) => {
      const next = { ...prev, [itemId]: text };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch (e) {
        console.warn('Failed saving satisfaction notes', e);
      }
      return next;
    });
  };

  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  // Total stats
  const totalItems = effectiveItems.length;
  const verifiedItems = effectiveItems.filter((i) => i.opnameStatus === 'Terverifikasi' || (i.opnamePercent || 0) >= 100).length;
  const inProgressItems = effectiveItems.filter((i) => (i.opnamePercent || 0) > 0 && (i.opnamePercent || 0) < 100).length;
  const completionPercent = totalItems > 0 ? Math.round((verifiedItems / totalItems) * 100) : 0;

  const totalWeightKg = effectiveItems.reduce((sum, item) => sum + (item.weightKg || 0), 0);
  const totalCostRp = effectiveItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);

  const handleExportPdf = async () => {
    try {
      setIsExporting(true);
      if (onNotify) onNotify('📄 Mengekspor Work Done / Docking Report PDF resmi...');
      await generateWorkDoneReportPdf(vessel, schedule, categories, effectiveItems, notesMap);
      if (onNotify) onNotify('✅ Berhasil mengunduh Work Done Report PDF!');
    } catch (e) {
      console.error('Export PDF error:', e);
      if (onNotify) onNotify('⚠️ Gagal membuat PDF: ' + (e instanceof Error ? e.message : 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportExcel = async () => {
    try {
      setIsExporting(true);
      if (onNotify) onNotify('📊 Mengekspor Work Done Report Excel (.xlsx)...');
      await exportWorkDoneReportExcel(vessel, schedule, categories, effectiveItems, notesMap);
      if (onNotify) onNotify('✅ Berhasil mengunduh Work Done Report Excel!');
    } catch (e) {
      console.error('Export Excel error:', e);
      if (onNotify) onNotify('⚠️ Gagal membuat Excel: ' + (e instanceof Error ? e.message : 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Banner & Action Header */}
      <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 border border-blue-200/80 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <span>Work Done &amp; Docking Report</span>
              <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-blue-50 text-blue-800 border border-blue-200">
                Laporan Keseluruhan Project
              </span>
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Laporan komprehensif pekerjaan reparasi kapal berdasarkan opname, verifikasi owner surveyor, dan satisfaction notes.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={handleExportExcel}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-semibold text-xs shadow-2xs transition-colors cursor-pointer disabled:opacity-50 min-h-[34px]"
            title="Download file Excel Work Done Report"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-200" />
            <span>Export Excel (.xlsx)</span>
          </button>

          <button
            onClick={handleExportPdf}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#0b2545] hover:bg-[#134074] text-white rounded-lg font-semibold text-xs shadow-2xs transition-colors cursor-pointer disabled:opacity-50 min-h-[34px]"
            title="Download file PDF Work Done & Docking Report"
          >
            <FileDown className="w-4 h-4 text-amber-300" />
            <span>Export PDF Resmi</span>
          </button>
        </div>
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 border border-blue-100 font-bold">
            <Ship className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-500 block">Total Pekerjaan</span>
            <div className="text-base font-bold text-slate-900 font-mono tabular-nums">
              {totalItems} <span className="text-xs font-normal text-slate-500">Item</span>
            </div>
          </div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100 font-bold">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-500 block">Selesai Terverifikasi</span>
            <div className="text-base font-bold text-emerald-700 font-mono tabular-nums">
              {verifiedItems} <span className="text-xs font-normal text-slate-500">({completionPercent}%)</span>
            </div>
          </div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0 border border-amber-100 font-bold">
            <Scale className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-500 block">Total Tonase Baja</span>
            <div className="text-base font-bold text-amber-800 font-mono tabular-nums">
              {TonnageCalculator.formatWeight(totalWeightKg)}
            </div>
          </div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center shrink-0 border border-purple-100 font-bold">
            <Building2 className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-500 block">Total Nilai (RAB)</span>
            <div className="text-base font-bold text-purple-800 font-mono tabular-nums">
              Rp {(totalCostRp / 1000000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} Jt
            </div>
          </div>
        </div>
      </div>

      {/* Vessel & Schedule Info Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-xs">
          <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 flex items-center gap-1.5 mb-2.5 pb-2 border-b border-slate-100">
            <Ship className="w-3.5 h-3.5 text-emerald-600" />
            <span>Spesifikasi Umum Kapal</span>
          </h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500">Nama Kapal:</span>
              <span className="font-semibold text-slate-900 truncate ml-2">{vessel?.name || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500">No. Proyek:</span>
              <span className="font-semibold text-slate-900 font-mono ml-2">{vessel?.projectNo || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500">Jenis Kapal:</span>
              <span className="font-semibold text-slate-900 ml-2">{vessel?.vesselType || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500">Klasifikasi:</span>
              <span className="font-semibold text-slate-900 ml-2">{vessel?.classification || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50 col-span-2 sm:col-span-1">
              <span className="text-slate-500">Owner:</span>
              <span className="font-semibold text-slate-900 truncate ml-2">{vessel?.companyOwner || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50 col-span-2 sm:col-span-1">
              <span className="text-slate-500">Jenis Survey:</span>
              <span className="font-semibold text-slate-900 ml-2">{vessel?.kindOfSurvey || '-'}</span>
            </div>
          </div>
        </div>

        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-xs">
          <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 flex items-center gap-1.5 mb-2.5 pb-2 border-b border-slate-100">
            <Calendar className="w-3.5 h-3.5 text-amber-600" />
            <span>Linimasa Pelaksanaan Docking</span>
          </h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Datang (Arrive):</span>
              <span className="font-semibold text-slate-900">{schedule?.arriveBgn || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Mulai Kontrak:</span>
              <span className="font-semibold text-slate-900">{schedule?.startContract || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Naik Dok:</span>
              <span className="font-semibold text-emerald-700 font-bold">{schedule?.dockingDate || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Turun Dok:</span>
              <span className="font-semibold text-sky-700 font-bold">{schedule?.undockingDate || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Selesai:</span>
              <span className="font-semibold text-slate-900">{schedule?.finishWork || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Sail Out:</span>
              <span className="font-semibold text-amber-700 font-bold">{schedule?.sailOut || '-'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Cari uraian / catatan..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-emerald-500 min-h-[34px] w-52 sm:w-64"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg font-medium text-slate-700 min-h-[34px]"
          >
            <option value="ALL">Semua Status</option>
            <option value="Terverifikasi">Terverifikasi (100%)</option>
            <option value="Dalam Pengerjaan">Dalam Pengerjaan</option>
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg font-medium text-slate-700 min-h-[34px] max-w-[220px] truncate"
          >
            <option value="ALL">Semua Kategori (I - XI)</option>
            {sortedCategories.map((c) => (
              <option key={c.id} value={c.id}>Kategori {c.code}: {c.name}</option>
            ))}
          </select>
        </div>

        <div className="text-xs font-semibold text-slate-500">
          Menampilkan <strong className="text-slate-900 font-mono">{effectiveItems.length}</strong> item
        </div>
      </div>

      {/* Categories & Work Items Report Tables */}
      <div className="space-y-6">
        {sortedCategories.map((category) => {
          if (categoryFilter !== 'ALL' && categoryFilter !== category.id) return null;

          const categoryItems = effectiveItems.filter((item) => {
            if (item.categoryId !== category.id) return false;
            if (statusFilter === 'Terverifikasi' && item.opnameStatus !== 'Terverifikasi' && (item.opnamePercent || 0) < 100) return false;
            if (statusFilter === 'Dalam Pengerjaan' && ((item.opnamePercent || 0) === 0 || item.opnameStatus === 'Terverifikasi')) return false;

            if (searchQuery.trim() !== '') {
              const q = searchQuery.toLowerCase();
              const matchDesc = (item.description || '').toLowerCase().includes(q);
              const matchNotes = (item.notes || '').toLowerCase().includes(q);
              const matchSat = (notesMap[item.id] || '').toLowerCase().includes(q);
              if (!matchDesc && !matchNotes && !matchSat) return false;
            }
            return true;
          });

          if (categoryItems.length === 0) return null;

          return (
            <div key={category.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="bg-[#0b2545] px-5 py-3 font-bold text-white text-xs flex items-center justify-between">
                <span>Kategori {category.code}: {category.name}</span>
                <span className="px-2 py-0.5 bg-slate-800 text-amber-300 rounded-md text-[10px] font-mono font-bold">
                  {categoryItems.length} Item
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead className="bg-slate-100 text-slate-900 uppercase font-bold border-b border-slate-200 text-[10.5px]">
                    <tr>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-12">No.</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 min-w-[220px]">Uraian Pekerjaan</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 w-28">Spesifikasi</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-16">Tipe</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-14">Qty</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-14">Unit</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-20">Vendor</th>
                      <th className="px-3 py-2.5 border-r border-slate-200 text-center w-20">Status</th>
                      <th className="px-3 py-2.5 min-w-[240px]">Satisfaction Note / Work Done Report</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {categoryItems.map((item) => {
                      const isVerified = item.opnameStatus === 'Terverifikasi' || (item.opnamePercent || 0) >= 100;
                      return (
                        <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-3 py-2 text-center font-mono font-bold text-slate-800 border-r border-slate-200">
                            {item.itemNo}
                          </td>
                          <td className="px-3 py-2 border-r border-slate-200 text-slate-900 font-semibold">
                            {item.description}
                          </td>
                          <td className="px-3 py-2 border-r border-slate-200 text-slate-600">
                            {item.notes || '-'}
                          </td>
                          <td className="px-3 py-2 text-center font-mono border-r border-slate-200 text-slate-700 font-bold uppercase">
                            {item.type || '-'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono border-r border-slate-200 font-bold text-slate-900">
                            {item.qty || '-'}
                          </td>
                          <td className="px-3 py-2 text-center font-mono border-r border-slate-200 text-slate-600">
                            {item.unit || '-'}
                          </td>
                          <td className="px-3 py-2 text-center font-medium border-r border-slate-200 text-purple-800">
                            {item.subcontractor || item.assignedTo || '-'}
                          </td>
                          <td className="px-3 py-2 text-center border-r border-slate-200">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                isVerified
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : (item.opnamePercent || 0) > 0
                                  ? 'bg-sky-100 text-sky-800'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {isVerified && <Check className="w-3 h-3" />}
                              <span>{isVerified ? 'Terverifikasi' : `${item.opnamePercent || 0}%`}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <textarea
                              value={notesMap[item.id] || ''}
                              onChange={(e) => handleNoteChange(item.id, e.target.value)}
                              placeholder="Catatan pengerjaan / satisfaction note surveyor..."
                              rows={1}
                              className="w-full text-xs px-2 py-1 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 font-normal resize-none"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sign-off Signatures Section */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs mt-8">
        <h3 className="font-bold text-slate-900 text-sm uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">
          Pengesahan &amp; Tanda Tangan Laporan Docking / Work Done
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center text-xs text-slate-700">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-12">
            <div>
              <p className="font-bold text-slate-900">Owner Surveyor / Representative</p>
              <p className="text-[10px] text-slate-500">Klasifikasi / Perusahaan Pemilik</p>
            </div>
            <div className="border-b border-slate-400 w-3/4 mx-auto"></div>
            <p className="font-semibold text-slate-800">( Nama &amp; Tanda Tangan )</p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-12">
            <div>
              <p className="font-bold text-slate-900">Shipyard Project Manager (Pimpro)</p>
              <p className="text-[10px] text-slate-500">Manajemen Galangan Kapal</p>
            </div>
            <div className="border-b border-slate-400 w-3/4 mx-auto"></div>
            <p className="font-semibold text-slate-800">( Nama &amp; Tanda Tangan )</p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-12">
            <div>
              <p className="font-bold text-slate-900">Quality Control (QC) Inspector</p>
              <p className="text-[10px] text-slate-500">Inspektor &amp; Verifikator Lapangan</p>
            </div>
            <div className="border-b border-slate-400 w-3/4 mx-auto"></div>
            <p className="font-semibold text-slate-800">( Nama &amp; Tanda Tangan )</p>
          </div>
        </div>
      </div>
    </div>
  );
};
