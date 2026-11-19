import { WorkItem } from '../types';
import { TonnageCalculator } from './tonnageCalculator';

export type SatisfactionRabStatus = 'Accepted' | 'Conditional' | 'Pending';

export interface FinancialTotals {
  baseCost: number;
  overheadCost: number;
  costBeforeTax: number;
  ppnTaxCost: number;
  grandTotalCost: number;
}

export function getItemPriceBasis(item: WorkItem): 'qty' | 'weight' {
  if (item.priceBasis) return item.priceBasis;
  if (item.unit === 'kg' && (item.weightKg || 0) > 0) return 'weight';
  return 'qty';
}

export function getEffectiveRepairQty(item: WorkItem): number {
  const unitLower = String(item.unit || '').trim().toLowerCase();
  const isMeterUnit = unitLower === 'm' || unitLower === 'meter';
  let effectiveQty = Number(item.qty) || 0;

  if (isMeterUnit) {
    const dLenNum = parseFloat(String(item.dLen || '0')) || 0;
    const d1Num = parseFloat(String(item.d1 || '0')) || 0;
    const lenMmForCalc = dLenNum > 0 ? dLenNum : d1Num;
    const rawD4 = parseFloat(String(item.d4 || '0'));
    const d4Val = !isNaN(rawD4) && rawD4 > 0 ? rawD4 : 1;
    effectiveQty = Math.round(((lenMmForCalc / 1000) * d4Val) * 1000) / 1000;
  } else {
    const d4Str = String(item.d4 ?? '').trim();
    if (d4Str !== '') {
      const parsedD4 = parseFloat(d4Str);
      if (!isNaN(parsedD4)) {
        effectiveQty = parsedD4;
      }
    }
  }
  return effectiveQty;
}

export function getEffectiveWeightKg(item: WorkItem, effectiveQty?: number): number {
  let weight = Number(item.weightKg) || 0;
  if (weight <= 0 && (item.type || item.d1 || item.d2 || item.d3 || item.dLen || item.d4)) {
    const calcRes = TonnageCalculator.calculateItemTonnageAndPrice({
      typeCode: item.type,
      d1: item.d1,
      d2: item.d2,
      d3: item.d3,
      dLen: item.dLen,
      d4: item.d4,
      qty: effectiveQty ?? item.qty ?? 1,
      unit: item.unit || 'kg',
      unitPrice: item.unitPrice || 0,
      priceBasis: getItemPriceBasis(item),
    });
    if (calcRes.weightKg > 0) {
      weight = calcRes.weightKg;
    }
  }
  return weight;
}

export function calculateRepairItemCost(
  item: WorkItem,
  overrideUnitPrice?: number,
  overrideBasis?: 'qty' | 'weight'
): number {
  const price = overrideUnitPrice !== undefined ? overrideUnitPrice : Number(item.unitPrice) || 0;
  const basis = overrideBasis !== undefined ? overrideBasis : getItemPriceBasis(item);
  const effectiveQty = getEffectiveRepairQty(item);
  const weight = getEffectiveWeightKg(item, effectiveQty);
  const factor = basis === 'weight' ? (weight > 0 ? weight : effectiveQty) : effectiveQty;
  return Math.round(factor * price);
}

export function getEffectiveOpnameQty(item: WorkItem): number {
  if (item.opnameQty !== undefined && item.opnameQty !== null && !isNaN(Number(item.opnameQty))) {
    return Number(item.opnameQty);
  }
  return getEffectiveRepairQty(item);
}

export function getEffectiveOpnameWeightKg(item: WorkItem): number {
  const baseQty = getEffectiveRepairQty(item);
  const opQty = getEffectiveOpnameQty(item);
  const baseWeight = getEffectiveWeightKg(item, baseQty);
  if (baseWeight <= 0) return 0;
  if (baseQty > 0 && opQty !== baseQty) {
    return Math.round(baseWeight * (opQty / baseQty) * 100) / 100;
  }
  return baseWeight;
}

export function calculateOpnameItemCost(
  item: WorkItem,
  options?: { excludeRejected?: boolean; overrideUnitPrice?: number; overrideBasis?: 'qty' | 'weight' }
): number {
  const excludeRejected = options?.excludeRejected ?? true;
  if (excludeRejected && item.opnameStatus === 'Ditolak') {
    return 0;
  }
  const price = options?.overrideUnitPrice !== undefined ? options.overrideUnitPrice : Number(item.unitPrice) || 0;
  const basis = options?.overrideBasis !== undefined ? options.overrideBasis : getItemPriceBasis(item);
  const opQty = getEffectiveOpnameQty(item);
  const opWeight = getEffectiveOpnameWeightKg(item);
  const factor = basis === 'weight' ? (opWeight > 0 ? opWeight : opQty) : opQty;
  return Math.round(factor * price);
}

export function deriveSatisfactionStatus(
  item: WorkItem,
  notesMap: Record<string, string>,
  customStatusMap: Record<string, SatisfactionRabStatus>
): SatisfactionRabStatus {
  const custom = customStatusMap[item.id];
  if (custom) return custom;

  const hasNote = Boolean(notesMap[item.id] && notesMap[item.id].trim().length > 0);
  if (
    item.opnameStatus === 'Terverifikasi' ||
    (item.opnamePercent !== undefined && item.opnamePercent >= 100) ||
    item.isCompleted ||
    hasNote
  ) {
    return 'Accepted';
  }
  if (item.opnameStatus === 'Revisi / Temuan') {
    return 'Conditional';
  }
  return 'Pending';
}

export function calculateSatisfactionItemCost(
  item: WorkItem,
  hasOpnameSource: boolean
): number {
  if (hasOpnameSource) {
    return calculateOpnameItemCost(item, { excludeRejected: true });
  }
  return calculateRepairItemCost(item);
}

export function computeFinancialTotals(
  baseCost: number,
  overheadPercent: number,
  ppnPercent: number
): FinancialTotals {
  const safeBase = Number.isFinite(baseCost) ? baseCost : 0;
  const overheadCost = Math.round((safeBase * overheadPercent) / 100);
  const costBeforeTax = safeBase + overheadCost;
  const ppnTaxCost = Math.round((costBeforeTax * ppnPercent) / 100);
  const grandTotalCost = costBeforeTax + ppnTaxCost;

  return {
    baseCost: safeBase,
    overheadCost,
    costBeforeTax,
    ppnTaxCost,
    grandTotalCost,
  };
}
