import initSqlJs, { Database } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  VesselSpec,
  ProjectSchedule,
  WorkCategory,
  WorkItem,
  DefectSurvey,
  Signatures,
  WorkItemAuditLog,
} from '../types';
import {
  DEFAULT_VESSEL,
  DEFAULT_SCHEDULE,
  DEFAULT_CATEGORIES,
  DEFAULT_WORK_ITEMS,
  DEFAULT_DEFECT_SURVEYS,
  DEFAULT_SIGNATURES,
} from '../data/shipyardSeedData';
import {
  resequenceCategoryItems,
  resequenceAllWorkItems,
  cascadeDeleteWorkItem,
  cascadeDeleteWorkItems,
  addAndResequenceWorkItem,
} from '../utils/numberingUtils';
import { syncWorkItemsProgressHierarchy } from '../utils/hierarchyProgressUtils';
import { verifyDataPersistence } from '../utils/persistenceDiagnostics';
import { authService } from './authService';

const DB_STORAGE_KEY = 'shipyard_sqlite_bin_v1';
const DB_FALLBACK_JSON_KEY = 'shipyard_sqlite_fallback_v1';

/**
 * Robust WebAssembly binary loader for SQL.js.
 * Prioritizes Vite's bundled hashed asset URL (immune to SPA rewrites on Vercel/CDNs),
 * then checks root/relative paths and validates WASM magic bytes.
 */
async function loadSqlWasmBinary(): Promise<ArrayBuffer | null> {
  if (typeof window === 'undefined') return null;

  const currentHref = window.location.href;
  const originUrl = window.location.origin;
  const pathname = window.location.pathname;
  const basePath = pathname.endsWith('/')
    ? pathname
    : pathname.substring(0, pathname.lastIndexOf('/') + 1);

  const resolvedBundledUrl = sqlWasmUrl
    ? new URL(sqlWasmUrl, originUrl).href
    : '';

  const candidateUrls = [
    resolvedBundledUrl,
    sqlWasmUrl,
    new URL('/sql-wasm.wasm', originUrl).href,
    '/sql-wasm.wasm',
    new URL('sql-wasm.wasm', currentHref).href,
    basePath + 'sql-wasm.wasm',
    typeof document !== 'undefined' && document.baseURI ? new URL('sql-wasm.wasm', document.baseURI).href : '',
    './sql-wasm.wasm',
    'sql-wasm.wasm',
  ].filter(Boolean);

  const uniqueUrls = Array.from(new Set(candidateUrls));

  for (const url of uniqueUrls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        continue;
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
        return buffer;
      }
    } catch {
      // Continue to next candidate URL
    }
  }

  return null;
}

/**
 * Ensures all SQL parameter values passed to SQL.js are valid primitives.
 * SQL.js throws "Wrong API use: tried to bind a value of an unknown type ([object Object])"
 * if an object, boolean, or undefined is passed in the params array.
 */
