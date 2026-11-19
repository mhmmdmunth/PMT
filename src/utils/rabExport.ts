import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { VesselSpec, ProjectSchedule, WorkCategory, WorkItem } from '../types';
import { TonnageCalculator } from './tonnageCalculator';
import {
  calculateOpnameItemCost,
  calculateRepairItemCost,
  calculateSatisfactionItemCost,
  computeFinancialTotals,
  deriveSatisfactionStatus,
  getEffectiveOpnameQty,
  getEffectiveOpnameWeightKg,
  getEffectiveRepairQty,
  getItemPriceBasis,
  SatisfactionRabStatus,
} from './rabHelpers';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function exportRabOpnameExcel(params: {
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  categories: WorkCategory[];
  opnameItems: WorkItem[];
  repairItems: WorkItem[];
  overheadPercent: number;
  ppnPercent: number;
}): Promise<void> {
  const { vessel, schedule, categories, opnameItems, repairItems, overheadPercent, ppnPercent } = params;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shipyard Docking Management System';
  const ws = wb.addWorksheet('RAB Opname', { pageSetup: { orientation: 'landscape', paperSize: 9 } });

  ws.columns = [
    { header: 'No', key: 'itemNo', width: 10 },
    { header: 'Uraian Pekerjaan', key: 'description', width: 42 },
    { header: 'Vendor / Subcont', key: 'vendor', width: 24 },
    { header: 'Status Opname', key: 'status', width: 18 },
    { header: 'Qty Kontrak', key: 'qtyPlan', width: 12 },
    { header: 'Qty Opname', key: 'qtyOpname', width: 12 },
    { header: 'Satuan', key: 'unit', width: 10 },
    { header: 'Tonase Opname (kg)', key: 'weight', width: 16 },
    { header: 'Basis', key: 'basis', width: 10 },
    { header: 'Tarif Satuan (Rp)', key: 'unitPrice', width: 18 },
    { header: 'Biaya Opname (Rp)', key: 'opnameCost', width: 20 },
    { header: 'Biaya Repair List (Rp)', key: 'repairCost', width: 20 },
    { header: 'Selisih (Rp)', key: 'variance', width: 18 },
  ];

  // Title block
  ws.insertRow(1, [`RINCIAN ANGGARAN BIAYA (RAB) — OPNAME & SUBCONT`]);
  ws.insertRow(2, [`Kapal: ${vessel?.name || '-'} | No. Proyek: ${vessel?.projectNo || '-'} | Owner: ${vessel?.companyOwner || '-'}`]);
  ws.insertRow(3, [`Periode Dok: ${schedule?.dockingDate || '-'} s/d ${schedule?.undockingDate || '-'}`]);
  ws.insertRow(4, []);
  ws.mergeCells('A1:M1');
  ws.mergeCells('A2:M2');
  ws.mergeCells('A3:M3');
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.getRow(2).font = { size: 10 };
  ws.getRow(3).font = { size: 10, color: { argb: 'FF475569' } };

  const headerRow = ws.getRow(5);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  const repairById = new Map(repairItems.map((r) => [r.id, r]));
  const repairByNo = new Map(repairItems.map((r) => [`${r.categoryId}::${r.itemNo}`, r]));

  let totalBaseOpname = 0;
  let totalBaseRepair = 0;

  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  sortedCategories.forEach((cat) => {
    const catItems = opnameItems.filter((i) => i.categoryId === cat.id);
    if (catItems.length === 0) return;

    const catRow = ws.addRow({
      itemNo: cat.code,
      description: cat.name.toUpperCase(),
    });
    catRow.font = { bold: true, color: { argb: 'FF064E3B' } };
    catRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };

    catItems.forEach((item) => {
      const matchedRepair = repairById.get(item.id) || repairByNo.get(`${item.categoryId}::${item.itemNo}`);
      const opCost = calculateOpnameItemCost(item, { excludeRejected: true });
      const repCost = matchedRepair ? calculateRepairItemCost(matchedRepair) : calculateRepairItemCost(item);
      const opQty = getEffectiveOpnameQty(item);
      const opWeight = getEffectiveOpnameWeightKg(item);
      const basis = getItemPriceBasis(item);

      totalBaseOpname += opCost;
      totalBaseRepair += repCost;

      const row = ws.addRow({
        itemNo: item.itemNo,
        description: item.description,
        vendor: item.subcontractor || item.assignedTo || '-',
        status: item.opnameStatus || 'Belum Diperiksa',
        qtyPlan: getEffectiveRepairQty(item),
        qtyOpname: opQty,
        unit: item.unit || '-',
        weight: opWeight,
        basis: basis === 'weight' ? '/ Kg' : `/ ${item.unit || 'Qty'}`,
        unitPrice: item.unitPrice || 0,
        opnameCost: opCost,
        repairCost: repCost,
        variance: opCost - repCost,
      });

      ['J', 'K', 'L', 'M'].forEach((col) => {
        row.getCell(col).numFmt = '#,##0';
      });
      ['E', 'F', 'H'].forEach((col) => {
        row.getCell(col).numFmt = '#,##0.00';
      });
    });
  });

  const totals = computeFinancialTotals(totalBaseOpname, overheadPercent, ppnPercent);
  ws.addRow([]);
  const summaryRows = [
    ['Total Biaya Dasar Opname (DPP)', totalBaseOpname, totalBaseRepair, totalBaseOpname - totalBaseRepair],
    [`Overhead (${overheadPercent}%)`, totals.overheadCost, '', ''],
    [`PPN (${ppnPercent}%)`, totals.ppnTaxCost, '', ''],
    ['GRAND TOTAL RAB OPNAME', totals.grandTotalCost, '', ''],
  ];
  summaryRows.forEach(([label, val, repVal, diffVal], idx) => {
    const r = ws.addRow({
      description: label,
      opnameCost: val,
      repairCost: repVal,
      variance: diffVal,
    });
    r.font = { bold: true };
    if (idx === summaryRows.length - 1) {
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    }
    r.getCell('K').numFmt = '#,##0';
    if (typeof repVal === 'number') r.getCell('L').numFmt = '#,##0';
    if (typeof diffVal === 'number') r.getCell('M').numFmt = '#,##0';
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const safeName = (vessel?.name || 'Kapal').replace(/[^a-zA-Z0-9_-]/g, '_');
  triggerDownload(blob, `RAB_Opname_${safeName}.xlsx`);
}

export async function exportRabOpnamePdf(params: {
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  categories: WorkCategory[];
  opnameItems: WorkItem[];
  repairItems: WorkItem[];
  overheadPercent: number;
  ppnPercent: number;
}): Promise<void> {
  const { vessel, schedule, categories, opnameItems, repairItems, overheadPercent, ppnPercent } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('RINCIAN ANGGARAN BIAYA (RAB) — HASIL OPNAME & SUBCONT', 14, 14);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Kapal: ${vessel?.name || '-'}  |  Proyek: ${vessel?.projectNo || '-'}  |  Owner: ${vessel?.companyOwner || '-'}  |  Docking: ${schedule?.dockingDate || '-'}`,
    14,
    20
  );

  const repairById = new Map(repairItems.map((r) => [r.id, r]));
  const repairByNo = new Map(repairItems.map((r) => [`${r.categoryId}::${r.itemNo}`, r]));

  const bodyRows: any[] = [];
  let totalBaseOpname = 0;

  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  sortedCategories.forEach((cat) => {
    const catItems = opnameItems.filter((i) => i.categoryId === cat.id);
    if (catItems.length === 0) return;

    bodyRows.push([
      {
        content: `${cat.code}. ${cat.name.toUpperCase()}`,
        colSpan: 9,
        styles: { fillColor: [236, 253, 245], textColor: [6, 78, 59], fontStyle: 'bold' },
      },
    ]);

    catItems.forEach((item) => {
      const matchedRepair = repairById.get(item.id) || repairByNo.get(`${item.categoryId}::${item.itemNo}`);
      const opCost = calculateOpnameItemCost(item, { excludeRejected: true });
      const repCost = matchedRepair ? calculateRepairItemCost(matchedRepair) : calculateRepairItemCost(item);
      const opQty = getEffectiveOpnameQty(item);
      totalBaseOpname += opCost;

      bodyRows.push([
        item.itemNo || '-',
        item.description || '-',
        item.subcontractor || item.assignedTo || '-',
        item.opnameStatus || 'Belum Diperiksa',
        `${opQty.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${item.unit || ''}`.trim(),
        getItemPriceBasis(item) === 'weight' ? '/ Kg' : `/ ${item.unit || 'Qty'}`,
        TonnageCalculator.formatRupiah(item.unitPrice || 0),
        TonnageCalculator.formatRupiah(opCost),
        TonnageCalculator.formatRupiah(opCost - repCost),
      ]);
    });
  });

  const totals = computeFinancialTotals(totalBaseOpname, overheadPercent, ppnPercent);

  autoTable(doc, {
    startY: 24,
    head: [['No', 'Uraian Pekerjaan', 'Vendor / Subcont', 'Status', 'Vol. Opname', 'Basis', 'Tarif Satuan', 'Biaya Opname', 'Selisih vs Plan']],
    body: bodyRows,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 16, halign: 'center' },
      4: { halign: 'right' },
      5: { halign: 'center' },
      6: { halign: 'right' },
      7: { halign: 'right', fontStyle: 'bold' },
      8: { halign: 'right' },
    },
  });

  const finalY = (doc as any).lastAutoTable?.finalY || 180;
  const summaryStartY = finalY + 6 > 175 ? (doc.addPage(), 18) : finalY + 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`Base Cost Opname: ${TonnageCalculator.formatRupiah(totals.baseCost)}`, 14, summaryStartY);
  doc.text(`Overhead (${overheadPercent}%): ${TonnageCalculator.formatRupiah(totals.overheadCost)}`, 14, summaryStartY + 5);
  doc.text(`PPN (${ppnPercent}%): ${TonnageCalculator.formatRupiah(totals.ppnTaxCost)}`, 14, summaryStartY + 10);
  doc.text(`GRAND TOTAL RAB OPNAME: ${TonnageCalculator.formatRupiah(totals.grandTotalCost)}`, 14, summaryStartY + 16);

  const safeName = (vessel?.name || 'Kapal').replace(/[^a-zA-Z0-9_-]/g, '_');
  doc.save(`RAB_Opname_${safeName}.pdf`);
}

export async function exportRabSatisfactionExcel(params: {
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  categories: WorkCategory[];
  items: WorkItem[];
  hasOpnameSource: boolean;
  notesMap: Record<string, string>;
  statusMap: Record<string, SatisfactionRabStatus>;
  overheadPercent: number;
  ppnPercent: number;
}): Promise<void> {
  const { vessel, schedule, categories, items, hasOpnameSource, notesMap, statusMap, overheadPercent, ppnPercent } = params;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RAB Satisfaction Note', { pageSetup: { orientation: 'landscape', paperSize: 9 } });

  ws.columns = [
    { header: 'No', key: 'itemNo', width: 10 },
    { header: 'Uraian Pekerjaan', key: 'description', width: 40 },
    { header: 'Status Satisfaction', key: 'satStatus', width: 18 },
    { header: 'Catatan Surveyor / Owner', key: 'satNote', width: 36 },
    { header: 'Vol / Qty', key: 'qty', width: 12 },
    { header: 'Satuan', key: 'unit', width: 10 },
    { header: 'Tonase (kg)', key: 'weight', width: 14 },
    { header: 'Basis', key: 'basis', width: 10 },
    { header: 'Tarif Satuan (Rp)', key: 'unitPrice', width: 18 },
    { header: 'Biaya Satisfaction (Rp)', key: 'total', width: 22 },
  ];

  ws.insertRow(1, [`RINCIAN ANGGARAN BIAYA (RAB) — SATISFACTION NOTE`]);
  ws.insertRow(2, [`Kapal: ${vessel?.name || '-'} | No. Proyek: ${vessel?.projectNo || '-'} | Owner: ${vessel?.companyOwner || '-'}`]);
  ws.insertRow(3, [`Periode Dok: ${schedule?.dockingDate || '-'} s/d ${schedule?.undockingDate || '-'}`]);
  ws.insertRow(4, []);
  ws.mergeCells('A1:J1');
  ws.mergeCells('A2:J2');
  ws.mergeCells('A3:J3');
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.getRow(2).font = { size: 10 };
  ws.getRow(3).font = { size: 10, color: { argb: 'FF475569' } };

  const headerRow = ws.getRow(5);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  let totalBase = 0;
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  sortedCategories.forEach((cat) => {
    const catItems = items.filter((i) => i.categoryId === cat.id);
    if (catItems.length === 0) return;

    const catRow = ws.addRow({ itemNo: cat.code, description: cat.name.toUpperCase() });
    catRow.font = { bold: true, color: { argb: 'FF064E3B' } };
    catRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };

    catItems.forEach((item) => {
      const satStatus = deriveSatisfactionStatus(item, notesMap, statusMap);
      const qty = hasOpnameSource ? getEffectiveOpnameQty(item) : getEffectiveRepairQty(item);
      const weight = hasOpnameSource ? getEffectiveOpnameWeightKg(item) : (item.weightKg || 0);
      const cost = calculateSatisfactionItemCost(item, hasOpnameSource);
      totalBase += cost;

      const row = ws.addRow({
        itemNo: item.itemNo,
        description: item.description,
        satStatus: satStatus === 'Accepted' ? 'Accepted / Satisfied' : satStatus === 'Conditional' ? 'Bersyarat / Catatan' : 'Belum Dinilai',
        satNote: notesMap[item.id] || '-',
        qty,
        unit: item.unit || '-',
        weight,
        basis: getItemPriceBasis(item) === 'weight' ? '/ Kg' : `/ ${item.unit || 'Qty'}`,
        unitPrice: item.unitPrice || 0,
        total: cost,
      });

      ['I', 'J'].forEach((col) => {
        row.getCell(col).numFmt = '#,##0';
      });
      ['E', 'G'].forEach((col) => {
        row.getCell(col).numFmt = '#,##0.00';
      });
    });
  });

  const totals = computeFinancialTotals(totalBase, overheadPercent, ppnPercent);
  ws.addRow([]);
  [
    ['Total Biaya Dasar Satisfaction Note', totalBase],
    [`Overhead (${overheadPercent}%)`, totals.overheadCost],
    [`PPN (${ppnPercent}%)`, totals.ppnTaxCost],
    ['GRAND TOTAL RAB SATISFACTION NOTE', totals.grandTotalCost],
  ].forEach(([label, val], idx) => {
    const r = ws.addRow({ description: label, total: val });
    r.font = { bold: true };
    if (idx === 3) {
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    }
    r.getCell('J').numFmt = '#,##0';
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const safeName = (vessel?.name || 'Kapal').replace(/[^a-zA-Z0-9_-]/g, '_');
  triggerDownload(blob, `RAB_Satisfaction_Note_${safeName}.xlsx`);
}

export async function exportRabSatisfactionPdf(params: {
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  categories: WorkCategory[];
  items: WorkItem[];
  hasOpnameSource: boolean;
  notesMap: Record<string, string>;
  statusMap: Record<string, SatisfactionRabStatus>;
  overheadPercent: number;
  ppnPercent: number;
}): Promise<void> {
  const { vessel, schedule, categories, items, hasOpnameSource, notesMap, statusMap, overheadPercent, ppnPercent } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('RINCIAN ANGGARAN BIAYA (RAB) — SATISFACTION NOTE', 14, 14);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Kapal: ${vessel?.name || '-'}  |  Proyek: ${vessel?.projectNo || '-'}  |  Owner: ${vessel?.companyOwner || '-'}  |  Docking: ${schedule?.dockingDate || '-'}`,
    14,
    20
  );

  const bodyRows: any[] = [];
  let totalBase = 0;
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  sortedCategories.forEach((cat) => {
    const catItems = items.filter((i) => i.categoryId === cat.id);
    if (catItems.length === 0) return;

    bodyRows.push([
      {
        content: `${cat.code}. ${cat.name.toUpperCase()}`,
        colSpan: 8,
        styles: { fillColor: [236, 253, 245], textColor: [6, 78, 59], fontStyle: 'bold' },
      },
    ]);

    catItems.forEach((item) => {
      const satStatus = deriveSatisfactionStatus(item, notesMap, statusMap);
      const qty = hasOpnameSource ? getEffectiveOpnameQty(item) : getEffectiveRepairQty(item);
      const cost = calculateSatisfactionItemCost(item, hasOpnameSource);
      totalBase += cost;

      bodyRows.push([
        item.itemNo || '-',
        item.description || '-',
        satStatus === 'Accepted' ? 'Accepted' : satStatus === 'Conditional' ? 'Bersyarat' : 'Pending',
        notesMap[item.id] || '-',
        `${qty.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${item.unit || ''}`.trim(),
        getItemPriceBasis(item) === 'weight' ? '/ Kg' : `/ ${item.unit || 'Qty'}`,
        TonnageCalculator.formatRupiah(item.unitPrice || 0),
        TonnageCalculator.formatRupiah(cost),
      ]);
    });
  });

  const totals = computeFinancialTotals(totalBase, overheadPercent, ppnPercent);

  autoTable(doc, {
    startY: 24,
    head: [['No', 'Uraian Pekerjaan', 'Status', 'Catatan Satisfaction Note', 'Vol / Qty', 'Basis', 'Tarif Satuan', 'Total Biaya']],
    body: bodyRows,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 16, halign: 'center' },
      4: { halign: 'right' },
      5: { halign: 'center' },
      6: { halign: 'right' },
      7: { halign: 'right', fontStyle: 'bold' },
    },
  });

  const finalY = (doc as any).lastAutoTable?.finalY || 180;
  const summaryStartY = finalY + 6 > 175 ? (doc.addPage(), 18) : finalY + 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`Base Cost Satisfaction Note: ${TonnageCalculator.formatRupiah(totals.baseCost)}`, 14, summaryStartY);
  doc.text(`Overhead (${overheadPercent}%): ${TonnageCalculator.formatRupiah(totals.overheadCost)}`, 14, summaryStartY + 5);
  doc.text(`PPN (${ppnPercent}%): ${TonnageCalculator.formatRupiah(totals.ppnTaxCost)}`, 14, summaryStartY + 10);
  doc.text(`GRAND TOTAL RAB SATISFACTION NOTE: ${TonnageCalculator.formatRupiah(totals.grandTotalCost)}`, 14, summaryStartY + 16);

  const safeName = (vessel?.name || 'Kapal').replace(/[^a-zA-Z0-9_-]/g, '_');
  doc.save(`RAB_Satisfaction_Note_${safeName}.pdf`);
}
