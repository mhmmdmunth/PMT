import React from 'react';
import { ClipboardCheck, Ship, Calendar, FileDown, CheckCircle2 } from 'lucide-react';
import { WorkItem, WorkCategory, VesselSpec, ProjectSchedule } from '../types';
import { generateSatisfactionNotePdf } from '../utils/pdfExport';

interface SatisfactionNoteModuleProps {
  opnameItems: WorkItem[];
  categories: WorkCategory[];
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  workItems?: WorkItem[];
}

export const SatisfactionNoteModule: React.FC<SatisfactionNoteModuleProps> = ({
  opnameItems,
  categories,
  vessel,
  schedule,
  workItems = [],
}) => {
  const effectiveItems = opnameItems.length > 0 ? opnameItems : workItems;
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  const storageKey = `satisfaction_notes_${vessel?.id || vessel?.projectNo || 'default'}`;
  const [notesMap, setNotesMap] = React.useState<Record<string, string>>(() => {
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
        console.warn('Failed saving satisfaction notes to localStorage', e);
      }
      return next;
    });
  };

  const handleExportPdf = () => {
    generateSatisfactionNotePdf(vessel, schedule, categories, effectiveItems, notesMap);
  };

  return (
    <div className="space-y-4">
      {/* Header Banner */}
      <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200/80 flex items-center justify-center shrink-0">
            <ClipboardCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <span>Satisfaction Notes</span>
              <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                Owner Surveyor Verifier
              </span>
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Catatan verifikasi mutu dan kepuasan pekerjaan reparasi oleh Owner Representative / Surveyor.
            </p>
          </div>
        </div>

        <button
          onClick={handleExportPdf}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 active:bg-emerald-900 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer shadow-2xs shrink-0"
          title="Ekspor dokumen Satisfaction Note resmi ke file PDF"
        >
          <FileDown className="w-4 h-4 text-emerald-200" />
          <span>Export ke PDF</span>
        </button>
      </div>

      {/* 2-Column Info Cards: Vessel Specification & Docking Timeline */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Vessel Specifications */}
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
              <span className="font-semibold text-slate-900 truncate ml-2" title={vessel?.companyOwner}>{vessel?.companyOwner || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50 col-span-2 sm:col-span-1">
              <span className="text-slate-500">Jenis Survey:</span>
              <span className="font-semibold text-slate-900 ml-2">{vessel?.kindOfSurvey || '-'}</span>
            </div>
          </div>
        </div>

        {/* Docking Schedule Timeline */}
        <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-xs">
          <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 flex items-center gap-1.5 mb-2.5 pb-2 border-b border-slate-100">
            <Calendar className="w-3.5 h-3.5 text-amber-600" />
            <span>Linimasa Docking Proyek (PPC)</span>
          </h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Kedatangan (Arrive):</span>
              <span className="font-semibold text-slate-900">{schedule?.arriveBgn || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Mulai Kontrak:</span>
              <span className="font-semibold text-slate-900">{schedule?.startContract || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Naik Dok (Docking):</span>
              <span className="font-semibold text-emerald-700 font-bold">{schedule?.dockingDate || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Turun Dok (Undocking):</span>
              <span className="font-semibold text-sky-700 font-bold">{schedule?.undockingDate || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Selesai Pekerjaan:</span>
              <span className="font-semibold text-slate-900">{schedule?.finishWork || '-'}</span>
            </div>
            <div className="flex justify-between py-0.5 border-b border-slate-50">
              <span className="text-slate-500 font-sans">Keberangkatan (Sail):</span>
              <span className="font-semibold text-amber-700 font-bold">{schedule?.sailOut || '-'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Table Content Grouped by Category */}
      <div className="space-y-4">
        {sortedCategories.map((category) => {
          const categoryItems = effectiveItems.filter((item) => item.categoryId === category.id);
          if (categoryItems.length === 0) return null;

          return (
            <div key={category.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="bg-[#0b2545] px-4 py-2.5 font-bold text-white text-xs flex items-center justify-between">
                <span>Kategori {category.code}: {category.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-300 font-bold">
                  {categoryItems.length} Item
                </span>
              </div>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100 text-slate-700 uppercase font-bold border-b border-slate-200 text-[10px] tracking-wider">
                    <tr>
                      <th className="py-2 px-2.5 border-r border-slate-200 text-center w-14 font-mono">No.</th>
                      <th className="py-2 px-3 border-r border-slate-200 min-w-[240px]">Uraian Pekerjaan</th>
                      <th className="py-2 px-3 border-r border-slate-200 w-32">Keterangan</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-16 font-mono">Type</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-12 font-mono">D1</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-12 font-mono">D2</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-12 font-mono">D3</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-14 font-mono">DLen</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-12 font-mono">D4</th>
                      <th className="py-2 px-2 text-right border-r border-slate-200 w-16 font-mono">Qty</th>
                      <th className="py-2 px-2 text-center border-r border-slate-200 w-14 font-mono">Sat</th>
                      <th className="py-2 px-3 border-r border-slate-200 w-28">Remark</th>
                      <th className="py-2 px-3 min-w-[260px]">Satisfaction Note (Catatan Surveyor)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {categoryItems.map((item, idx) => {
                      const isArea = item.itemLevel === 1 || item.isAreaHeader;
                      return (
                        <tr
                          key={item.id}
                          className={`hover:bg-slate-50/80 transition-colors ${
                            isArea ? 'bg-slate-50/60 font-semibold' : ''
                          }`}
                        >
                          <td className="py-1.5 px-2.5 font-mono text-center border-r border-slate-200 text-slate-800 text-[11px]">
                            {item.itemNo || idx + 1}
                          </td>
                          <td className="py-1.5 px-3 border-r border-slate-200 text-slate-900 leading-snug">
                            {item.description}
                          </td>
                          <td className="py-1.5 px-3 border-r border-slate-200 text-slate-600 text-[11px]">
                            {item.notes || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.type || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.d1 || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.d2 || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.d3 || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.dLen || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.d4 || '-'}
                          </td>
                          <td className="py-1.5 px-2 text-right border-r border-slate-200 font-mono text-slate-800 font-semibold text-[11px]">
                            {item.qty && item.qty !== 0 ? item.qty : '-'}
                          </td>
                          <td className="py-1.5 px-2 text-center border-r border-slate-200 font-mono text-slate-600 text-[11px]">
                            {item.unit || '-'}
                          </td>
                          <td className="py-1.5 px-3 border-r border-slate-200 text-slate-600 text-[11px]">
                            {item.remark || '-'}
                          </td>
                          <td className="py-1 px-2.5">
                            <input
                              type="text"
                              value={notesMap[item.id] || ''}
                              onChange={(e) => handleNoteChange(item.id, e.target.value)}
                              className="w-full border border-slate-200 rounded-md px-2 py-1 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-hidden bg-white text-slate-800 placeholder:text-slate-400 placeholder:italic transition-colors"
                              placeholder="Masukkan catatan surveyor / acceptance..."
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
    </div>
  );
};