function sanitizeSqlParam(val: any): string | number | Uint8Array | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return Number.isNaN(val) ? 0 : val;
  }
  if (typeof val === 'string') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Uint8Array) return val;
  if (typeof val === 'object') {
    if ('value' in val && (typeof val.value === 'string' || typeof val.value === 'number')) {
      return val.value;
    }
    if ('label' in val && (typeof val.label === 'string' || typeof val.label === 'number')) {
      return val.label;
    }
    if ('name' in val && (typeof val.name === 'string' || typeof val.name === 'number')) {
      return val.name;
    }
    if ('text' in val && (typeof val.text === 'string' || typeof val.text === 'number')) {
      return val.text;
    }
    if ('code' in val && (typeof val.code === 'string' || typeof val.code === 'number')) {
      return val.code;
    }
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

function sanitizeSqlParams(params: any[]): (string | number | Uint8Array | null)[] {
  if (!Array.isArray(params)) return [];
  return params.map(sanitizeSqlParam);
}

class SqliteService {
  private db: Database | any = null;
  private sqlJsInstance: any = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private listeners: Set<() => void> = new Set();
  private isUsingFallback = false;
  private suppressNotify = false;
  public readonly hadLocalDbOnBoot: boolean;

  constructor() {
    this.hadLocalDbOnBoot =
      typeof localStorage !== 'undefined' &&
      Boolean(localStorage.getItem(DB_STORAGE_KEY) || localStorage.getItem(DB_FALLBACK_JSON_KEY));
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flushPersist();
      });
    }
    this.init();
  }

  public isReady(): boolean {
    return this.isInitialized && Boolean(this.db);
  }

  public flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.executePersist();
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const wasmBinary = await loadSqlWasmBinary();
        let SQL: any = null;

        if (wasmBinary) {
          // Pass the verified binary directly to avoid any fetch/MIME issues in browser
          SQL = await initSqlJs({ wasmBinary });
        } else {
          // Secondary attempt using Vite bundled URL or root path
          SQL = await initSqlJs({
            locateFile: (file) =>
              file === 'sql-wasm.wasm' && sqlWasmUrl
                ? sqlWasmUrl
                : new URL(`/${file}`, window.location.origin).href,
          });
        }

        this.sqlJsInstance = SQL;

        // Try to load persisted database binary from localStorage
        let loaded = false;
        const savedBase64 = localStorage.getItem(DB_STORAGE_KEY);
        if (savedBase64) {
          try {
            const binaryString = atob(savedBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            this.db = new SQL.Database(bytes);
            loaded = true;
          } catch (e) {
            console.warn('Failed to load saved SQLite DB binary, reinitializing schema:', e);
          }
        }

        if (!loaded || !this.db) {
          this.db = new SQL.Database();
          this.wrapDatabaseMethods();
          this.createSchema();
          this.seedInitialData();
          this.persist();
        } else {
          // Run schema checks and migrations on existing loaded database
          this.wrapDatabaseMethods();
          this.createSchema();
          this.runMigrations();
          this.persist();
        }

        this.isInitialized = true;
        this.notifyListeners();
      } catch (err) {
        console.warn('SQL.js WASM compilation unavailable, activating in-memory SQLite store:', err);
        this.initInMemoryFallback();
        this.isInitialized = true;
        this.notifyListeners();
      }
    })();

    return this.initPromise;
  }

  private initInMemoryFallback() {
    this.isUsingFallback = true;
    let store = {
      vessel: { ...DEFAULT_VESSEL },
      schedule: { ...DEFAULT_SCHEDULE },
      categories: [...DEFAULT_CATEGORIES],
      workItems: [...DEFAULT_WORK_ITEMS],
      opnameWorkItems: [] as WorkItem[],
      defectSurveys: [...DEFAULT_DEFECT_SURVEYS],
      signatures: { ...DEFAULT_SIGNATURES },
      auditLogs: [] as WorkItemAuditLog[],
    };

    try {
      const saved = localStorage.getItem(DB_FALLBACK_JSON_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        store = {
          ...store,
          ...parsed,
          opnameWorkItems: Array.isArray(parsed.opnameWorkItems) ? parsed.opnameWorkItems : [],
          auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
        };
      }
      // Ensure Category XII. Others and any missing default categories are present
      DEFAULT_CATEGORIES.forEach((defCat) => {
        if (!store.categories.some((c) => c.id === defCat.id || c.code === defCat.code)) {
          store.categories.push({ ...defCat });
        }
      });
    } catch (e) {
      console.warn('Fallback store parse error', e);
    }

    const saveFallback = () => {
      try {
        localStorage.setItem(DB_FALLBACK_JSON_KEY, JSON.stringify(store));
      } catch (e) {
        console.warn('Could not save fallback store to localStorage', e);
      }
    };

    const ALL_WORK_ITEM_COLUMNS = [
      'id',
      'project_id',
      'category_id',
      'item_no',
      'description',
      'type',
      'd1',
      'd2',
      'd3',
      'd_len',
      'd4',
      'qty',
      'unit',
      'weight_kg',
      'unit_price',
      'total_price',
      'remark',
      'remark2',
      'is_completed',
      'notes',
      'parent_id',
      'item_level',
      'is_area_header',
      'progress_percent',
      'progress_qty',
      'progress_notes',
      'progress_date',
      'updated_at',
      'updated_by',
      'updated_by_user_id',
      'updated_action',
      'price_basis',
      'start_date',
      'target_end_date',
      'actual_start_date',
      'actual_end_date',
      'plan_percent',
      'weight_factor',
      'assigned_to',
      'subcontractor',
      'opname_status',
      'opname_qty',
      'opname_percent',
      'opname_date',
      'opname_inspector',
      'opname_notes',
      'opname_bapo_no',
      'daily_logs_json',
      'plan_logs_json',
    ];

    const getWorkItemColValue = (w: WorkItem, col: string): any => {
      switch (col) {
        case 'id': return w.id;
        case 'project_id': return w.projectId || 'proj-f049';
        case 'category_id': return w.categoryId || 'cat-1';
        case 'item_no': return w.itemNo || '';
        case 'description': return w.description || '';
        case 'type': return w.type || '';
        case 'd1': return w.d1 || '';
        case 'd2': return w.d2 || '';
        case 'd3': return w.d3 || '';
        case 'd_len': return w.dLen || '';
        case 'd4': return w.d4 || '';
        case 'qty': return w.qty !== undefined && w.qty !== null && (w.qty as any) !== '' ? Number(w.qty) : 0;
        case 'unit': return w.unit || '';
        case 'weight_kg': return Number(w.weightKg || 0);
        case 'unit_price': return Number(w.unitPrice || 0);
        case 'total_price': return Number(w.totalPrice || 0);
        case 'remark': return w.remark || '';
        case 'remark2': return w.remark2 || '';
        case 'is_completed': return w.isCompleted ? 1 : 0;
        case 'notes': return w.notes || '';
        case 'parent_id': return w.parentId || null;
        case 'item_level': return w.itemLevel !== undefined && w.itemLevel !== null ? w.itemLevel : null;
        case 'is_area_header': return w.isAreaHeader ? 1 : 0;
        case 'progress_percent': return w.progressPercent !== undefined && w.progressPercent !== null ? w.progressPercent : (w.isCompleted ? 100 : 0);
        case 'progress_qty': return w.progressQty !== undefined && w.progressQty !== null ? w.progressQty : null;
        case 'progress_notes': return w.progressNotes || null;
        case 'progress_date': return w.progressDate || null;
        case 'updated_at': return w.updatedAt || null;
        case 'updated_by': return w.updatedBy || null;
        case 'updated_by_user_id': return w.updatedByUserId || null;
        case 'updated_action': return w.updatedAction || null;
        case 'price_basis': return w.priceBasis || null;
        case 'start_date': return w.startDate || null;
        case 'target_end_date': return w.targetEndDate || null;
        case 'actual_start_date': return w.actualStartDate || null;
        case 'actual_end_date': return w.actualEndDate || null;
        case 'plan_percent': return w.planPercent !== undefined && w.planPercent !== null ? w.planPercent : null;
        case 'weight_factor': return w.weightFactor !== undefined && w.weightFactor !== null ? w.weightFactor : null;
        case 'assigned_to': return w.assignedTo || null;
        case 'subcontractor': return w.subcontractor || null;
        case 'opname_status': return w.opnameStatus || null;
        case 'opname_qty': return w.opnameQty !== undefined && w.opnameQty !== null ? w.opnameQty : null;
        case 'opname_percent': return w.opnamePercent !== undefined && w.opnamePercent !== null ? w.opnamePercent : null;
        case 'opname_date': return w.opnameDate || null;
        case 'opname_inspector': return w.opnameInspector || null;
        case 'opname_notes': return w.opnameNotes || null;
        case 'opname_bapo_no': return w.opnameBapoNo || null;
        case 'daily_logs_json': return w.dailyLogs ? JSON.stringify(w.dailyLogs) : null;
        case 'plan_logs_json': return w.planLogs ? JSON.stringify(w.planLogs) : null;
        default: return null;
      }
    };

    const parseJsonSafe = (val: any) => {
      if (!val) return undefined;
      if (typeof val === 'object') return val;
      try {
        return JSON.parse(String(val)) || {};
      } catch {
        return undefined;
      }
    };

    const setWorkItemColValue = (target: WorkItem, col: string, val: any) => {
      switch (col) {
        case 'id': target.id = String(val); break;
        case 'project_id': target.projectId = val ? String(val) : 'proj-f049'; break;
        case 'category_id': target.categoryId = val ? String(val) : 'cat-1'; break;
        case 'item_no': target.itemNo = val !== null && val !== undefined ? String(val) : ''; break;
        case 'description': target.description = val !== null && val !== undefined ? String(val) : ''; break;
        case 'type': target.type = val !== null && val !== undefined ? String(val) : ''; break;
        case 'd1': target.d1 = val !== null && val !== undefined ? String(val) : ''; break;
        case 'd2': target.d2 = val !== null && val !== undefined ? String(val) : ''; break;
        case 'd3': target.d3 = val !== null && val !== undefined ? String(val) : ''; break;
        case 'd_len': target.dLen = val !== null && val !== undefined ? String(val) : ''; break;
        case 'd4': target.d4 = val !== null && val !== undefined ? String(val) : ''; break;
        case 'qty': target.qty = val !== null && val !== undefined && val !== '' ? Number(val) || 0 : 0; break;
        case 'unit': target.unit = val !== null && val !== undefined ? String(val) : ''; break;
        case 'weight_kg': target.weightKg = val !== null && val !== undefined ? Number(val) || 0 : 0; break;
        case 'unit_price': target.unitPrice = val !== null && val !== undefined ? Number(val) || 0 : 0; break;
        case 'total_price': target.totalPrice = val !== null && val !== undefined ? Number(val) || 0 : 0; break;
        case 'remark': target.remark = val !== null && val !== undefined ? String(val) : ''; break;
        case 'remark2': target.remark2 = val !== null && val !== undefined ? String(val) : ''; break;
        case 'is_completed': target.isCompleted = Boolean(val); break;
        case 'notes': target.notes = val !== null && val !== undefined ? String(val) : ''; break;
        case 'parent_id': target.parentId = val ? String(val) : undefined; break;
        case 'item_level': target.itemLevel = val !== null && val !== undefined ? Number(val) as any : undefined; break;
        case 'is_area_header': target.isAreaHeader = Boolean(val); break;
        case 'progress_percent': target.progressPercent = val !== null && val !== undefined ? Number(val) : 0; break;
        case 'progress_qty': target.progressQty = val !== null && val !== undefined ? Number(val) : undefined; break;
        case 'progress_notes': target.progressNotes = val ? String(val) : undefined; break;
        case 'progress_date': target.progressDate = val ? String(val) : undefined; break;
        case 'updated_at': target.updatedAt = val ? String(val) : undefined; break;
        case 'updated_by': target.updatedBy = val ? String(val) : undefined; break;
        case 'updated_by_user_id': target.updatedByUserId = val ? String(val) : undefined; break;
        case 'updated_action': target.updatedAction = val ? (String(val) as any) : undefined; break;
        case 'price_basis': target.priceBasis = val ? (String(val) as any) : undefined; break;
        case 'start_date': target.startDate = val ? String(val) : undefined; break;
        case 'target_end_date': target.targetEndDate = val ? String(val) : undefined; break;
        case 'actual_start_date': target.actualStartDate = val ? String(val) : undefined; break;
        case 'actual_end_date': target.actualEndDate = val ? String(val) : undefined; break;
        case 'plan_percent': target.planPercent = val !== null && val !== undefined ? Number(val) : undefined; break;
        case 'weight_factor': target.weightFactor = val !== null && val !== undefined ? Number(val) : undefined; break;
        case 'assigned_to': target.assignedTo = val ? String(val) : undefined; break;
        case 'subcontractor': target.subcontractor = val ? String(val) : undefined; break;
        case 'opname_status': target.opnameStatus = val ? (String(val) as any) : undefined; break;
        case 'opname_qty': target.opnameQty = val !== null && val !== undefined ? Number(val) : undefined; break;
        case 'opname_percent': target.opnamePercent = val !== null && val !== undefined ? Number(val) : undefined; break;
        case 'opname_date': target.opnameDate = val ? String(val) : undefined; break;
        case 'opname_inspector': target.opnameInspector = val ? String(val) : undefined; break;
        case 'opname_notes': target.opnameNotes = val ? String(val) : undefined; break;
        case 'opname_bapo_no': target.opnameBapoNo = val ? String(val) : undefined; break;
        case 'daily_logs_json': target.dailyLogs = parseJsonSafe(val); break;
        case 'plan_logs_json': target.planLogs = parseJsonSafe(val); break;
      }
    };

    const parseSelectColumns = (sql: string, defaultCols: string[]): string[] => {
      const m = sql.match(/select\s+([\s\S]+?)\s+from\s+/i);
      if (!m || !m[1]) return defaultCols;
      const raw = m[1].trim();
      if (raw === '*') return defaultCols;
      return raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
    };

    const applyInsertWorkItemBySql = (
      list: WorkItem[],
      sql: string,
      params: any[],
      defaultProjectId: string
    ) => {
      const colMatch = sql.match(/\(([^)]+)\)\s*values/i);
      const cols = colMatch
        ? colMatch[1].split(',').map((c) => c.trim().toLowerCase())
        : ALL_WORK_ITEM_COLUMNS;

      const item: WorkItem = {
        id: '',
        projectId: defaultProjectId,
        categoryId: 'cat-1',
        itemNo: '',
        description: '',
        qty: 0,
        unit: '',
        unitPrice: 0,
        totalPrice: 0,
      };
      cols.forEach((col, i) => {
        if (i < params.length) {
          setWorkItemColValue(item, col, params[i]);
        }
      });
      if (!item.assignedTo && item.subcontractor) item.assignedTo = item.subcontractor;
      if (!item.subcontractor && item.assignedTo) item.subcontractor = item.assignedTo;

      const idx = list.findIndex((w) => w.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
    };

    const applyUpdateWorkItemBySql = (
      list: WorkItem[],
      sql: string,
      params: any[]
    ) => {
      const setMatch = sql.match(/\bset\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i);
      if (!setMatch) return;
      const setClause = setMatch[1];
      const whereClause = setMatch[2] || '';

      const assignments = setClause.split(',').map((part) => part.trim()).filter(Boolean);
      let paramIdx = 0;
      const updates: Array<{ col: string; val: any }> = [];

      assignments.forEach((assign) => {
        const eqIdx = assign.indexOf('=');
        if (eqIdx === -1) return;
        const col = assign.slice(0, eqIdx).trim().toLowerCase();
        const rhs = assign.slice(eqIdx + 1).trim();
        let val: any;
        if (rhs === '?') {
          val = params[paramIdx++];
        } else if (rhs.toLowerCase() === 'null') {
          val = null;
        } else if (/^'.*'$/.test(rhs)) {
          val = rhs.slice(1, -1);
        } else if (!isNaN(Number(rhs))) {
          val = Number(rhs);
        } else {
          val = rhs;
        }
        updates.push({ col, val });
      });

      const hasWhereIdParam = /\bid\s*=\s*\?/i.test(whereClause);
      if (hasWhereIdParam) {
        const targetId = params[paramIdx] !== undefined ? params[paramIdx] : params[params.length - 1];
        const idx = list.findIndex((w) => w.id === targetId);
        if (idx >= 0) {
          const cloned = { ...list[idx] };
          updates.forEach(({ col, val }) => setWorkItemColValue(cloned, col, val));
          list[idx] = cloned;
        }
      } else if (!whereClause.trim()) {
        // Bulk update (e.g. resetPlanAndProgress)
        list.forEach((row, i) => {
          const cloned = { ...row };
          updates.forEach(({ col, val }) => setWorkItemColValue(cloned, col, val));
          list[i] = cloned;
        });
      }
    };

    this.db = {
      run: (sql: string, params: any[] = []) => {
        const s = sql.trim().toLowerCase();
        if (s.startsWith('update vessels')) {
          store.vessel = {
            id: params[9] || store.vessel.id,
            name: params[0] ?? store.vessel.name,
            dimension: params[1] ?? store.vessel.dimension,
            vesselType: params[2] ?? store.vessel.vesselType,
            dockingType: params[3] ?? store.vessel.dockingType,
            companyOwner: params[4] ?? store.vessel.companyOwner,
            projectNo: params[5] ?? store.vessel.projectNo,
            classification: params[6] ?? store.vessel.classification,
            kindOfSurvey: params[7] ?? store.vessel.kindOfSurvey,
            photoUrl: params[8] ?? store.vessel.photoUrl,
          };
        } else if (s.startsWith('insert into vessels') || s.startsWith('insert or replace into vessels')) {
          store.vessel = {
            id: params[0] || store.vessel.id,
            name: params[1] ?? store.vessel.name,
            dimension: params[2] ?? store.vessel.dimension,
            vesselType: params[3] ?? store.vessel.vesselType,
            dockingType: params[4] ?? store.vessel.dockingType,
            companyOwner: params[5] ?? store.vessel.companyOwner,
            projectNo: params[6] ?? store.vessel.projectNo,
            classification: params[7] ?? store.vessel.classification,
            kindOfSurvey: params[8] ?? store.vessel.kindOfSurvey,
            photoUrl: params[9] ?? store.vessel.photoUrl,
          };
        } else if (s.startsWith('delete from vessels')) {
          store.vessel = { ...DEFAULT_VESSEL };
        } else if (s.startsWith('update projects')) {
          store.schedule = {
            id: params[10] || store.schedule.id,
            vesselId: store.schedule.vesselId,
            arriveBgn: params[0] ?? store.schedule.arriveBgn,
            startContract: params[1] ?? store.schedule.startContract,
            arrivalMeeting: params[2] ?? store.schedule.arrivalMeeting,
            dockingDate: params[3] ?? store.schedule.dockingDate,
            undockingDate: params[4] ?? store.schedule.undockingDate,
            finishWork: params[5] ?? store.schedule.finishWork,
            sailOut: params[6] ?? store.schedule.sailOut,
            dockingPosition: params[7] ?? store.schedule.dockingPosition,
            dockingDurationDays: Number(params[8] ?? store.schedule.dockingDurationDays),
            status: params[9] ?? store.schedule.status,
          };
        } else if (s.startsWith('insert into projects') || s.startsWith('insert or replace into projects')) {
          store.schedule = {
            id: params[0] || store.schedule.id,
            vesselId: params[1] ?? store.schedule.vesselId,
            arriveBgn: params[2] ?? store.schedule.arriveBgn,
            startContract: params[3] ?? store.schedule.startContract,
            arrivalMeeting: params[4] ?? store.schedule.arrivalMeeting,
            dockingDate: params[5] ?? store.schedule.dockingDate,
            undockingDate: params[6] ?? store.schedule.undockingDate,
            finishWork: params[7] ?? store.schedule.finishWork,
            sailOut: params[8] ?? store.schedule.sailOut,
            dockingPosition: params[9] ?? store.schedule.dockingPosition,
            dockingDurationDays: Number(params[10] ?? store.schedule.dockingDurationDays),
            status: (params[11] as any) ?? store.schedule.status,
            actualStartContract: params[12] ? String(params[12]) : store.schedule.actualStartContract,
            actualDockingDate: params[13] ? String(params[13]) : store.schedule.actualDockingDate,
            actualUndockingDate: params[14] ? String(params[14]) : store.schedule.actualUndockingDate,
            actualFinishWork: params[15] ? String(params[15]) : store.schedule.actualFinishWork,
            actualSailOut: params[16] ? String(params[16]) : store.schedule.actualSailOut,
          };
        } else if (s.startsWith('delete from projects')) {
          store.schedule = { ...DEFAULT_SCHEDULE };
        } else if (s.startsWith('insert into work_categories') || s.startsWith('insert or replace into work_categories') || s.startsWith('insert or ignore into work_categories')) {
          const cat = {
            id: String(params[0]),
            code: String(params[1]),
            name: String(params[2]),
            sortOrder: Number(params[3] || 0),
          };
          const idx = store.categories.findIndex((c) => c.id === cat.id);
          if (idx >= 0) {
            if (!s.startsWith('insert or ignore')) store.categories[idx] = cat;
          } else {
            store.categories.push(cat);
          }
        } else if (s.startsWith('delete from work_categories')) {
          store.categories = [];
        } else if (s.startsWith('insert into work_items') || s.startsWith('insert or replace into work_items')) {
          applyInsertWorkItemBySql(store.workItems, sql, params, store.schedule.id || 'proj-f049');
        } else if (s.startsWith('update work_items set')) {
          applyUpdateWorkItemBySql(store.workItems, sql, params);
        } else if (s.startsWith('insert into opname_work_items') || s.startsWith('insert or replace into opname_work_items')) {
          applyInsertWorkItemBySql(store.opnameWorkItems, sql, params, store.schedule.id || 'proj-f049');
        } else if (s.startsWith('update opname_work_items set')) {
          applyUpdateWorkItemBySql(store.opnameWorkItems, sql, params);
        } else if (s.startsWith('delete from opname_work_items')) {
          if (params && params.length > 0 && params[0]) {
            const id = params[0];
            store.opnameWorkItems = store.opnameWorkItems.filter((w) => w.id !== id);
          } else {
            store.opnameWorkItems = [];
          }
        } else if (s.startsWith('delete from work_items')) {
          if (params && params.length > 0 && params[0]) {
            const id = params[0];
            store.workItems = store.workItems.filter((w) => w.id !== id);
          } else {
            store.workItems = [];
          }
        } else if (s.startsWith('insert into work_item_audit_logs')) {
          const logItem: WorkItemAuditLog = {
            id: String(params[0] || `audit-${Date.now()}`),
            projectId: params[1] ? String(params[1]) : undefined,
            workItemId: String(params[2]),
            itemNo: String(params[3]),
            description: String(params[4]),
            action: String(params[5]) as any,
            changedBy: String(params[6]),
            changedByRole: params[7] ? String(params[7]) : undefined,
            changedByUserId: params[8] ? String(params[8]) : undefined,
            timestamp: String(params[9] || new Date().toISOString()),
            details: params[10] ? String(params[10]) : undefined,
            changesJson: params[11] ? String(params[11]) : undefined,
          };
          store.auditLogs.unshift(logItem);
        } else if (s.startsWith('delete from work_item_audit_logs')) {
          if (params.length > 0 && params[0]) {
            store.auditLogs = store.auditLogs.filter((l) => l.workItemId !== params[0]);
          } else {
            store.auditLogs = [];
          }
        } else if (s.startsWith('insert into defect_surveys') || s.startsWith('insert or replace into defect_surveys')) {
          const surv: DefectSurvey = {
            id: String(params[0]),
            projectId: String(params[1]),
            locationZone: String(params[2]),
            defectDescription: String(params[3]),
            length: Number(params[4] || 0),
            width: Number(params[5] || 0),
            thickness: Number(params[6] || 0),
            plateType: String(params[7] || ''),
            calculatedWeightKg: Number(params[8] || 0),
            syncStatus: Number(params[9] || 0),
            createdAt: String(params[10] || ''),
            transferredToWorkItemId: String(params[11] || ''),
            remedyAction: String(params[12] || ''),
          };
          const idx = store.defectSurveys.findIndex((d) => d.id === surv.id);
          if (idx >= 0) store.defectSurveys[idx] = surv;
          else store.defectSurveys.unshift(surv);
        } else if (s.startsWith('update defect_surveys set location_zone')) {
          const targetId = params[params.length - 1];
          const idx = store.defectSurveys.findIndex((d) => d.id === targetId);
          if (idx >= 0) {
            store.defectSurveys[idx] = {
              ...store.defectSurveys[idx],
              locationZone: String(params[0]),
              defectDescription: String(params[1]),
              length: Number(params[2] || 0),
              width: Number(params[3] || 0),
              thickness: Number(params[4] || 0),
              plateType: String(params[5] || ''),
              calculatedWeightKg: Number(params[6] || 0),
              syncStatus: Number(params[7] || 0),
              remedyAction: String(params[8] || ''),
            };
          }
        } else if (s.startsWith('update defect_surveys set sync_status = 1')) {
          store.defectSurveys.forEach((d) => {
            d.syncStatus = 1;
          });
        } else if (s.startsWith('update defect_surveys set transferred_to_work_item_id')) {
          const workItemId = params[0];
          const surveyId = params[1];
          const item = store.defectSurveys.find((d) => d.id === surveyId);
          if (item) item.transferredToWorkItemId = workItemId;
        } else if (s.startsWith('delete from defect_surveys')) {
          if (params && params.length > 0 && params[0]) {
            const id = params[0];
            store.defectSurveys = store.defectSurveys.filter((d) => d.id !== id);
          } else {
            store.defectSurveys = [];
          }
        } else if (s.startsWith('update signatures') || s.startsWith('insert into signatures') || s.startsWith('insert or replace into signatures')) {
          store.signatures = {
            preparedByName: String(params[0] ?? store.signatures.preparedByName),
            preparedByTitle: String(params[1] ?? store.signatures.preparedByTitle),
            reviewedByName: String(params[2] ?? store.signatures.reviewedByName),
            reviewedByTitle: String(params[3] ?? store.signatures.reviewedByTitle),
            verifiedByName: String(params[4] ?? store.signatures.verifiedByName),
            verifiedByTitle: String(params[5] ?? store.signatures.verifiedByTitle),
          };
        } else if (s.includes('drop table')) {
          store.vessel = { ...DEFAULT_VESSEL };
          store.schedule = { ...DEFAULT_SCHEDULE };
          store.categories = [...DEFAULT_CATEGORIES];
          store.workItems = [...DEFAULT_WORK_ITEMS];
          store.opnameWorkItems = [];
          store.defectSurveys = [...DEFAULT_DEFECT_SURVEYS];
          store.signatures = { ...DEFAULT_SIGNATURES };
        }
        saveFallback();
      },
      exec: (sql: string) => {
        const s = sql.trim().toLowerCase();
        if (s.includes('from vessels')) {
          const v = store.vessel;
          return [{
            columns: ['id', 'name', 'dimension', 'vessel_type', 'docking_type', 'company_owner', 'project_no', 'classification', 'kind_of_survey', 'photo_url'],
            values: [[v.id, v.name, v.dimension, v.vesselType, v.dockingType, v.companyOwner, v.projectNo, v.classification, v.kindOfSurvey, v.photoUrl || '']],
          }];
        }
        if (s.includes('from projects')) {
          const p = store.schedule;
          return [{
            columns: [
              'id', 'vessel_id', 'arrive_bgn', 'start_contract', 'arrival_meeting',
              'docking_date', 'undocking_date', 'finish_work', 'sail_out',
              'docking_position', 'docking_duration_days', 'status',
              'actual_start_contract', 'actual_docking_date', 'actual_undocking_date',
              'actual_finish_work', 'actual_sail_out',
            ],
            values: [[
              p.id, p.vesselId, p.arriveBgn, p.startContract, p.arrivalMeeting,
              p.dockingDate, p.undockingDate, p.finishWork, p.sailOut,
              p.dockingPosition, p.dockingDurationDays, p.status,
              p.actualStartContract || '', p.actualDockingDate || '', p.actualUndockingDate || '',
              p.actualFinishWork || '', p.actualSailOut || '',
            ]],
          }];
        }
        if (s.includes('from work_categories')) {
          return [{
            columns: ['id', 'code', 'name', 'sort_order'],
            values: store.categories.map((c) => [c.id, c.code, c.name, c.sortOrder]),
          }];
        }
        if (s.includes('from opname_work_items')) {
          const cols = parseSelectColumns(sql, ALL_WORK_ITEM_COLUMNS);
          return [{
            columns: cols,
            values: store.opnameWorkItems.map((w) => cols.map((col) => getWorkItemColValue(w, col))),
          }];
        }
        if (s.includes('from work_items')) {
          const cols = parseSelectColumns(sql, ALL_WORK_ITEM_COLUMNS);
          return [{
            columns: cols,
            values: store.workItems.map((w) => cols.map((col) => getWorkItemColValue(w, col))),
          }];
        }
        if (s.includes('from defect_surveys')) {
          return [{
            columns: ['id', 'project_id', 'location_zone', 'defect_description', 'length', 'width', 'thickness', 'plate_type', 'calculated_weight_kg', 'sync_status', 'created_at', 'transferred_to_work_item_id', 'remedy_action'],
            values: store.defectSurveys.map((d) => [
              d.id, d.projectId, d.locationZone, d.defectDescription, d.length, d.width, d.thickness, d.plateType,
              d.calculatedWeightKg, d.syncStatus, d.createdAt, d.transferredToWorkItemId, d.remedyAction,
            ]),
          }];
        }
        if (s.includes('from signatures')) {
          const sig = store.signatures;
          return [{
            columns: ['prepared_by_name', 'prepared_by_title', 'reviewed_by_name', 'reviewed_by_title', 'verified_by_name', 'verified_by_title'],
            values: [[sig.preparedByName, sig.preparedByTitle, sig.reviewedByName, sig.reviewedByTitle, sig.verifiedByName, sig.verifiedByTitle]],
          }];
        }
        if (s.includes('from work_item_audit_logs')) {
          let list = [...store.auditLogs];
          const match = s.match(/work_item_id\s*=\s*['"]?([^'"]+)['"]?/i);
          if (match && match[1]) {
            list = list.filter((l) => l.workItemId === match[1]);
          }
          return [{
            columns: [
              'id',
              'project_id',
              'work_item_id',
              'item_no',
              'description',
              'action',
              'changed_by',
              'changed_by_role',
              'changed_by_user_id',
              'timestamp',
              'details',
              'changes_json',
            ],
            values: list.map((l) => [
              l.id,
              l.projectId || null,
              l.workItemId,
              l.itemNo,
              l.description,
              l.action,
              l.changedBy,
              l.changedByRole || null,
              l.changedByUserId || null,
              l.timestamp,
              l.details || null,
              l.changesJson || null,
            ]),
          }];
        }
        return [];
      },
      prepare: (sql: string) => {
        return {
          run: (params: any[] = []) => {
            this.db.run(sql, params);
          },
          free: () => {},
        };
      },
      export: () => {
        const str = JSON.stringify(store);
        const encoder = new TextEncoder();
        return encoder.encode(str);
      },
    };
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners() {
    if (this.suppressNotify) return;
    this.listeners.forEach((cb) => cb());
  }

  private persistTimer: any = null;

  private persist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.executePersist();
    }, 1000);
  }

  private executePersist() {
    if (!this.db || typeof this.db.export !== 'function') return;
    console.log('Persisting SQLite database to localStorage...');
    try {
      let data = this.db.export();
      let bytes = new Uint8Array(data);
      let binary = '';
      const CHUNK_SIZE = 0x8000; // 32KB chunk
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE) as any);
      }
      let base64 = btoa(binary);

      try {
        localStorage.setItem(DB_STORAGE_KEY, base64);
      } catch (errQuota) {
        // Run SQLite VACUUM to reclaim free pages and shrink binary size before retry
        try {
          this.db.run('VACUUM;');
          data = this.db.export();
          bytes = new Uint8Array(data);
          binary = '';
          for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE) as any);
          }
          base64 = btoa(binary);
          localStorage.setItem(DB_STORAGE_KEY, base64);
        } catch (errVacuum) {
          console.warn('SQLite binary exceeds localStorage quota, using memory session store:', errVacuum);
        }
      }
    } catch (e) {
      console.warn('Could not persist SQLite binary to storage:', e);
    }
  }

  private wrapDatabaseMethods() {
    if (!this.db || this.isUsingFallback) return;

    if (typeof this.db.run === 'function') {
      const originalRun = this.db.run.bind(this.db);
      this.db.run = (sql: string, params?: any[]) => {
        const cleanParams = params ? sanitizeSqlParams(params) : undefined;
        return originalRun(sql, cleanParams);
      };
    }

    if (typeof this.db.prepare === 'function') {
      const originalPrepare = this.db.prepare.bind(this.db);
      this.db.prepare = (sql: string, params?: any[]) => {
        const stmt = originalPrepare(sql, params ? sanitizeSqlParams(params) : undefined);
        if (stmt) {
          if (typeof stmt.run === 'function') {
            const origStmtRun = stmt.run.bind(stmt);
            stmt.run = (stmtParams?: any[]) => {
              const cleanStmtParams = stmtParams ? sanitizeSqlParams(stmtParams) : undefined;
              return origStmtRun(cleanStmtParams);
            };
          }
          if (typeof stmt.bind === 'function') {
            const origStmtBind = stmt.bind.bind(stmt);
            stmt.bind = (bindParams?: any[]) => {
              const cleanBindParams = bindParams ? sanitizeSqlParams(bindParams) : undefined;
              return origStmtBind(cleanBindParams);
            };
          }
        }
        return stmt;
      };
    }
  }

  private createSchema() {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS vessels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dimension TEXT,
        vessel_type TEXT,
        docking_type TEXT,
        company_owner TEXT,
        project_no TEXT,
        classification TEXT,
        kind_of_survey TEXT,
        photo_url TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        vessel_id TEXT,
        arrive_bgn TEXT,
        start_contract TEXT,
        arrival_meeting TEXT,
        docking_date TEXT,
        undocking_date TEXT,
        finish_work TEXT,
        sail_out TEXT,
        docking_position TEXT,
        docking_duration_days INTEGER,
        status TEXT,
        actual_start_contract TEXT,
        actual_docking_date TEXT,
        actual_undocking_date TEXT,
        actual_finish_work TEXT,
        actual_sail_out TEXT
      );

      CREATE TABLE IF NOT EXISTS work_categories (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        category_id TEXT,
        item_no TEXT,
        description TEXT NOT NULL,
        type TEXT,
        d1 TEXT,
        d2 TEXT,
        d3 TEXT,
        d_len TEXT,
        d4 TEXT,
        qty REAL,
        unit TEXT,
        weight_kg REAL,
        unit_price REAL,
        total_price REAL,
        remark TEXT,
        remark2 TEXT,
        is_completed INTEGER DEFAULT 0,
        notes TEXT,
        parent_id TEXT,
        item_level INTEGER DEFAULT 0,
        is_area_header INTEGER DEFAULT 0,
        progress_percent REAL DEFAULT 0,
        progress_qty REAL DEFAULT 0,
        progress_notes TEXT,
        progress_date TEXT,
        start_date TEXT,
        target_end_date TEXT,
        actual_start_date TEXT,
        actual_end_date TEXT,
        plan_percent REAL,
        weight_factor REAL,
        assigned_to TEXT,
        subcontractor TEXT,
        opname_status TEXT,
        opname_qty REAL,
        opname_percent REAL,
        opname_date TEXT,
        opname_inspector TEXT,
        opname_notes TEXT,
        opname_bapo_no TEXT,
        updated_at TEXT,
        updated_by TEXT,
        updated_by_user_id TEXT,
        updated_action TEXT,
        price_basis TEXT,
        daily_logs_json TEXT,
        plan_logs_json TEXT
      );

      CREATE TABLE IF NOT EXISTS opname_work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        category_id TEXT,
        item_no TEXT,
        description TEXT NOT NULL,
        type TEXT,
        d1 TEXT,
        d2 TEXT,
        d3 TEXT,
        d_len TEXT,
        d4 TEXT,
        qty REAL,
        unit TEXT,
        weight_kg REAL,
        unit_price REAL,
        total_price REAL,
        remark TEXT,
        remark2 TEXT,
        is_completed INTEGER DEFAULT 0,
        notes TEXT,
        parent_id TEXT,
        item_level INTEGER DEFAULT 0,
        is_area_header INTEGER DEFAULT 0,
        progress_percent REAL DEFAULT 0,
        progress_qty REAL DEFAULT 0,
        progress_notes TEXT,
        progress_date TEXT,
        start_date TEXT,
        target_end_date TEXT,
        actual_end_date TEXT,
        plan_percent REAL,
        weight_factor REAL,
        assigned_to TEXT,
        subcontractor TEXT,
        opname_status TEXT,
        opname_qty REAL,
        opname_percent REAL,
        opname_date TEXT,
        opname_inspector TEXT,
        opname_notes TEXT,
        opname_bapo_no TEXT,
        updated_at TEXT,
        updated_by TEXT,
        updated_by_user_id TEXT,
        updated_action TEXT,
        price_basis TEXT,
        actual_start_date TEXT,
        daily_logs_json TEXT,
        plan_logs_json TEXT
      );

      CREATE TABLE IF NOT EXISTS work_item_audit_logs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        work_item_id TEXT NOT NULL,
        item_no TEXT,
        description TEXT,
        action TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        changed_by_role TEXT,
        changed_by_user_id TEXT,
        timestamp TEXT NOT NULL,
        details TEXT,
        changes_json TEXT
      );

      CREATE TABLE IF NOT EXISTS defect_surveys (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        location_zone TEXT NOT NULL,
        defect_description TEXT NOT NULL,
        length REAL,
        width REAL,
        thickness REAL,
        plate_type TEXT,
        calculated_weight_kg REAL,
        sync_status INTEGER DEFAULT 0,
        created_at TEXT,
        transferred_to_work_item_id TEXT,
        remedy_action TEXT
      );

      CREATE TABLE IF NOT EXISTS signatures (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        prepared_by_name TEXT,
        prepared_by_title TEXT,
        reviewed_by_name TEXT,
        reviewed_by_title TEXT,
        verified_by_name TEXT,
        verified_by_title TEXT
      );
    `);

    this.runMigrations();
  }

  private runMigrations() {
    if (!this.db) return;
    try {
      this.db.run('ALTER TABLE vessels ADD COLUMN photo_url TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN parent_id TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN item_level INTEGER DEFAULT 0;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN is_area_header INTEGER DEFAULT 0;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN progress_percent REAL DEFAULT 0;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN progress_qty REAL DEFAULT 0;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN progress_notes TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN progress_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN d_len TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN updated_at TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN updated_by TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN updated_by_user_id TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN updated_action TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN price_basis TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN daily_logs_json TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN plan_logs_json TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN start_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN target_end_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN actual_end_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN plan_percent REAL;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN weight_factor REAL;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN assigned_to TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN subcontractor TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_status TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_qty REAL;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_percent REAL;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_inspector TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_notes TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE work_items ADD COLUMN opname_bapo_no TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE opname_work_items ADD COLUMN d_len TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE opname_work_items ADD COLUMN actual_start_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE opname_work_items ADD COLUMN daily_logs_json TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE opname_work_items ADD COLUMN plan_logs_json TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE projects ADD COLUMN actual_start_contract TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE projects ADD COLUMN actual_docking_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE projects ADD COLUMN actual_undocking_date TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE projects ADD COLUMN actual_finish_work TEXT;');
    } catch {}
    try {
      this.db.run('ALTER TABLE projects ADD COLUMN actual_sail_out TEXT;');
    } catch {}
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS work_item_audit_logs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          work_item_id TEXT NOT NULL,
          item_no TEXT,
          description TEXT,
          action TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          changed_by_role TEXT,
          changed_by_user_id TEXT,
          timestamp TEXT NOT NULL,
          details TEXT,
          changes_json TEXT
        );
      `);
    } catch {}

    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS opname_work_items (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          category_id TEXT,
          item_no TEXT,
          description TEXT NOT NULL,
          type TEXT,
          d1 TEXT,
          d2 TEXT,
          d3 TEXT,
          d_len TEXT,
          d4 TEXT,
          qty REAL,
          unit TEXT,
          weight_kg REAL,
          unit_price REAL,
          total_price REAL,
          remark TEXT,
          remark2 TEXT,
          is_completed INTEGER DEFAULT 0,
          notes TEXT,
          parent_id TEXT,
          item_level INTEGER DEFAULT 0,
          is_area_header INTEGER DEFAULT 0,
          progress_percent REAL DEFAULT 0,
          progress_qty REAL DEFAULT 0,
          progress_notes TEXT,
          progress_date TEXT,
          start_date TEXT,
          target_end_date TEXT,
          actual_end_date TEXT,
          plan_percent REAL,
          weight_factor REAL,
          assigned_to TEXT,
          subcontractor TEXT,
          opname_status TEXT,
          opname_qty REAL,
          opname_percent REAL,
          opname_date TEXT,
          opname_inspector TEXT,
          opname_notes TEXT,
          opname_bapo_no TEXT,
          updated_at TEXT,
          updated_by TEXT,
          updated_by_user_id TEXT,
          updated_action TEXT,
          price_basis TEXT
        );
      `);
    } catch {}

    // Ensure all default categories (including XII. Others) are seeded into work_categories
    try {
      for (const cat of DEFAULT_CATEGORIES) {
        this.db.run(
          `INSERT OR IGNORE INTO work_categories (id, code, name, sort_order) VALUES (?, ?, ?, ?)`,
          [cat.id, cat.code, cat.name, cat.sortOrder]
        );
      }
    } catch (err) {
      console.warn('work_categories migration error:', err);
    }
  }

  private seedInitialData() {
    if (!this.db) return;

    // Seed Vessel
    const stmtVessel = this.db.prepare(`
      INSERT OR REPLACE INTO vessels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmtVessel.run([
      DEFAULT_VESSEL.id,
      DEFAULT_VESSEL.name,
      DEFAULT_VESSEL.dimension,
      DEFAULT_VESSEL.vesselType,
      DEFAULT_VESSEL.dockingType,
      DEFAULT_VESSEL.companyOwner,
      DEFAULT_VESSEL.projectNo,
      DEFAULT_VESSEL.classification,
      DEFAULT_VESSEL.kindOfSurvey,
      DEFAULT_VESSEL.photoUrl || '',
    ]);
    stmtVessel.free();

    // Seed Project Schedule
    const stmtProj = this.db.prepare(`
      INSERT OR REPLACE INTO projects (
        id, vessel_id, arrive_bgn, start_contract, arrival_meeting,
        docking_date, undocking_date, finish_work, sail_out,
        docking_position, docking_duration_days, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmtProj.run([
      DEFAULT_SCHEDULE.id,
      DEFAULT_SCHEDULE.vesselId,
      DEFAULT_SCHEDULE.arriveBgn,
      DEFAULT_SCHEDULE.startContract,
      DEFAULT_SCHEDULE.arrivalMeeting,
      DEFAULT_SCHEDULE.dockingDate,
      DEFAULT_SCHEDULE.undockingDate,
      DEFAULT_SCHEDULE.finishWork,
      DEFAULT_SCHEDULE.sailOut,
      DEFAULT_SCHEDULE.dockingPosition,
      DEFAULT_SCHEDULE.dockingDurationDays,
      DEFAULT_SCHEDULE.status,
    ]);
    stmtProj.free();

    // Seed Categories
    const stmtCat = this.db.prepare(`
      INSERT OR REPLACE INTO work_categories VALUES (?, ?, ?, ?)
    `);
    for (const cat of DEFAULT_CATEGORIES) {
      stmtCat.run([cat.id, cat.code, cat.name, cat.sortOrder]);
    }
    stmtCat.free();

    // Seed Work Items
    const stmtItem = this.db.prepare(`
      INSERT OR REPLACE INTO work_items (
        id, project_id, category_id, item_no, description, type,
        d1, d2, d3, d_len, d4, qty, unit, weight_kg, unit_price,
        total_price, remark, remark2, is_completed, notes,
        parent_id, item_level, is_area_header,
        progress_percent, progress_qty, progress_notes, progress_date,
        price_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of DEFAULT_WORK_ITEMS) {
      stmtItem.run([
        item.id,
        item.projectId,
        item.categoryId,
        item.itemNo,
        item.description,
        item.type || '',
        item.d1 || '',
        item.d2 || '',
        item.d3 || '',
        item.dLen || '',
        item.d4 || '',
        item.qty,
        item.unit,
        item.weightKg || 0,
        item.unitPrice,
        item.totalPrice,
        item.remark || '',
        item.remark2 || '',
        item.isCompleted ? 1 : 0,
        item.notes || '',
        item.parentId || null,
        item.itemLevel !== undefined ? item.itemLevel : null,
        item.isAreaHeader ? 1 : 0,
        item.progressPercent !== undefined ? item.progressPercent : (item.isCompleted ? 100 : 0),
        item.progressQty !== undefined ? item.progressQty : (item.isCompleted ? item.qty : 0),
        item.progressNotes || '',
        item.progressDate || '',
        item.priceBasis || null,
      ]);
    }
    stmtItem.free();

    // Seed Defect Surveys
    const stmtSurv = this.db.prepare(`
      INSERT OR REPLACE INTO defect_surveys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const surv of DEFAULT_DEFECT_SURVEYS) {
      stmtSurv.run([
        surv.id,
        surv.projectId,
        surv.locationZone,
        surv.defectDescription,
        surv.length,
        surv.width,
        surv.thickness,
        surv.plateType || 'Mild Steel BKI Grade A',
        surv.calculatedWeightKg,
        surv.syncStatus,
        surv.createdAt,
        surv.transferredToWorkItemId || '',
        surv.remedyAction || '',
      ]);
    }
    stmtSurv.free();

    // Seed Signatures
    const stmtSig = this.db.prepare(`
      INSERT OR REPLACE INTO signatures VALUES (1, ?, ?, ?, ?, ?, ?)
    `);
    stmtSig.run([
      DEFAULT_SIGNATURES.preparedByName,
      DEFAULT_SIGNATURES.preparedByTitle,
      DEFAULT_SIGNATURES.reviewedByName,
      DEFAULT_SIGNATURES.reviewedByTitle,
      DEFAULT_SIGNATURES.verifiedByName,
      DEFAULT_SIGNATURES.verifiedByTitle,
    ]);
    stmtSig.free();
  }

  // --- QUERY & DATA ACCESS METHODS ---

  public getVessel(): VesselSpec {
    if (!this.db) return DEFAULT_VESSEL;
    try {
      const res = this.db.exec('SELECT * FROM vessels LIMIT 1');
      if (res.length > 0 && res[0].values.length > 0) {
        const cols = res[0].columns;
        const row = res[0].values[0];
        const getValue = (colName: string): string => {
          const idx = cols.indexOf(colName);
          if (idx !== -1 && row[idx] !== null && row[idx] !== undefined) {
            return String(row[idx]);
          }
          return '';
        };

        return {
          id: getValue('id') || DEFAULT_VESSEL.id,
          name: getValue('name') || DEFAULT_VESSEL.name,
          dimension: getValue('dimension') || DEFAULT_VESSEL.dimension,
          vesselType: getValue('vessel_type') || DEFAULT_VESSEL.vesselType,
          dockingType: getValue('docking_type') || DEFAULT_VESSEL.dockingType,
          companyOwner: getValue('company_owner') || DEFAULT_VESSEL.companyOwner,
          projectNo: getValue('project_no') || DEFAULT_VESSEL.projectNo,
          classification: getValue('classification') || DEFAULT_VESSEL.classification,
          kindOfSurvey: getValue('kind_of_survey') || DEFAULT_VESSEL.kindOfSurvey,
          photoUrl: getValue('photo_url') || DEFAULT_VESSEL.photoUrl,
        };
      }
    } catch (e) {
      console.error('getVessel error', e);
    }
    return DEFAULT_VESSEL;
  }

  public updateVessel(vessel: VesselSpec): void {
    if (!this.db) return;
    const v = vessel ? { ...DEFAULT_VESSEL, ...vessel } : { ...DEFAULT_VESSEL };
    try {
      this.db.run(
        `INSERT OR REPLACE INTO vessels (id, name, dimension, vessel_type, docking_type, company_owner, project_no, classification, kind_of_survey, photo_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.id || DEFAULT_VESSEL.id,
          v.name || DEFAULT_VESSEL.name,
          v.dimension || DEFAULT_VESSEL.dimension,
          v.vesselType || DEFAULT_VESSEL.vesselType,
          v.dockingType || DEFAULT_VESSEL.dockingType,
          v.companyOwner || DEFAULT_VESSEL.companyOwner,
          v.projectNo || DEFAULT_VESSEL.projectNo,
          v.classification || DEFAULT_VESSEL.classification,
          v.kindOfSurvey || DEFAULT_VESSEL.kindOfSurvey,
          v.photoUrl || '',
        ]
      );
    } catch (e) {
      try {
        this.runMigrations();
        this.db.run(
          `INSERT OR REPLACE INTO vessels (id, name, dimension, vessel_type, docking_type, company_owner, project_no, classification, kind_of_survey, photo_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            v.id || DEFAULT_VESSEL.id,
            v.name || DEFAULT_VESSEL.name,
            v.dimension || DEFAULT_VESSEL.dimension,
            v.vesselType || DEFAULT_VESSEL.vesselType,
            v.dockingType || DEFAULT_VESSEL.dockingType,
            v.companyOwner || DEFAULT_VESSEL.companyOwner,
            v.projectNo || DEFAULT_VESSEL.projectNo,
            v.classification || DEFAULT_VESSEL.classification,
            v.kindOfSurvey || DEFAULT_VESSEL.kindOfSurvey,
            v.photoUrl || '',
          ]
        );
      } catch (err) {
        console.error('updateVessel retry error', err);
      }
    }
    this.executePersist();
    this.notifyListeners();
  }

  public getProjectSchedule(): ProjectSchedule {
    if (!this.db) return DEFAULT_SCHEDULE;
    try {
      const res = this.db.exec(`
        SELECT id, vessel_id, arrive_bgn, start_contract, arrival_meeting, 
               docking_date, undocking_date, finish_work, sail_out, 
               docking_position, docking_duration_days, status,
               actual_start_contract, actual_docking_date, actual_undocking_date, 
               actual_finish_work, actual_sail_out 
        FROM projects LIMIT 1
      `);
      if (res.length > 0 && res[0].values.length > 0) {
        const r = res[0].values[0];
        return {
          id: String(r[0] || DEFAULT_SCHEDULE.id),
          vesselId: String(r[1] || DEFAULT_SCHEDULE.vesselId),
          arriveBgn: String(r[2] || DEFAULT_SCHEDULE.arriveBgn),
          startContract: String(r[3] || DEFAULT_SCHEDULE.startContract),
          arrivalMeeting: String(r[4] || DEFAULT_SCHEDULE.arrivalMeeting),
          dockingDate: String(r[5] || DEFAULT_SCHEDULE.dockingDate),
          undockingDate: String(r[6] || DEFAULT_SCHEDULE.undockingDate),
          finishWork: String(r[7] || DEFAULT_SCHEDULE.finishWork),
          sailOut: String(r[8] || DEFAULT_SCHEDULE.sailOut),
          dockingPosition: String(r[9] || DEFAULT_SCHEDULE.dockingPosition),
          dockingDurationDays: Number(r[10] || DEFAULT_SCHEDULE.dockingDurationDays),
          status: (r[11] as any) || DEFAULT_SCHEDULE.status,
          actualStartContract: r[12] ? String(r[12]) : undefined,
          actualDockingDate: r[13] ? String(r[13]) : undefined,
          actualUndockingDate: r[14] ? String(r[14]) : undefined,
          actualFinishWork: r[15] ? String(r[15]) : undefined,
          actualSailOut: r[16] ? String(r[16]) : undefined,
        };
      }
    } catch (e) {
      console.warn('getProjectSchedule fallback - executing without new columns', e);
      try {
        const res = this.db.exec('SELECT * FROM projects LIMIT 1');
        if (res.length > 0 && res[0].values.length > 0) {
          const r = res[0].values[0];
          return {
            id: String(r[0] || DEFAULT_SCHEDULE.id),
            vesselId: String(r[1] || DEFAULT_SCHEDULE.vesselId),
            arriveBgn: String(r[2] || DEFAULT_SCHEDULE.arriveBgn),
            startContract: String(r[3] || DEFAULT_SCHEDULE.startContract),
            arrivalMeeting: String(r[4] || DEFAULT_SCHEDULE.arrivalMeeting),
            dockingDate: String(r[5] || DEFAULT_SCHEDULE.dockingDate),
            undockingDate: String(r[6] || DEFAULT_SCHEDULE.undockingDate),
            finishWork: String(r[7] || DEFAULT_SCHEDULE.finishWork),
            sailOut: String(r[8] || DEFAULT_SCHEDULE.sailOut),
            dockingPosition: String(r[9] || DEFAULT_SCHEDULE.dockingPosition),
            dockingDurationDays: Number(r[10] || DEFAULT_SCHEDULE.dockingDurationDays),
            status: (r[11] as any) || DEFAULT_SCHEDULE.status,
          };
        }
      } catch (err) {
        console.error('getProjectSchedule fallback error', err);
      }
    }
    return DEFAULT_SCHEDULE;
  }

  public updateProjectSchedule(proj: ProjectSchedule): void {
    if (!this.db) return;
    console.log('Updating project schedule:', proj);
    const s = proj ? { ...DEFAULT_SCHEDULE, ...proj } : { ...DEFAULT_SCHEDULE };
    try {
      this.db.run(
        `INSERT OR REPLACE INTO projects (
          id, vessel_id, arrive_bgn, start_contract, arrival_meeting, 
          docking_date, undocking_date, finish_work, sail_out, 
          docking_position, docking_duration_days, status,
          actual_start_contract, actual_docking_date, actual_undocking_date, 
          actual_finish_work, actual_sail_out
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id || DEFAULT_SCHEDULE.id,
          s.vesselId || DEFAULT_SCHEDULE.vesselId,
          s.arriveBgn || DEFAULT_SCHEDULE.arriveBgn,
          s.startContract || DEFAULT_SCHEDULE.startContract,
          s.arrivalMeeting || DEFAULT_SCHEDULE.arrivalMeeting,
          s.dockingDate || DEFAULT_SCHEDULE.dockingDate,
          s.undockingDate || DEFAULT_SCHEDULE.undockingDate,
          s.finishWork || DEFAULT_SCHEDULE.finishWork,
          s.sailOut || DEFAULT_SCHEDULE.sailOut,
          s.dockingPosition || DEFAULT_SCHEDULE.dockingPosition,
          s.dockingDurationDays || DEFAULT_SCHEDULE.dockingDurationDays,
          s.status || DEFAULT_SCHEDULE.status,
          s.actualStartContract || '',
          s.actualDockingDate || '',
          s.actualUndockingDate || '',
          s.actualFinishWork || '',
          s.actualSailOut || '',
        ]
      );
    } catch (e) {
      console.warn('updateProjectSchedule error, retrying with migrations', e);
      try {
        this.runMigrations();
        this.db.run(
          `INSERT OR REPLACE INTO projects (
            id, vessel_id, arrive_bgn, start_contract, arrival_meeting, 
            docking_date, undocking_date, finish_work, sail_out, 
            docking_position, docking_duration_days, status,
            actual_start_contract, actual_docking_date, actual_undocking_date, 
            actual_finish_work, actual_sail_out
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            s.id || DEFAULT_SCHEDULE.id,
            s.vesselId || DEFAULT_SCHEDULE.vesselId,
            s.arriveBgn || DEFAULT_SCHEDULE.arriveBgn,
            s.startContract || DEFAULT_SCHEDULE.startContract,
            s.arrivalMeeting || DEFAULT_SCHEDULE.arrivalMeeting,
            s.dockingDate || DEFAULT_SCHEDULE.dockingDate,
            s.undockingDate || DEFAULT_SCHEDULE.undockingDate,
            s.finishWork || DEFAULT_SCHEDULE.finishWork,
            s.sailOut || DEFAULT_SCHEDULE.sailOut,
            s.dockingPosition || DEFAULT_SCHEDULE.dockingPosition,
            s.dockingDurationDays || DEFAULT_SCHEDULE.dockingDurationDays,
            s.status || DEFAULT_SCHEDULE.status,
            s.actualStartContract || '',
            s.actualDockingDate || '',
            s.actualUndockingDate || '',
            s.actualFinishWork || '',
            s.actualSailOut || '',
          ]
        );
      } catch (err) {
        console.error('updateProjectSchedule retry error', err);
      }
    }
    this.executePersist();
    this.notifyListeners();
  }

  public getWorkCategories(): WorkCategory[] {
    if (!this.db) return DEFAULT_CATEGORIES;
    try {
      const res = this.db.exec('SELECT id, code, name, sort_order FROM work_categories ORDER BY sort_order ASC');
      if (res.length > 0) {
        const list = res[0].values.map((row) => ({
          id: String(row[0]),
          code: String(row[1]),
          name: String(row[2]),
          sortOrder: Number(row[3]),
        }));

        // Auto-heal: verify if Category XII or any other default is missing
        let hasMissing = false;
        DEFAULT_CATEGORIES.forEach((defCat) => {
          if (!list.some((c) => c.id === defCat.id || c.code === defCat.code)) {
            list.push({ ...defCat });
            try {
              this.db.run(
                'INSERT OR REPLACE INTO work_categories (id, code, name, sort_order) VALUES (?, ?, ?, ?)',
                [defCat.id, defCat.code, defCat.name, defCat.sortOrder]
              );
              hasMissing = true;
            } catch {}
          }
        });

        if (hasMissing) {
          this.executePersist();
        }

        return list.sort((a, b) => a.sortOrder - b.sortOrder);
      }
    } catch (e) {
      console.error('getWorkCategories error', e);
    }
    return DEFAULT_CATEGORIES;
  }

  private mapSqlRowsToWorkItems(columns: string[], values: any[][]): WorkItem[] {
    const colIdx = new Map<string, number>();
    columns.forEach((c, idx) => colIdx.set(String(c).toLowerCase(), idx));
    const get = (row: any[], col: string) => {
      const idx = colIdx.get(col);
      return idx !== undefined ? row[idx] : undefined;
    };

    return values.map((r) => {
      const rawComp = get(r, 'is_completed');
      const isComp = Boolean(rawComp);
      const rawPctVal = get(r, 'progress_percent');
      const rawPct = rawPctVal !== null && rawPctVal !== undefined ? Number(rawPctVal) : undefined;
      const progressPercent = rawPct !== undefined ? rawPct : (isComp ? 100 : 0);

      let dailyLogs: Record<string, any> = {};
      const rawDaily = get(r, 'daily_logs_json');
      if (rawDaily) {
        try {
          dailyLogs = JSON.parse(String(rawDaily)) || {};
        } catch {
          dailyLogs = {};
        }
      }

      let planLogs: Record<string, number> = {};
      const rawPlan = get(r, 'plan_logs_json');
      if (rawPlan) {
        try {
          planLogs = JSON.parse(String(rawPlan)) || {};
        } catch {
          planLogs = {};
        }
      }

      const rawItemLevel = get(r, 'item_level');
      const rawProgressQty = get(r, 'progress_qty');
      const rawPlanPercent = get(r, 'plan_percent');
      const rawWeightFactor = get(r, 'weight_factor');
      const rawAssignedTo = get(r, 'assigned_to');
      const rawSubcontractor = get(r, 'subcontractor');
      const rawOpnameQty = get(r, 'opname_qty');
      const rawOpnamePercent = get(r, 'opname_percent');

      return {
        id: String(get(r, 'id') ?? ''),
        projectId: String(get(r, 'project_id') ?? 'proj-f049'),
        categoryId: String(get(r, 'category_id') ?? 'cat-1'),
        itemNo: String(get(r, 'item_no') ?? ''),
        description: String(get(r, 'description') ?? ''),
        type: String(get(r, 'type') || ''),
        d1: String(get(r, 'd1') || ''),
        d2: String(get(r, 'd2') || ''),
        d3: String(get(r, 'd3') || ''),
        dLen: String(get(r, 'd_len') || ''),
        d4: String(get(r, 'd4') || ''),
        qty: Number(get(r, 'qty') || 0),
        unit: String(get(r, 'unit') || ''),
        weightKg: Number(get(r, 'weight_kg') || 0),
        unitPrice: Number(get(r, 'unit_price') || 0),
        totalPrice: Number(get(r, 'total_price') || 0),
        remark: String(get(r, 'remark') || ''),
        remark2: String(get(r, 'remark2') || ''),
        isCompleted: isComp,
        notes: String(get(r, 'notes') || ''),
        parentId: get(r, 'parent_id') ? String(get(r, 'parent_id')) : undefined,
        itemLevel: rawItemLevel !== null && rawItemLevel !== undefined ? (Number(rawItemLevel) as any) : undefined,
        isAreaHeader: Boolean(get(r, 'is_area_header')),
        progressPercent,
        progressQty: rawProgressQty !== null && rawProgressQty !== undefined ? Number(rawProgressQty) : undefined,
        progressNotes: get(r, 'progress_notes') ? String(get(r, 'progress_notes')) : undefined,
        progressDate: get(r, 'progress_date') ? String(get(r, 'progress_date')) : undefined,
        updatedAt: get(r, 'updated_at') ? String(get(r, 'updated_at')) : undefined,
        updatedBy: get(r, 'updated_by') ? String(get(r, 'updated_by')) : undefined,
        updatedByUserId: get(r, 'updated_by_user_id') ? String(get(r, 'updated_by_user_id')) : undefined,
        updatedAction: get(r, 'updated_action') ? (String(get(r, 'updated_action')) as any) : undefined,
        priceBasis: get(r, 'price_basis') ? (String(get(r, 'price_basis')) as 'qty' | 'weight') : undefined,
        startDate: get(r, 'start_date') ? String(get(r, 'start_date')) : undefined,
        targetEndDate: get(r, 'target_end_date') ? String(get(r, 'target_end_date')) : undefined,
        actualStartDate: get(r, 'actual_start_date') ? String(get(r, 'actual_start_date')) : undefined,
        actualEndDate: get(r, 'actual_end_date') ? String(get(r, 'actual_end_date')) : undefined,
        planPercent: rawPlanPercent !== null && rawPlanPercent !== undefined ? Number(rawPlanPercent) : undefined,
        weightFactor: rawWeightFactor !== null && rawWeightFactor !== undefined ? Number(rawWeightFactor) : undefined,
        assignedTo: rawAssignedTo ? String(rawAssignedTo) : (rawSubcontractor ? String(rawSubcontractor) : undefined),
        subcontractor: rawSubcontractor ? String(rawSubcontractor) : (rawAssignedTo ? String(rawAssignedTo) : undefined),
        opnameStatus: get(r, 'opname_status') ? (String(get(r, 'opname_status')) as any) : undefined,
        opnameQty: rawOpnameQty !== null && rawOpnameQty !== undefined ? Number(rawOpnameQty) : undefined,
        opnamePercent: rawOpnamePercent !== null && rawOpnamePercent !== undefined ? Number(rawOpnamePercent) : undefined,
        opnameDate: get(r, 'opname_date') ? String(get(r, 'opname_date')) : undefined,
        opnameInspector: get(r, 'opname_inspector') ? String(get(r, 'opname_inspector')) : undefined,
        opnameNotes: get(r, 'opname_notes') ? String(get(r, 'opname_notes')) : undefined,
        opnameBapoNo: get(r, 'opname_bapo_no') ? String(get(r, 'opname_bapo_no')) : undefined,
        dailyLogs,
        planLogs,
      };
    });
  }

  public getWorkItems(): WorkItem[] {
    if (!this.db) return DEFAULT_WORK_ITEMS;
    try {
      const res = this.db.exec(`
        SELECT id, project_id, category_id, item_no, description, type, d1, d2, d3, d_len, d4, qty, unit, weight_kg, unit_price, total_price, remark, remark2, is_completed, notes, parent_id, item_level, is_area_header, progress_percent, progress_qty, progress_notes, progress_date, updated_at, updated_by, updated_by_user_id, updated_action, price_basis, start_date, target_end_date, actual_start_date, actual_end_date, plan_percent, weight_factor, assigned_to, subcontractor, opname_status, opname_qty, opname_percent, opname_date, opname_inspector, opname_notes, opname_bapo_no, daily_logs_json, plan_logs_json
        FROM work_items
      `);
      if (res.length > 0) {
        return this.mapSqlRowsToWorkItems(res[0].columns, res[0].values);
      }
      return [];
    } catch (e) {
      // Fallback query if newer columns don't exist in an older loaded binary
      try {
        const resOld = this.db.exec(`SELECT * FROM work_items`);
        if (resOld.length > 0) {
          return this.mapSqlRowsToWorkItems(resOld[0].columns, resOld[0].values);
        }
        return [];
      } catch (err) {
        console.error('getWorkItems fallback error', err);
      }
    }
    return DEFAULT_WORK_ITEMS;
  }

  // --- AUDIT TRAIL HELPER & QUERIES ---

  public getActorInfo(actor?: string | { name?: string; role?: string; id?: string }): {
    name: string;
    role: string;
    id?: string;
    display: string;
  } {
    if (typeof actor === 'object' && actor?.name) {
      const name = actor.name;
      const role = actor.role || 'PPC';
      const id = actor.id;
      return { name, role, id, display: `${name} (${role})` };
    }
    if (typeof actor === 'string' && actor.trim()) {
      return { name: actor, role: 'PPC', display: actor };
    }
    const current = authService.getCurrentUser();
    if (current) {
      return {
        name: current.name,
        role: current.role || 'PPC',
        id: current.id,
        display: `${current.name} (${current.role})`,
      };
    }
    return {
      name: 'Muhammad Munthaha',
      role: 'PPC',
      id: 'user-ppc-1',
      display: 'Muhammad Munthaha (PPC)',
    };
  }

  private generateWorkItemDiff(
    prev: WorkItem,
    next: WorkItem
  ): { action: WorkItemAuditLog['action']; details: string } {
    const diffs: string[] = [];
    let action: WorkItemAuditLog['action'] = 'updated';

    if (prev.itemNo !== next.itemNo) {
      diffs.push(`No: ${prev.itemNo || '-'} → ${next.itemNo || '-'}`);
      action = 'reordered';
    }
    if (prev.description !== next.description) {
      diffs.push(`Deskripsi diubah`);
    }
    if (prev.type !== next.type) {
      diffs.push(`Material: ${prev.type || '-'} → ${next.type || '-'}`);
      action = 'dimension_changed';
    }
    const dimChanged =
      prev.d1 !== next.d1 ||
      prev.d2 !== next.d2 ||
      prev.d3 !== next.d3 ||
      prev.dLen !== next.dLen ||
      prev.d4 !== next.d4;
    if (dimChanged) {
      const pDim = [prev.d1, prev.d2, prev.d3, prev.dLen, prev.d4].filter(Boolean).join('x');
      const nDim = [next.d1, next.d2, next.d3, next.dLen, next.d4].filter(Boolean).join('x');
      diffs.push(`Dimensi: [${pDim || '-'}] → [${nDim || '-'}]`);
      action = 'dimension_changed';
    }
    if (prev.qty !== next.qty || prev.unit !== next.unit) {
      diffs.push(`Volume: ${prev.qty} ${prev.unit || ''} → ${next.qty} ${next.unit || ''}`);
    }
    if (prev.weightKg !== next.weightKg) {
      diffs.push(
        `Berat: ${(prev.weightKg || 0).toFixed(2)}kg → ${(next.weightKg || 0).toFixed(2)}kg`
      );
      action = 'dimension_changed';
    }
    if (prev.progressPercent !== next.progressPercent) {
      diffs.push(`Progres: ${prev.progressPercent || 0}% → ${next.progressPercent || 0}%`);
      action = 'progress_updated';
    }
    if (Boolean(prev.isCompleted) !== Boolean(next.isCompleted)) {
      diffs.push(`Status: ${next.isCompleted ? 'Selesai' : 'Belum Selesai'}`);
      action = 'status_changed';
    }
    if (prev.remark !== next.remark) {
      diffs.push(`Remark: "${prev.remark || ''}" → "${next.remark || ''}"`);
    }
    if (prev.itemLevel !== next.itemLevel || prev.parentId !== next.parentId) {
      diffs.push(`Struktur/Hierarki diubah`);
      action = 'reordered';
    }

    const details = diffs.length > 0 ? diffs.join('; ') : 'Pembaruan data item pekerjaan';
    return { action, details };
  }

  public logWorkItemAudit(
    log: Omit<WorkItemAuditLog, 'id' | 'timestamp'> & { id?: string; timestamp?: string }
  ): void {
    if (!this.db) return;
    const logId = log.id || `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = log.timestamp || new Date().toISOString();

    try {
      this.db.run(
        `INSERT INTO work_item_audit_logs (
          id, project_id, work_item_id, item_no, description, action,
          changed_by, changed_by_role, changed_by_user_id, timestamp, details, changes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logId,
          log.projectId || null,
          log.workItemId,
          log.itemNo || '',
          log.description || '',
          log.action,
          log.changedBy,
          log.changedByRole || null,
          log.changedByUserId || null,
          timestamp,
          log.details || null,
          log.changesJson || null,
        ]
      );
    } catch (e) {
      console.warn('logWorkItemAudit error:', e);
    }
  }

  public getAuditLogs(workItemId?: string, limit: number = 300): WorkItemAuditLog[] {
    if (!this.db) return [];
    try {
      let query = `
        SELECT id, project_id, work_item_id, item_no, description, action, changed_by, changed_by_role, changed_by_user_id, timestamp, details, changes_json
        FROM work_item_audit_logs
      `;
      if (workItemId) {
        const cleanId = workItemId.replace(/'/g, "''");
        query += ` WHERE work_item_id = '${cleanId}'`;
      }
      query += ` ORDER BY timestamp DESC LIMIT ${limit}`;

      const res = this.db.exec(query);
      if (res.length > 0) {
        return res[0].values.map((r) => ({
          id: String(r[0]),
          projectId: r[1] ? String(r[1]) : undefined,
          workItemId: String(r[2]),
          itemNo: String(r[3] || ''),
          description: String(r[4] || ''),
          action: String(r[5]) as any,
          changedBy: String(r[6] || ''),
          changedByRole: r[7] ? String(r[7]) : undefined,
          changedByUserId: r[8] ? String(r[8]) : undefined,
          timestamp: String(r[9]),
          details: r[10] ? String(r[10]) : undefined,
          changesJson: r[11] ? String(r[11]) : undefined,
        }));
      }
    } catch (e) {
      console.warn('getAuditLogs error', e);
    }
    return [];
  }

  public clearAuditLogs(workItemId?: string): void {
    if (!this.db) return;
    try {
      if (workItemId) {
        this.db.run('DELETE FROM work_item_audit_logs WHERE work_item_id = ?', [workItemId]);
      } else {
        this.db.run('DELETE FROM work_item_audit_logs');
      }
      this.persist();
      this.notifyListeners();
    } catch (e) {
      console.warn('clearAuditLogs error', e);
    }
  }

  public addWorkItem(
    item: Omit<WorkItem, 'id'>,
    actor?: string | { name?: string; role?: string; id?: string }
  ): string {
    if (!this.db) return '';
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    const stampedItem: Omit<WorkItem, 'id'> = {
      ...item,
      updatedAt: nowIso,
      updatedBy: actorInfo.display,
      updatedByUserId: actorInfo.id,
      updatedAction: 'created',
    };

    const currentItems = this.getWorkItems();
    const { updatedItems, createdItem } = addAndResequenceWorkItem(currentItems, stampedItem);
    this.importWorkItems(updatedItems, 'replace');

    // Create Audit Log
    this.logWorkItemAudit({
      projectId: createdItem.projectId,
      workItemId: createdItem.id,
      itemNo: createdItem.itemNo,
      description: createdItem.description,
      action: 'created',
      changedBy: actorInfo.name,
      changedByRole: actorInfo.role,
      changedByUserId: actorInfo.id,
      details: `Pekerjaan baru "${createdItem.itemNo ? `${createdItem.itemNo} ` : ''}${createdItem.description}" ditambahkan ke dalam daftar`,
    });

    return createdItem.id;
  }

  /**
   * Utility function that triggers automatic re-indexing for area, subsystem, and component numbers
   * whenever CRUD operations (add, delete, update position/parent) occur on workItems.
   */
  public triggerAutoReindex(categoryId?: string): void {
    if (!this.db) return;
    const currentItems = this.getWorkItems();
    const updated = categoryId
      ? resequenceCategoryItems(currentItems, categoryId)
      : resequenceAllWorkItems(currentItems);
    this.importWorkItems(updated, 'replace');
  }

  public updateWorkItem(
    item: WorkItem,
    actor?: string | { name?: string; role?: string; id?: string },
    customDetails?: string,
    notify: boolean = false
  ): void {
    if (!this.db) return;
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    const currentItems = this.getWorkItems();
    const existing = currentItems.find((w) => w.id === item.id);

    let action: WorkItemAuditLog['action'] = item.updatedAction || 'updated';
    let details = customDetails;

    if (existing && !details) {
      const diff = this.generateWorkItemDiff(existing, item);
      action = diff.action;
      details = diff.details;
    }

    const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
    const totalPrice =
      item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
        ? item.totalPrice
        : basis === 'weight' && (item.weightKg || 0) > 0
        ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
        : Math.round((item.qty || 0) * (item.unitPrice || 0));

    const progressPercent =
      item.progressPercent !== undefined
        ? item.progressPercent
        : item.isCompleted
        ? 100
        : 0;

    const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

    this.db.run(
      `UPDATE work_items SET 
        category_id=?, item_no=?, description=?, type=?, d1=?, d2=?, d3=?, d_len=?, d4=?, 
        qty=?, unit=?, weight_kg=?, unit_price=?, total_price=?, remark=?, remark2=?, 
        is_completed=?, notes=?, parent_id=?, item_level=?, is_area_header=?,
        progress_percent=?, progress_qty=?, progress_notes=?, progress_date=?,
        updated_at=?, updated_by=?, updated_by_user_id=?, updated_action=?, price_basis=?,
        start_date=?, target_end_date=?, actual_start_date=?, actual_end_date=?, plan_percent=?, weight_factor=?, assigned_to=?,
        subcontractor=?, opname_status=?, opname_qty=?, opname_percent=?, opname_date=?, opname_inspector=?, opname_notes=?, opname_bapo_no=?, daily_logs_json=?, plan_logs_json=?
       WHERE id=?`,
      [
        item.categoryId,
        item.itemNo,
        item.description,
        item.type || '',
        item.d1 || '',
        item.d2 || '',
        item.d3 || '',
        item.dLen || '',
        item.d4 || '',
        item.qty,
        item.unit,
        item.weightKg || 0,
        item.unitPrice,
        totalPrice,
        item.remark || '',
        item.remark2 || '',
        isCompleted ? 1 : 0,
        item.notes || '',
        item.parentId || null,
        item.itemLevel !== undefined ? item.itemLevel : null,
        item.isAreaHeader ? 1 : 0,
        progressPercent,
        item.progressQty !== undefined ? item.progressQty : null,
        item.progressNotes || null,
        item.progressDate || null,
        nowIso,
        actorInfo.display,
        actorInfo.id || null,
        action,
        item.priceBasis || null,
        item.startDate || null,
        item.targetEndDate || null,
        item.actualStartDate || null,
        item.actualEndDate || null,
        item.planPercent !== undefined ? item.planPercent : null,
        item.weightFactor !== undefined ? item.weightFactor : null,
        item.assignedTo || item.subcontractor || null,
        item.subcontractor || item.assignedTo || null,
        item.opnameStatus || null,
        item.opnameQty !== undefined && item.opnameQty !== null ? item.opnameQty : null,
        item.opnamePercent !== undefined && item.opnamePercent !== null ? item.opnamePercent : null,
        item.opnameDate || null,
        item.opnameInspector || null,
        item.opnameNotes || null,
        item.opnameBapoNo || null,
        item.dailyLogs ? JSON.stringify(item.dailyLogs) : null,
        item.planLogs ? JSON.stringify(item.planLogs) : null,
        item.id,
      ]
    );

    // Auto-reindex if critical hierarchy fields (itemNo, parentId) changed
    if (existing && (existing.itemNo !== item.itemNo || existing.parentId !== item.parentId)) {
      this.triggerAutoReindex(item.categoryId);
    }

    // Record Audit Log entry
    this.logWorkItemAudit({
      projectId: item.projectId,
      workItemId: item.id,
      itemNo: item.itemNo,
      description: item.description,
      action,
      changedBy: actorInfo.name,
      changedByRole: actorInfo.role,
      changedByUserId: actorInfo.id,
      details: details || `Item pekerjaan "${item.itemNo} ${item.description}" diperbarui`,
    });

    // Check if progress was updated and trigger bi-directional hierarchical synchronization
    const progressChanged =
      existing &&
      (existing.progressPercent !== item.progressPercent ||
        Boolean(existing.isCompleted) !== Boolean(item.isCompleted));

    if (progressChanged) {
      const targetPct = item.progressPercent !== undefined ? item.progressPercent : item.isCompleted ? 100 : 0;
      const { modifiedItems } = syncWorkItemsProgressHierarchy(currentItems, item, targetPct);
      
      if (modifiedItems.length > 1) {
        // Exclude the primary item as it was already updated above
        const otherModified = modifiedItems.filter((m) => m.id !== item.id);
        otherModified.forEach((mod) => {
          const modComp = (mod.progressPercent || 0) >= 100 || Boolean(mod.isCompleted);
          this.db.run(
            `UPDATE work_items SET
              progress_percent=?, progress_qty=?, is_completed=?, progress_date=?, updated_at=?
             WHERE id=?`,
            [
              mod.progressPercent || 0,
              mod.progressQty !== undefined ? mod.progressQty : null,
              modComp ? 1 : 0,
              mod.progressDate || nowIso,
              nowIso,
              mod.id,
            ]
          );
        });
      }
    }

    this.persist();
    if (notify) {
      this.notifyListeners();
    }

    // Trigger auto re-indexing to ensure numbering consistency if needed
    if (existing && (existing.itemNo !== item.itemNo || existing.parentId !== item.parentId)) {
      this.triggerAutoReindex(item.categoryId);
    }
  }

  public updateWorkItemsBatch(
    items: WorkItem[],
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db || items.length === 0) return;
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    items.forEach((item) => {
      const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
      const totalPrice =
        item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
          ? item.totalPrice
          : basis === 'weight' && (item.weightKg || 0) > 0
          ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
          : Math.round((item.qty || 0) * (item.unitPrice || 0));

      const progressPercent =
        item.progressPercent !== undefined
          ? item.progressPercent
          : item.isCompleted
          ? 100
          : 0;

      const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

      const dailyLogsJson = item.dailyLogs ? JSON.stringify(item.dailyLogs) : null;

      this.db.run(
        `UPDATE work_items SET 
          category_id=?, item_no=?, description=?, type=?, d1=?, d2=?, d3=?, d_len=?, d4=?, 
          qty=?, unit=?, weight_kg=?, unit_price=?, total_price=?, remark=?, remark2=?, 
          is_completed=?, notes=?, parent_id=?, item_level=?, is_area_header=?,
          progress_percent=?, progress_qty=?, progress_notes=?, progress_date=?,
          updated_at=?, updated_by=?, updated_by_user_id=?, updated_action=?, price_basis=?,
          start_date=?, target_end_date=?, actual_start_date=?, actual_end_date=?, plan_percent=?, weight_factor=?, assigned_to=?, daily_logs_json=?, plan_logs_json=?
         WHERE id=?`,
        [
          item.categoryId,
          item.itemNo,
          item.description,
          item.type || '',
          item.d1 || '',
          item.d2 || '',
          item.d3 || '',
          item.dLen || '',
          item.d4 || '',
          item.qty,
          item.unit,
          item.weightKg || 0,
          item.unitPrice,
          totalPrice,
          item.remark || '',
          item.remark2 || '',
          isCompleted ? 1 : 0,
          item.notes || '',
          item.parentId || null,
          item.itemLevel !== undefined ? item.itemLevel : null,
          item.isAreaHeader ? 1 : 0,
          progressPercent,
          item.progressQty !== undefined ? item.progressQty : null,
          item.progressNotes || null,
          item.progressDate || null,
          nowIso,
          actorInfo.display,
          actorInfo.id || null,
          item.updatedAction || 'updated',
          item.priceBasis || null,
          item.startDate || null,
          item.targetEndDate || null,
          item.actualStartDate || null,
          item.actualEndDate || null,
          item.planPercent !== undefined ? item.planPercent : null,
          item.weightFactor !== undefined ? item.weightFactor : null,
          item.assignedTo || null,
          dailyLogsJson,
          item.planLogs ? JSON.stringify(item.planLogs) : null,
          item.id,
        ]
      );
    });

    this.persist();
    this.notifyListeners();
  }

  public deleteWorkItem(
    id: string,
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db) return;
    const actorInfo = this.getActorInfo(actor);
    const currentItems = this.getWorkItems();
    const target = currentItems.find((w) => w.id === id);

    if (target) {
      this.logWorkItemAudit({
        projectId: target.projectId,
        workItemId: target.id,
        itemNo: target.itemNo,
        description: target.description,
        action: 'deleted',
        changedBy: actorInfo.name,
        changedByRole: actorInfo.role,
        changedByUserId: actorInfo.id,
        details: `Item pekerjaan "${target.itemNo ? `${target.itemNo} ` : ''}${target.description}" dihapus dari daftar perbaikan`,
      });
    }

    const { updatedItems } = cascadeDeleteWorkItem(currentItems, id);
    this.importWorkItems(updatedItems, 'replace');
  }

  public deleteWorkItems(
    ids: string[],
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db || ids.length === 0) return;
    const actorInfo = this.getActorInfo(actor);
    const currentItems = this.getWorkItems();

    ids.forEach((id) => {
      const target = currentItems.find((w) => w.id === id);
      if (target) {
        this.logWorkItemAudit({
          projectId: target.projectId,
          workItemId: target.id,
          itemNo: target.itemNo,
          description: target.description,
          action: 'deleted',
          changedBy: actorInfo.name,
          changedByRole: actorInfo.role,
          changedByUserId: actorInfo.id,
          details: `Item pekerjaan "${target.itemNo ? `${target.itemNo} ` : ''}${target.description}" dihapus secara massal`,
        });
      }
    });

    const { updatedItems } = cascadeDeleteWorkItems(currentItems, ids);
    this.importWorkItems(updatedItems, 'replace');
  }

  public resequenceWorkItems(categoryId?: string): void {
    if (!this.db) return;
    const currentItems = this.getWorkItems();
    const updated = categoryId
      ? resequenceCategoryItems(currentItems, categoryId)
      : resequenceAllWorkItems(currentItems);
    this.importWorkItems(updated, 'replace');
  }

  public clearAllWorkItems(): void {
    if (this.isUsingFallback) {
      if (this.db) {
        this.db.run('DELETE FROM work_items');
      }
      this.notifyListeners();
      return;
    }
    if (!this.db) return;
    try {
      this.db.run('DELETE FROM work_items');
      this.executePersist();
      this.notifyListeners();
    } catch (e) {
      console.error('clearAllWorkItems error', e);
    }
  }

  public importWorkItems(items: WorkItem[], mode: 'replace' | 'append'): void {
    if (!this.db) return;

    if (mode === 'replace') {
      this.db.run('DELETE FROM work_items');
    }

    if (items.length === 0) {
      this.executePersist();
      this.notifyListeners();
      return;
    }

    items.forEach((item) => {
      const id = item.id || `work-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
      const totalPrice =
        item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
          ? item.totalPrice
          : basis === 'weight' && (item.weightKg || 0) > 0
          ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
          : Math.round((item.qty || 0) * (item.unitPrice || 0));

      const progressPercent =
        item.progressPercent !== undefined
          ? item.progressPercent
          : item.isCompleted
          ? 100
          : 0;

      const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

      this.db.run(
        `INSERT OR REPLACE INTO work_items (
          id, project_id, category_id, item_no, description, type, d1, d2, d3, d_len, d4, qty, unit, 
          weight_kg, unit_price, total_price, remark, remark2, is_completed, notes,
          parent_id, item_level, is_area_header, progress_percent, progress_qty, progress_notes, progress_date,
          updated_at, updated_by, updated_by_user_id, updated_action, price_basis,
          start_date, target_end_date, actual_start_date, actual_end_date, plan_percent, weight_factor, assigned_to,
          subcontractor, opname_status, opname_qty, opname_percent, opname_date, opname_inspector, opname_notes, opname_bapo_no,
          daily_logs_json, plan_logs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          item.projectId || 'proj-f049',
          item.categoryId || 'cat-1',
          item.itemNo || '',
          item.description || 'Pekerjaan',
          item.type || '',
          item.d1 || '',
          item.d2 || '',
          item.d3 || '',
          item.dLen || '',
          item.d4 || '',
          item.qty !== undefined && item.qty !== null ? item.qty : 0,
          item.unit || '',
          item.weightKg || 0,
          item.unitPrice || 0,
          totalPrice,
          item.remark || '',
          item.remark2 || '',
          isCompleted ? 1 : 0,
          item.notes || '',
          item.parentId || null,
          item.itemLevel !== undefined ? item.itemLevel : null,
          item.isAreaHeader ? 1 : 0,
          progressPercent,
          item.progressQty !== undefined ? item.progressQty : null,
          item.progressNotes || null,
          item.progressDate || null,
          item.updatedAt || null,
          item.updatedBy || null,
          item.updatedByUserId || null,
          item.updatedAction || null,
          item.priceBasis || null,
          item.startDate || null,
          item.targetEndDate || null,
          item.actualStartDate || null,
          item.actualEndDate || null,
          item.planPercent !== undefined ? item.planPercent : null,
          item.weightFactor !== undefined ? item.weightFactor : null,
          item.assignedTo || item.subcontractor || null,
          item.subcontractor || item.assignedTo || null,
          item.opnameStatus || null,
          item.opnameQty !== undefined && item.opnameQty !== null ? item.opnameQty : null,
          item.opnamePercent !== undefined && item.opnamePercent !== null ? item.opnamePercent : null,
          item.opnameDate || null,
          item.opnameInspector || null,
          item.opnameNotes || null,
          item.opnameBapoNo || null,
          item.dailyLogs ? JSON.stringify(item.dailyLogs) : null,
          item.planLogs ? JSON.stringify(item.planLogs) : null,
        ]
      );
    });

    this.persist();
    this.notifyListeners();
  }

  // --- OPNAME & SUBCONT WORK ITEMS METHODS (Strictly Isolated from Repair List) ---

  public getOpnameWorkItems(autoInitFromRepairList: boolean = false): WorkItem[] {
    if (!this.db) return [];
    try {
      let res = this.db.exec(`
        SELECT id, project_id, category_id, item_no, description, type, d1, d2, d3, d_len, d4, qty, unit, weight_kg, unit_price, total_price, remark, remark2, is_completed, notes, parent_id, item_level, is_area_header, progress_percent, progress_qty, progress_notes, progress_date, updated_at, updated_by, updated_by_user_id, updated_action, price_basis, start_date, target_end_date, actual_start_date, actual_end_date, plan_percent, weight_factor, assigned_to, subcontractor, opname_status, opname_qty, opname_percent, opname_date, opname_inspector, opname_notes, opname_bapo_no, daily_logs_json, plan_logs_json
        FROM opname_work_items
      `);
      if (res.length > 0 && res[0].values.length > 0) {
        return this.mapSqlRowsToWorkItems(res[0].columns, res[0].values);
      }

      // If opname table is empty, and autoInit is enabled, seed it once from repair list
      if (autoInitFromRepairList) {
        const repairList = this.getWorkItems();
        if (repairList.length > 0) {
          const cloned: WorkItem[] = repairList.map((item) => ({
            ...item,
            opnameStatus: item.opnameStatus || 'Belum Diperiksa',
            opnamePercent: item.opnamePercent !== undefined ? item.opnamePercent : (item.progressPercent || 0),
            opnameQty: item.opnameQty !== undefined ? item.opnameQty : (item.progressQty !== undefined ? item.progressQty : item.qty),
          }));
          this.importOpnameWorkItems(cloned, 'replace');
          return cloned;
        }
      }
    } catch (e) {
      try {
        const resOld = this.db.exec(`SELECT * FROM opname_work_items`);
        if (resOld.length > 0 && resOld[0].values.length > 0) {
          return this.mapSqlRowsToWorkItems(resOld[0].columns, resOld[0].values);
        }
      } catch {}
      console.warn('getOpnameWorkItems query error', e);
    }
    return [];
  }

  public updateOpnameWorkItem(
    item: WorkItem,
    actor?: string | { name?: string; role?: string; id?: string },
    customDetails?: string
  ): void {
    if (!this.db) return;
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
    const totalPrice =
      item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
        ? item.totalPrice
        : basis === 'weight' && (item.weightKg || 0) > 0
        ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
        : Math.round((item.qty || 0) * (item.unitPrice || 0));

    const progressPercent =
      item.progressPercent !== undefined
        ? item.progressPercent
        : item.isCompleted
        ? 100
        : 0;

    const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

    this.db.run(
      `UPDATE opname_work_items SET 
        category_id=?, item_no=?, description=?, type=?, d1=?, d2=?, d3=?, d_len=?, d4=?, 
        qty=?, unit=?, weight_kg=?, unit_price=?, total_price=?, remark=?, remark2=?, 
        is_completed=?, notes=?, parent_id=?, item_level=?, is_area_header=?,
        progress_percent=?, progress_qty=?, progress_notes=?, progress_date=?,
        updated_at=?, updated_by=?, updated_by_user_id=?, updated_action=?, price_basis=?,
        start_date=?, target_end_date=?, actual_end_date=?, plan_percent=?, weight_factor=?, assigned_to=?,
        subcontractor=?, opname_status=?, opname_qty=?, opname_percent=?, opname_date=?, opname_inspector=?, opname_notes=?, opname_bapo_no=?, daily_logs_json=?, plan_logs_json=?
       WHERE id=?`,
      [
        item.categoryId,
        item.itemNo,
        item.description,
        item.type || '',
        item.d1 || '',
        item.d2 || '',
        item.d3 || '',
        item.dLen || '',
        item.d4 || '',
        item.qty,
        item.unit,
        item.weightKg || 0,
        item.unitPrice,
        totalPrice,
        item.remark || '',
        item.remark2 || '',
        isCompleted ? 1 : 0,
        item.notes || '',
        item.parentId || null,
        item.itemLevel !== undefined ? item.itemLevel : null,
        item.isAreaHeader ? 1 : 0,
        progressPercent,
        item.progressQty !== undefined ? item.progressQty : null,
        item.progressNotes || null,
        item.progressDate || null,
        nowIso,
        actorInfo.display,
        actorInfo.id || null,
        item.updatedAction || 'updated',
        item.priceBasis || null,
        item.startDate || null,
        item.targetEndDate || null,
        item.actualEndDate || null,
        item.planPercent !== undefined ? item.planPercent : null,
        item.weightFactor !== undefined ? item.weightFactor : null,
        item.assignedTo || item.subcontractor || null,
        item.subcontractor || item.assignedTo || null,
        item.opnameStatus || null,
        item.opnameQty !== undefined && item.opnameQty !== null ? item.opnameQty : null,
        item.opnamePercent !== undefined && item.opnamePercent !== null ? item.opnamePercent : null,
        item.opnameDate || null,
        item.opnameInspector || null,
        item.opnameNotes || null,
        item.opnameBapoNo || null,
        item.dailyLogs ? JSON.stringify(item.dailyLogs) : null,
        item.planLogs ? JSON.stringify(item.planLogs) : null,
        item.id,
      ]
    );

    this.persist();
    this.notifyListeners();
  }

  public updateOpnameWorkItemsBatch(
    items: WorkItem[],
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db || items.length === 0) return;
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    items.forEach((item) => {
      const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
      const totalPrice =
        item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
          ? item.totalPrice
          : basis === 'weight' && (item.weightKg || 0) > 0
          ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
          : Math.round((item.qty || 0) * (item.unitPrice || 0));

      const progressPercent =
        item.progressPercent !== undefined
          ? item.progressPercent
          : item.isCompleted
          ? 100
          : 0;

      const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

      this.db.run(
        `UPDATE opname_work_items SET 
          category_id=?, item_no=?, description=?, type=?, d1=?, d2=?, d3=?, d_len=?, d4=?, 
          qty=?, unit=?, weight_kg=?, unit_price=?, total_price=?, remark=?, remark2=?, 
          is_completed=?, notes=?, parent_id=?, item_level=?, is_area_header=?,
          progress_percent=?, progress_qty=?, progress_notes=?, progress_date=?,
          updated_at=?, updated_by=?, updated_by_user_id=?, updated_action=?, price_basis=?,
          start_date=?, target_end_date=?, actual_end_date=?, plan_percent=?, weight_factor=?, assigned_to=?,
          subcontractor=?, opname_status=?, opname_qty=?, opname_percent=?, opname_date=?, opname_inspector=?, opname_notes=?, opname_bapo_no=?
         WHERE id=?`,
        [
          item.categoryId,
          item.itemNo,
          item.description,
          item.type || '',
          item.d1 || '',
          item.d2 || '',
          item.d3 || '',
          item.dLen || '',
          item.d4 || '',
          item.qty,
          item.unit,
          item.weightKg || 0,
          item.unitPrice,
          totalPrice,
          item.remark || '',
          item.remark2 || '',
          isCompleted ? 1 : 0,
          item.notes || '',
          item.parentId || null,
          item.itemLevel !== undefined ? item.itemLevel : null,
          item.isAreaHeader ? 1 : 0,
          progressPercent,
          item.progressQty !== undefined ? item.progressQty : null,
          item.progressNotes || null,
          item.progressDate || null,
          nowIso,
          actorInfo.display,
          actorInfo.id || null,
          item.updatedAction || 'updated',
          item.priceBasis || null,
          item.startDate || null,
          item.targetEndDate || null,
          item.actualEndDate || null,
          item.planPercent !== undefined ? item.planPercent : null,
          item.weightFactor !== undefined ? item.weightFactor : null,
          item.assignedTo || item.subcontractor || null,
          item.subcontractor || item.assignedTo || null,
          item.opnameStatus || null,
          item.opnameQty !== undefined && item.opnameQty !== null ? item.opnameQty : null,
          item.opnamePercent !== undefined && item.opnamePercent !== null ? item.opnamePercent : null,
          item.opnameDate || null,
          item.opnameInspector || null,
          item.opnameNotes || null,
          item.opnameBapoNo || null,
          item.id,
        ]
      );
    });

    this.persist();
    this.notifyListeners();
  }

  public addOpnameWorkItem(
    item: Omit<WorkItem, 'id'>,
    actor?: string | { name?: string; role?: string; id?: string }
  ): string {
    if (!this.db) return '';
    const actorInfo = this.getActorInfo(actor);
    const nowIso = new Date().toISOString();

    const stampedItem: Omit<WorkItem, 'id'> = {
      ...item,
      updatedAt: nowIso,
      updatedBy: actorInfo.display,
      updatedByUserId: actorInfo.id,
      updatedAction: 'created',
    };

    const currentItems = this.getOpnameWorkItems(false);
    const { updatedItems, createdItem } = addAndResequenceWorkItem(currentItems, stampedItem);
    this.importOpnameWorkItems(updatedItems, 'replace');

    return createdItem.id;
  }

  public deleteOpnameWorkItem(
    id: string,
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db) return;
    const currentItems = this.getOpnameWorkItems(false);
    const { updatedItems } = cascadeDeleteWorkItem(currentItems, id);
    this.importOpnameWorkItems(updatedItems, 'replace');
  }

  public deleteOpnameWorkItems(
    ids: string[],
    actor?: string | { name?: string; role?: string; id?: string }
  ): void {
    if (!this.db || ids.length === 0) return;
    const currentItems = this.getOpnameWorkItems(false);
    const { updatedItems } = cascadeDeleteWorkItems(currentItems, ids);
    this.importOpnameWorkItems(updatedItems, 'replace');
  }

  public resequenceOpnameWorkItems(categoryId?: string): void {
    if (!this.db) return;
    const currentItems = this.getOpnameWorkItems(false);
    const updated = categoryId
      ? resequenceCategoryItems(currentItems, categoryId)
      : resequenceAllWorkItems(currentItems);
    this.importOpnameWorkItems(updated, 'replace');
  }

  public clearAllOpnameWorkItems(): void {
    if (this.isUsingFallback) {
      if (this.db) {
        this.db.run('DELETE FROM opname_work_items');
      }
      this.notifyListeners();
      return;
    }
    if (!this.db) return;
    try {
      this.db.run('DELETE FROM opname_work_items');
      this.executePersist();
      this.notifyListeners();
    } catch (e) {
      console.error('clearAllOpnameWorkItems error', e);
    }
  }

  public importOpnameWorkItems(items: WorkItem[], mode: 'replace' | 'append'): void {
    if (!this.db) return;

    if (mode === 'replace') {
      this.db.run('DELETE FROM opname_work_items');
    }

    if (items.length === 0) {
      this.executePersist();
      this.notifyListeners();
      return;
    }

    items.forEach((item) => {
      const id = item.id || `opname-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const basis = item.priceBasis || (item.unit === 'kg' && (item.weightKg || 0) > 0 ? 'weight' : 'qty');
      const totalPrice =
        item.totalPrice !== undefined && item.totalPrice !== null && !isNaN(item.totalPrice)
          ? item.totalPrice
          : basis === 'weight' && (item.weightKg || 0) > 0
          ? Math.round((item.weightKg || 0) * (item.unitPrice || 0))
          : Math.round((item.qty || 0) * (item.unitPrice || 0));

      const progressPercent =
        item.progressPercent !== undefined
          ? item.progressPercent
          : item.isCompleted
          ? 100
          : 0;

      const isCompleted = progressPercent >= 100 || Boolean(item.isCompleted);

      this.db.run(
        `INSERT OR REPLACE INTO opname_work_items (
          id, project_id, category_id, item_no, description, type, d1, d2, d3, d_len, d4, qty, unit, 
          weight_kg, unit_price, total_price, remark, remark2, is_completed, notes,
          parent_id, item_level, is_area_header, progress_percent, progress_qty, progress_notes, progress_date,
          updated_at, updated_by, updated_by_user_id, updated_action, price_basis,
          start_date, target_end_date, actual_start_date, actual_end_date, plan_percent, weight_factor, assigned_to,
          subcontractor, opname_status, opname_qty, opname_percent, opname_date, opname_inspector, opname_notes, opname_bapo_no,
          daily_logs_json, plan_logs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          item.projectId || 'proj-f049',
          item.categoryId || 'cat-1',
          item.itemNo || '',
          item.description || 'Pekerjaan',
          item.type || '',
          item.d1 || '',
          item.d2 || '',
          item.d3 || '',
          item.dLen || '',
          item.d4 || '',
          item.qty !== undefined && item.qty !== null ? item.qty : 0,
          item.unit || '',
          item.weightKg || 0,
          item.unitPrice || 0,
          totalPrice,
          item.remark || '',
          item.remark2 || '',
          isCompleted ? 1 : 0,
          item.notes || '',
          item.parentId || null,
          item.itemLevel !== undefined ? item.itemLevel : null,
          item.isAreaHeader ? 1 : 0,
          progressPercent,
          item.progressQty !== undefined ? item.progressQty : null,
          item.progressNotes || null,
          item.progressDate || null,
          item.updatedAt || null,
          item.updatedBy || null,
          item.updatedByUserId || null,
          item.updatedAction || null,
          item.priceBasis || null,
          item.startDate || null,
          item.targetEndDate || null,
          item.actualStartDate || null,
          item.actualEndDate || null,
          item.planPercent !== undefined ? item.planPercent : null,
          item.weightFactor !== undefined ? item.weightFactor : null,
          item.assignedTo || item.subcontractor || null,
          item.subcontractor || item.assignedTo || null,
          item.opnameStatus || null,
          item.opnameQty !== undefined && item.opnameQty !== null ? item.opnameQty : null,
          item.opnamePercent !== undefined && item.opnamePercent !== null ? item.opnamePercent : null,
          item.opnameDate || null,
          item.opnameInspector || null,
          item.opnameNotes || null,
          item.opnameBapoNo || null,
          item.dailyLogs ? JSON.stringify(item.dailyLogs) : null,
          item.planLogs ? JSON.stringify(item.planLogs) : null,
        ]
      );
    });

    this.persist();
    this.notifyListeners();
  }

  public syncOpnameFromRepairList(mode: 'replace' | 'merge_new' = 'replace'): void {
    if (!this.db) return;
    const repairItems = this.getWorkItems();
    if (mode === 'replace') {
      const cloned: WorkItem[] = repairItems.map((it) => ({
        ...it,
        opnameStatus: it.opnameStatus || 'Belum Diperiksa',
        opnamePercent: it.opnamePercent !== undefined ? it.opnamePercent : (it.progressPercent || 0),
        opnameQty: it.opnameQty !== undefined ? it.opnameQty : (it.progressQty !== undefined ? it.progressQty : it.qty),
      }));
      this.importOpnameWorkItems(cloned, 'replace');
    } else {
      const currentOpname = this.getOpnameWorkItems(false);
      const existingIds = new Set(currentOpname.map((o) => o.id));
      const newItems: WorkItem[] = [];
      repairItems.forEach((r) => {
        if (!existingIds.has(r.id)) {
          newItems.push({
            ...r,
            opnameStatus: r.opnameStatus || 'Belum Diperiksa',
            opnamePercent: r.opnamePercent !== undefined ? r.opnamePercent : (r.progressPercent || 0),
            opnameQty: r.opnameQty !== undefined ? r.opnameQty : (r.progressQty !== undefined ? r.progressQty : r.qty),
          });
        }
      });
      if (newItems.length > 0) {
        const merged = [...currentOpname, ...newItems];
        this.importOpnameWorkItems(merged, 'replace');
      }
    }
  }

  // --- DEFECT SURVEY METHODS (Matching Flutter Survey Screen) ---

  public getDefectSurveys(): DefectSurvey[] {
    if (!this.db) return DEFAULT_DEFECT_SURVEYS;
    try {
       const res = this.db.exec(`
        SELECT id, project_id, location_zone, defect_description, length, width, thickness, plate_type, calculated_weight_kg, sync_status, created_at, transferred_to_work_item_id, remedy_action
        FROM defect_surveys ORDER BY created_at DESC
      `);
      if (res.length > 0) {
        return res[0].values.map((r) => ({
          id: String(r[0]),
          projectId: String(r[1]),
          locationZone: String(r[2]),
          defectDescription: String(r[3]),
          length: Number(r[4]),
          width: Number(r[5]),
          thickness: Number(r[6]),
          plateType: String(r[7] || ''),
          calculatedWeightKg: Number(r[8]),
          syncStatus: Number(r[9]),
          createdAt: String(r[10]),
          transferredToWorkItemId: String(r[11] || ''),
          remedyAction: String(r[12] || ''),
        }));
      }
      return [];
    } catch (e) {
      console.error('getDefectSurveys error', e);
    }
    return DEFAULT_DEFECT_SURVEYS;
  }

  public addDefectSurvey(surv: Omit<DefectSurvey, 'id' | 'createdAt'>): string {
    if (!this.db) return '';
    const id = `surv-${Date.now()}`;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 16);

    this.db.run(
      `INSERT INTO defect_surveys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        surv.projectId,
        surv.locationZone,
        surv.defectDescription,
        surv.length,
        surv.width,
        surv.thickness,
        surv.plateType || 'Mild Steel BKI Grade A',
        surv.calculatedWeightKg,
        surv.syncStatus ?? 0,
        now,
        surv.transferredToWorkItemId || '',
        surv.remedyAction || '',
      ]
    );
    this.persist();
    this.notifyListeners();
    return id;
  }

  public updateDefectSurvey(surv: DefectSurvey): void {
    if (!this.db) return;
    this.db.run(
      `UPDATE defect_surveys SET location_zone=?, defect_description=?, length=?, width=?, thickness=?, plate_type=?, calculated_weight_kg=?, sync_status=?, remedy_action=? WHERE id=?`,
      [
        surv.locationZone,
        surv.defectDescription,
        surv.length,
        surv.width,
        surv.thickness,
        surv.plateType || '',
        surv.calculatedWeightKg,
        surv.syncStatus,
        surv.remedyAction || '',
        surv.id,
      ]
    );
    this.persist();
    this.notifyListeners();
  }

  public deleteDefectSurvey(id: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM defect_surveys WHERE id = ?', [id]);
    this.persist();
    this.notifyListeners();
  }

  public syncAllSurveys(): void {
    if (!this.db) return;
    this.db.run('UPDATE defect_surveys SET sync_status = 1');
    this.persist();
    this.notifyListeners();
  }

  /**
   * Transfer Defect Survey langsung menjadi Item Pekerjaan di BoQ / Repair List (Pipa, Profil, atau Pelat)
   */
  public convertSurveyToWorkItem(surveyId: string): string {
    if (!this.db) return '';
    const surveys = this.getDefectSurveys();
    const survey = surveys.find((s) => s.id === surveyId);
    if (!survey) return '';

    const lengthMm = Math.round(survey.length * 1000);
    const widthMm = Math.round(survey.width * 1000);
    const pType = (survey.plateType || '').toLowerCase();
    const remedy = (survey.remedyAction || '').toLowerCase();

    let categoryId = 'cat-7'; // VII. Konstruksi Lambung (Hull Construction)
    let typeCode = 'PL AB';
    let unitPrice = 48000;
    let d1 = String(lengthMm);
    let d2 = String(widthMm);
    let d3 = String(survey.thickness);
    let d4 = '1 (Ea)';

    if (pType.includes('pipa') || remedy.includes('pipe')) {
      categoryId = 'cat-6'; // VI. Pekerjaan Pemipaan (Piping System)
      typeCode = 'PP-B';
      unitPrice = 55000;
      d1 = String(Math.round(survey.length));
      d2 = String(survey.thickness);
      d3 = survey.plateType || 'Sch 40';
      d4 = '1 (Btg)';
    } else if (pType.includes('grating')) {
      typeCode = 'GRATING';
      unitPrice = 65000;
      d3 = 'Grating 25x5';
      d4 = `${(survey.length * survey.width).toFixed(2)} m²`;
    } else if (pType.includes('bordes') || pType.includes('chequered')) {
      typeCode = 'PL-BORDES';
      unitPrice = 50000;
      d3 = `${survey.thickness} mm`;
      d4 = '1 (Lbr)';
    } else if (pType.includes('h-beam') || pType.includes('wf')) {
      typeCode = 'H-BEAM';
      unitPrice = 52000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('siku') || pType.includes('angle')) {
      typeCode = 'UA';
      unitPrice = 48000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('flat bar') || pType.includes('strip')) {
      typeCode = 'FB';
      unitPrice = 48000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('round bar') || pType.includes('besi as')) {
      typeCode = 'RB';
      unitPrice = 56000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('square bar') || pType.includes('nako')) {
      typeCode = 'SB';
      unitPrice = 52000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('unp') || pType.includes('channel')) {
      typeCode = 'UNP';
      unitPrice = 49000;
      d4 = `${survey.length}m (1 btg)`;
    } else if (pType.includes('abs')) {
      typeCode = 'PL ABS';
      unitPrice = 52000;
    } else if (pType.includes('nc') || pType.includes('non-class') || pType.includes('non class')) {
      typeCode = 'PL NC';
      unitPrice = 42000;
    } else {
      // Default: Marine Class BKI
      typeCode = 'PL BKI';
      unitPrice = 48000;
    }

    const actionTitle = survey.remedyAction || 'Perbaikan / Replating';
    const workItemId = this.addWorkItem({
      projectId: survey.projectId,
      categoryId,
      itemNo: 'Survey-Item',
      description: `${actionTitle} zona ${survey.locationZone} (${survey.defectDescription} - ${survey.plateType || 'Baja'})`,
      type: typeCode,
      d1,
      d2,
      d3,
      d4,
      qty: 1,
      unit: 'kg',
      weightKg: survey.calculatedWeightKg,
      unitPrice,
      totalPrice: survey.calculatedWeightKg * unitPrice,
      remark: `Defect Survey Ref: ${survey.id}`,
    });

    this.db.run('UPDATE defect_surveys SET transferred_to_work_item_id = ? WHERE id = ?', [
      workItemId,
      surveyId,
    ]);
    this.persist();
    this.notifyListeners();
    return workItemId;
  }

  // --- SIGNATURES ---

  public getSignatures(): Signatures {
    if (!this.db) return DEFAULT_SIGNATURES;
    try {
      const res = this.db.exec('SELECT prepared_by_name, prepared_by_title, reviewed_by_name, reviewed_by_title, verified_by_name, verified_by_title FROM signatures WHERE id = 1');
      if (res.length > 0 && res[0].values.length > 0) {
        const r = res[0].values[0];
        return {
          preparedByName: String(r[0] || DEFAULT_SIGNATURES.preparedByName),
          preparedByTitle: String(r[1] || DEFAULT_SIGNATURES.preparedByTitle),
          reviewedByName: String(r[2] || DEFAULT_SIGNATURES.reviewedByName),
          reviewedByTitle: String(r[3] || DEFAULT_SIGNATURES.reviewedByTitle),
          verifiedByName: String(r[4] || DEFAULT_SIGNATURES.verifiedByName),
          verifiedByTitle: String(r[5] || DEFAULT_SIGNATURES.verifiedByTitle),
        };
      }
    } catch (e) {
      console.error('getSignatures error', e);
    }
    return DEFAULT_SIGNATURES;
  }

  public updateSignatures(sig: Signatures): void {
    if (!this.db) return;
    const s = sig ? { ...DEFAULT_SIGNATURES, ...sig } : { ...DEFAULT_SIGNATURES };
    try {
      this.db.run(
        `INSERT OR REPLACE INTO signatures (id, prepared_by_name, prepared_by_title, reviewed_by_name, reviewed_by_title, verified_by_name, verified_by_title)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        [
          s.preparedByName || DEFAULT_SIGNATURES.preparedByName,
          s.preparedByTitle || DEFAULT_SIGNATURES.preparedByTitle,
          s.reviewedByName || DEFAULT_SIGNATURES.reviewedByName,
          s.reviewedByTitle || DEFAULT_SIGNATURES.reviewedByTitle,
          s.verifiedByName || DEFAULT_SIGNATURES.verifiedByName,
          s.verifiedByTitle || DEFAULT_SIGNATURES.verifiedByTitle,
        ]
      );
    } catch (e) {
      console.error('updateSignatures error', e);
    }
    this.persist();
    this.notifyListeners();
  }

  // --- SQL CONSOLE & IMPORT/EXPORT ---

  public runRawQuery(sql: string): { columns: string[]; values: any[][]; error?: string } {
    if (!this.db) return { columns: [], values: [], error: 'Database belum terinisialisasi.' };
    try {
      const res = this.db.exec(sql);
      this.persist();
      this.notifyListeners();
      if (res.length === 0) {
        return { columns: ['Result'], values: [['Query berhasil dieksekusi (0 baris dikembalikan)']] };
      }
      return {
        columns: res[0].columns,
        values: res[0].values,
      };
    } catch (e: any) {
      return { columns: [], values: [], error: e.message || String(e) };
    }
  }

  public exportDatabaseBinary(): Uint8Array | null {
    if (!this.db) return null;
    return this.db.export();
  }

  public exportSqlDump(): string {
    if (!this.db) return '';
    const tables = ['vessels', 'projects', 'work_categories', 'work_items', 'defect_surveys', 'signatures'];
    let dump = `-- Shipyard Repair SQLite Database Dump\n-- Generated for TB. KSA BINTANG (PPC / Pimpro)\n-- Date: ${new Date().toISOString()}\n\n`;

    tables.forEach((table) => {
      dump += `-- Table: ${table}\n`;
      const res = this.db!.exec(`SELECT * FROM ${table}`);
      if (res.length > 0) {
        const cols = res[0].columns.join(', ');
        res[0].values.forEach((row) => {
          const vals = row
            .map((v) => {
              if (v === null) return 'NULL';
              if (typeof v === 'number') return v;
              return `'${String(v).replace(/'/g, "''")}'`;
            })
            .join(', ');
          dump += `INSERT INTO ${table} (${cols}) VALUES (${vals});\n`;
        });
      }
      dump += '\n';
    });

    return dump;
  }

  public async importDatabaseBinary(bytes: Uint8Array): Promise<void> {
    if (!this.sqlJsInstance) {
      await this.init();
    }
    if (this.sqlJsInstance) {
      this.db = new this.sqlJsInstance.Database(bytes);
      this.wrapDatabaseMethods();
      this.persist();
      this.notifyListeners();
    }
  }

  public importCategories(categories: WorkCategory[]): void {
    if (!this.db || !Array.isArray(categories) || categories.length === 0) return;
    try {
      this.db.run('DELETE FROM work_categories');
      const stmtCat = this.db.prepare('INSERT OR REPLACE INTO work_categories VALUES (?, ?, ?, ?)');
      categories.forEach((cat) => {
        if (cat) {
          stmtCat.run([cat.id, cat.code, cat.name, cat.sortOrder]);
        }
      });
      stmtCat.free();
      this.persist();
      this.notifyListeners();
    } catch (e) {
      console.error('importCategories error:', e);
    }
  }

  public importDefectSurveys(surveys: DefectSurvey[]): void {
    if (!this.db || !Array.isArray(surveys)) return;
    try {
      this.db.run('DELETE FROM defect_surveys');
      const fallbackVesselId = this.getVessel()?.id || 'proj-f049';
      surveys.forEach((surv) => {
        if (surv) {
          const id = surv.id || `surv-${Date.now()}`;
          const createdAt = surv.createdAt || new Date().toISOString().replace('T', ' ').substring(0, 16);
          this.db.run(
            `INSERT OR REPLACE INTO defect_surveys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              surv.projectId || fallbackVesselId,
              surv.locationZone || '',
              surv.defectDescription || '',
              surv.length || 0,
              surv.width || 0,
              surv.thickness || 0,
              surv.plateType || 'Mild Steel BKI Grade A',
              surv.calculatedWeightKg || 0,
              surv.syncStatus ?? 0,
              createdAt,
              surv.transferredToWorkItemId || '',
              surv.remedyAction || '',
            ]
          );
        }
      });
      this.persist();
      this.notifyListeners();
    } catch (e) {
      console.error('importDefectSurveys error:', e);
    }
  }

  public loadProjectData(proj: import('../types').ShipyardProject | any): void {
    if (!this.db) return;
    const prevSuppress = this.suppressNotify;
    this.suppressNotify = true;
    try {
      const currentSchedule = this.getProjectSchedule();
      const currentVessel = this.getVessel();
      const isSameProject = Boolean(
        (proj?.id && currentSchedule?.id === proj.id) ||
        (proj?.vessel?.id && currentVessel?.id === proj.vessel.id)
      );

      const existingLogsMap = new Map<string, { dailyLogs?: any; planLogs?: any; progressPercent?: number; isCompleted?: boolean }>();
      if (isSameProject) {
        const existingItems = this.getWorkItems();
        existingItems.forEach((it) => {
          if (it && it.id) {
            existingLogsMap.set(it.id, {
              dailyLogs: it.dailyLogs,
              planLogs: it.planLogs,
              progressPercent: it.progressPercent,
              isCompleted: it.isCompleted,
            });
          }
          if (it && it.description) {
            existingLogsMap.set(it.description.trim().toLowerCase(), {
              dailyLogs: it.dailyLogs,
              planLogs: it.planLogs,
              progressPercent: it.progressPercent,
              isCompleted: it.isCompleted,
            });
          }
        });
      }

      this.db.run('DELETE FROM work_items');
      this.db.run('DELETE FROM opname_work_items');
      this.db.run('DELETE FROM defect_surveys');
      this.db.run('DELETE FROM work_categories');
      this.db.run('DELETE FROM projects');
      this.db.run('DELETE FROM vessels');
      this.db.run('DELETE FROM signatures');

      const safeVessel = proj?.vessel || DEFAULT_VESSEL;
      const safeSchedule = proj?.schedule || DEFAULT_SCHEDULE;
      const safeCategories = proj?.categories && Array.isArray(proj.categories) ? proj.categories : DEFAULT_CATEGORIES;
      const safeWorkItems = proj?.workItems && Array.isArray(proj.workItems) ? proj.workItems : [];
      const hasExplicitOpname = Array.isArray(proj?.opnameItems);
      const safeOpnameItems = hasExplicitOpname ? proj.opnameItems : [];
      const safeDefects = proj?.defectSurveys && Array.isArray(proj.defectSurveys) ? proj.defectSurveys : [];
      const safeSignatures = proj?.signatures || DEFAULT_SIGNATURES;

      const mergedWorkItems = safeWorkItems.map((it: any) => {
        if (!it || !isSameProject) return it;
        const found = existingLogsMap.get(it.id) || existingLogsMap.get((it.description || '').trim().toLowerCase());
        if (found) {
          return {
            ...it,
            dailyLogs: it.dailyLogs && Object.keys(it.dailyLogs).length > 0 ? it.dailyLogs : found.dailyLogs,
            planLogs: it.planLogs && Object.keys(it.planLogs).length > 0 ? it.planLogs : found.planLogs,
            progressPercent:
              it.progressPercent !== undefined && it.progressPercent > 0
                ? it.progressPercent
                : found.progressPercent,
            isCompleted: it.isCompleted !== undefined ? it.isCompleted : found.isCompleted,
          };
        }
        return it;
      });

      // Vessel
      this.updateVessel(safeVessel);
      // Schedule
      this.updateProjectSchedule(safeSchedule);
      // Categories
      const stmtCat = this.db.prepare('INSERT OR REPLACE INTO work_categories VALUES (?, ?, ?, ?)');
      safeCategories.forEach((cat: any) => {
        if (cat) {
          stmtCat.run([cat.id, cat.code, cat.name, cat.sortOrder]);
        }
      });
      stmtCat.free();
      // Work items
      if (mergedWorkItems.length > 0) {
        this.importWorkItems(mergedWorkItems, 'replace');
      }
      // Opname items
      if (safeOpnameItems.length > 0) {
        this.importOpnameWorkItems(safeOpnameItems, 'replace');
      } else if (!hasExplicitOpname && mergedWorkItems.length > 0) {
        this.syncOpnameFromRepairList('replace');
      }
      // Defect surveys
      safeDefects.forEach((surv: any) => {
        if (surv) {
          const id = surv.id || `surv-${Date.now()}`;
          const createdAt = surv.createdAt || new Date().toISOString().replace('T', ' ').substring(0, 16);
          this.db.run(
            `INSERT OR REPLACE INTO defect_surveys VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              surv.projectId || safeVessel.id,
              surv.locationZone || '',
              surv.defectDescription || '',
              surv.length || 0,
              surv.width || 0,
              surv.thickness || 0,
              surv.plateType || 'Mild Steel BKI Grade A',
              surv.calculatedWeightKg || 0,
              surv.syncStatus ?? 0,
              createdAt,
              surv.transferredToWorkItemId || '',
              surv.remedyAction || '',
            ]
          );
        }
      });
      // Signatures
      this.updateSignatures(safeSignatures);

      this.executePersist();
    } catch (e) {
      console.error('Error loading project data into SQLite:', e);
    } finally {
      this.suppressNotify = prevSuppress;
    }
    this.notifyListeners();
  }

  public resetPlanAndProgress(mode: 'progress_only' | 'all' = 'all'): void {
    const nowIso = new Date().toISOString();

    // Clean up any localStorage daily logs/reports for shipyard
    if (typeof window !== 'undefined') {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('shipyard_daily_') || key.startsWith('shipyard_report_'))) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
      } catch (e) {
        console.warn('localStorage clean error:', e);
      }
    }

    if (!this.db) {
      if (this.isUsingFallback) {
        const saved = localStorage.getItem(DB_FALLBACK_JSON_KEY);
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            if (parsed.workItems && Array.isArray(parsed.workItems)) {
              parsed.workItems = parsed.workItems.map((w: any) => ({
                ...w,
                progressPercent: 0,
                progressQty: 0,
                isCompleted: false,
                progressNotes: '',
                progressDate: undefined,
                actualEndDate: undefined,
                dailyLogs: {},
                ...(mode === 'all' ? { planPercent: 0 } : {}),
              }));
              localStorage.setItem(DB_FALLBACK_JSON_KEY, JSON.stringify(parsed));
            }
          } catch (e) {
            console.warn(e);
          }
        }
        this.notifyListeners();
      }
      return;
    }

    try {
      if (mode === 'progress_only') {
        this.db.run(`
          UPDATE work_items SET 
            progress_percent = 0, 
            progress_qty = 0, 
            is_completed = 0, 
            progress_notes = '', 
            progress_date = NULL, 
            actual_end_date = NULL, 
            updated_at = ?,
            updated_action = 'progress_reset'
        `, [nowIso]);
      } else {
        this.db.run(`
          UPDATE work_items SET 
            progress_percent = 0, 
            progress_qty = 0, 
            is_completed = 0, 
            progress_notes = '', 
            progress_date = NULL, 
            actual_end_date = NULL,
            plan_percent = 0,
            updated_at = ?,
            updated_action = 'plan_and_progress_reset'
        `, [nowIso]);
      }

      this.persist();
      this.notifyListeners();
    } catch (e) {
      console.error('resetPlanAndProgress error:', e);
    }
  }

  public verifyPersistence(memoryWorkItems?: WorkItem[]): import('../utils/persistenceDiagnostics').PersistenceDiagnosticReport {
    const memoryItems = memoryWorkItems || this.getWorkItems();
    const memoryVessel = this.getVessel();
    const memorySchedule = this.getProjectSchedule();
    const memoryOpname = this.getOpnameWorkItems();
    return verifyDataPersistence(
      {
        workItems: memoryItems,
        vessel: memoryVessel,
        schedule: memorySchedule,
        opnameItems: memoryOpname,
      },
      this
    );
  }

  public resetDatabase(): void {
    if (!this.db) return;
    localStorage.removeItem(DB_STORAGE_KEY);
    this.db.run(`
      DROP TABLE IF EXISTS work_items;
      DROP TABLE IF EXISTS opname_work_items;
      DROP TABLE IF EXISTS defect_surveys;
      DROP TABLE IF EXISTS work_categories;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS vessels;
      DROP TABLE IF EXISTS signatures;
    `);
    this.createSchema();
    this.seedInitialData();
    this.persist();
    this.notifyListeners();
  }
}

export const sqliteService = new SqliteService();
