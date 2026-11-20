import { ProjectMaterialEstimate, ProjectResourceItem } from '../types';

export interface ProjectCloudExtras {
  materialEstimates?: ProjectMaterialEstimate[];
  projectResources?: ProjectResourceItem[];
  satisfactionNotes?: Record<string, string>;
  satisfactionStatus?: Record<string, string>;
  overheadPercent?: number;
  ppnPercent?: number;
  milestones?: any[];
  googleSheetsLink?: any;
}

let isHydratingFromCloud = false;

export function setHydratingFromCloud(flag: boolean): void {
  isHydratingFromCloud = flag;
}

export function notifyCloudDirty(projectId?: string): void {
  if (isHydratingFromCloud || typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('shipyard-cloud-dirty', {
      detail: { projectId },
    })
  );
}

export function collectProjectExtras(project: {
  id: string;
  vessel?: { id?: string; projectNo?: string };
}): ProjectCloudExtras {
  if (typeof localStorage === 'undefined' || !project?.id) return {};

  const extras: ProjectCloudExtras = {};
  const projectId = project.id;
  const vesselId = project.vessel?.id || '';
  const projectNo = project.vessel?.projectNo || '';
  const satKeySuffix = vesselId || projectNo || 'default';

  try {
    const matRaw = localStorage.getItem(`shipyard_material_estimates_v1_${projectId}`);
    if (matRaw !== null) {
      const parsed = JSON.parse(matRaw);
      if (Array.isArray(parsed)) extras.materialEstimates = parsed;
    }
  } catch {
    // ignore
  }

  try {
    const resRaw = localStorage.getItem(`shipyard_project_resources_v1_${projectId}`);
    if (resRaw !== null) {
      const parsed = JSON.parse(resRaw);
      if (Array.isArray(parsed)) extras.projectResources = parsed;
    }
  } catch {
    // ignore
  }

  try {
    const satNotesRaw =
      localStorage.getItem(`satisfaction_notes_${satKeySuffix}`) ||
      localStorage.getItem(`satisfaction_notes_${projectId}`);
    if (satNotesRaw !== null) {
      const parsed = JSON.parse(satNotesRaw);
      if (parsed && typeof parsed === 'object') extras.satisfactionNotes = parsed;
    }
  } catch {
    // ignore
  }

  try {
    const satStatusRaw =
      localStorage.getItem(`satisfaction_rab_status_${satKeySuffix}`) ||
      localStorage.getItem(`satisfaction_rab_status_${projectId}`);
    if (satStatusRaw !== null) {
      const parsed = JSON.parse(satStatusRaw);
      if (parsed && typeof parsed === 'object') extras.satisfactionStatus = parsed;
    }
  } catch {
    // ignore
  }

  try {
    const ohRaw = localStorage.getItem(`shipyard_overhead_percent_${vesselId || 'default'}`);
    if (ohRaw !== null) {
      const num = parseFloat(ohRaw);
      if (!isNaN(num)) extras.overheadPercent = num;
    }
  } catch {
    // ignore
  }

  try {
    const ppnRaw = localStorage.getItem(`shipyard_ppn_percent_${vesselId || 'default'}`);
    if (ppnRaw !== null) {
      const num = parseFloat(ppnRaw);
      if (!isNaN(num)) extras.ppnPercent = num;
    }
  } catch {
    // ignore
  }

  try {
    const milRaw = localStorage.getItem(`shipyard_milestones_${vesselId || projectId || 'proj-f049'}`);
    if (milRaw !== null) {
      const parsed = JSON.parse(milRaw);
      if (Array.isArray(parsed)) extras.milestones = parsed;
    }
  } catch {
    // ignore
  }

  try {
    const gsRaw = localStorage.getItem(`shipyard_gsheet_link_${projectId}`);
    if (gsRaw !== null) {
      extras.googleSheetsLink = JSON.parse(gsRaw);
    }
  } catch {
    // ignore
  }

  return extras;
}

export function applyProjectExtras(
  project: { id: string; vessel?: { id?: string; projectNo?: string } },
  extras?: ProjectCloudExtras | null
): void {
  if (typeof localStorage === 'undefined' || !project?.id || !extras) return;

  const projectId = project.id;
  const vesselId = project.vessel?.id || '';
  const projectNo = project.vessel?.projectNo || '';
  const satKeySuffix = vesselId || projectNo || 'default';

  const prevFlag = isHydratingFromCloud;
  isHydratingFromCloud = true;
  try {
    if (Array.isArray(extras.materialEstimates)) {
      localStorage.setItem(
        `shipyard_material_estimates_v1_${projectId}`,
        JSON.stringify(extras.materialEstimates)
      );
    }

    if (Array.isArray(extras.projectResources)) {
      localStorage.setItem(
        `shipyard_project_resources_v1_${projectId}`,
        JSON.stringify(extras.projectResources)
      );
    }

    if (extras.satisfactionNotes && typeof extras.satisfactionNotes === 'object') {
      localStorage.setItem(
        `satisfaction_notes_${satKeySuffix}`,
        JSON.stringify(extras.satisfactionNotes)
      );
    }

    if (extras.satisfactionStatus && typeof extras.satisfactionStatus === 'object') {
      localStorage.setItem(
        `satisfaction_rab_status_${satKeySuffix}`,
        JSON.stringify(extras.satisfactionStatus)
      );
    }

    if (typeof extras.overheadPercent === 'number' && !isNaN(extras.overheadPercent)) {
      localStorage.setItem(
        `shipyard_overhead_percent_${vesselId || 'default'}`,
        String(extras.overheadPercent)
      );
    }

    if (typeof extras.ppnPercent === 'number' && !isNaN(extras.ppnPercent)) {
      localStorage.setItem(
        `shipyard_ppn_percent_${vesselId || 'default'}`,
        String(extras.ppnPercent)
      );
    }

    if (Array.isArray(extras.milestones)) {
      localStorage.setItem(
        `shipyard_milestones_${vesselId || projectId || 'proj-f049'}`,
        JSON.stringify(extras.milestones)
      );
    }

    if (extras.googleSheetsLink && typeof extras.googleSheetsLink === 'object') {
      localStorage.setItem(
        `shipyard_gsheet_link_${projectId}`,
        JSON.stringify(extras.googleSheetsLink)
      );
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('shipyard-cloud-hydrated', {
          detail: { projectId },
        })
      );
    }
  } catch (e) {
    console.warn('Failed to apply project extras to localStorage:', e);
  } finally {
    isHydratingFromCloud = prevFlag;
  }
}
