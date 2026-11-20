import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { sqliteService } from './services/sqliteService';
import { authService } from './services/authService';
import { projectService } from './services/projectService';
import {
  VesselSpec,
  ProjectSchedule,
  WorkCategory,
  WorkItem,
  DefectSurvey,
  Signatures,
  CostSummary,
  UserProfile,
  ShipyardProject,
} from './types';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { ProjectSelectionHub } from './components/ProjectSelectionHub';
import { RepairListTable } from './components/RepairListTable';
import { materialEstimationService } from './services/materialEstimationService';
import { firebaseSyncService, CloudConnectionState, CLIENT_INSTANCE_ID } from './services/firebaseSyncService';
import { collectProjectExtras, applyProjectExtras } from './services/projectExtrasSync';
import { CustomDialogModal } from './components/CustomDialogModal';

const OpnameVerificationTable = lazy(() =>
  import('./components/OpnameVerificationTable').then((m) => ({ default: m.OpnameVerificationTable }))
);
const DefectSurveyList = lazy(() =>
  import('./components/DefectSurveyList').then((m) => ({ default: m.DefectSurveyList }))
);
const DefectSurveyModal = lazy(() =>
  import('./components/DefectSurveyModal').then((m) => ({ default: m.DefectSurveyModal }))
);
const RabModule = lazy(() =>
  import('./components/RabModule').then((m) => ({ default: m.RabModule }))
);
const MaterialEstimationView = lazy(() =>
  import('./components/MaterialEstimation/MaterialEstimationView').then((m) => ({ default: m.MaterialEstimationView }))
);
const PlanProgressModule = lazy(() =>
  import('./components/PlanProgressModule').then((m) => ({ default: m.PlanProgressModule }))
);
const SatisfactionNoteModule = lazy(() =>
  import('./components/SatisfactionNoteModule').then((m) => ({ default: m.SatisfactionNoteModule }))
);
const WorkDoneReportModule = lazy(() =>
  import('./components/WorkDoneReportModule').then((m) => ({ default: m.WorkDoneReportModule }))
);
const SqliteConsoleModal = lazy(() =>
  import('./components/SqliteConsoleModal').then((m) => ({ default: m.SqliteConsoleModal }))
);
const PdfExportModal = lazy(() =>
  import('./components/PdfExportModal').then((m) => ({ default: m.PdfExportModal }))
);
const VesselProjectModal = lazy(() =>
  import('./components/VesselProjectModal').then((m) => ({ default: m.VesselProjectModal }))
);
const ExportImportModal = lazy(() =>
  import('./components/ExportImportModal').then((m) => ({ default: m.ExportImportModal }))
);

const TabLoadingFallback = (
  <div className="w-full py-16 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs font-medium">
    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    <span>Memuat modul...</span>
  </div>
);
import {
  DEFAULT_VESSEL,
  DEFAULT_SCHEDULE,
  DEFAULT_CATEGORIES,
  DEFAULT_WORK_ITEMS,
  DEFAULT_DEFECT_SURVEYS,
  DEFAULT_SIGNATURES,
} from './data/shipyardSeedData';

export default function App() {
  // Auth & Project Hub State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => authService.getCurrentUser());
  const [currentProject, setCurrentProject] = useState<ShipyardProject | null>(() => projectService.getActiveProject());
  const [allProjects, setAllProjects] = useState<ShipyardProject[]>(() => projectService.getAllProjects());
  const [currentView, setCurrentView] = useState<'login' | 'projects-hub' | 'workspace'>(() => {
    const saved = localStorage.getItem('shipyard_current_view');
    if (saved === 'workspace' && authService.getCurrentUser() && projectService.getActiveProject()) {
      return 'workspace';
    }
    return 'projects-hub';
  });
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [pendingProjectName, setPendingProjectName] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'repair-list' | 'material-estimation' | 'plan-vs-actual' | 'opname' | 'defect-surveys' | 'cost-estimation' | 'satisfaction-note' | 'work-done-report'>(() => {
    const saved = localStorage.getItem('shipyard_active_tab');
    if (['repair-list', 'material-estimation', 'plan-vs-actual', 'opname', 'defect-surveys', 'cost-estimation', 'satisfaction-note', 'work-done-report'].includes(saved || '')) {
      return saved as any;
    }
    return 'repair-list';
  });

  useEffect(() => {
    try {
      localStorage.setItem('shipyard_current_view', currentView);
    } catch (e) {
      console.warn(e);
    }
  }, [currentView]);

  useEffect(() => {
    try {
      localStorage.setItem('shipyard_active_tab', activeTab);
    } catch (e) {
      console.warn(e);
    }
  }, [activeTab]);
  const [vessel, setVessel] = useState<VesselSpec>(DEFAULT_VESSEL);
  const [schedule, setSchedule] = useState<ProjectSchedule>(DEFAULT_SCHEDULE);
  const [categories, setCategories] = useState<WorkCategory[]>(DEFAULT_CATEGORIES);
  const [workItems, setWorkItems] = useState<WorkItem[]>(DEFAULT_WORK_ITEMS);
  const [opnameItems, setOpnameItems] = useState<WorkItem[]>([]);
  const [defectSurveys, setDefectSurveys] = useState<DefectSurvey[]>(DEFAULT_DEFECT_SURVEYS);
  const [signatures, setSignatures] = useState<Signatures>(DEFAULT_SIGNATURES);

  // Modals state
  const [isAddSurveyOpen, setIsAddSurveyOpen] = useState<boolean>(false);
  const [editingSurvey, setEditingSurvey] = useState<DefectSurvey | null>(null);
  const [isPdfModalOpen, setIsPdfModalOpen] = useState<boolean>(false);
  const [isSqliteModalOpen, setIsSqliteModalOpen] = useState<boolean>(false);
  const [isVesselModalOpen, setIsVesselModalOpen] = useState<boolean>(false);
  const [isExportImportModalOpen, setIsExportImportModalOpen] = useState<boolean>(false);
  const [exportImportDefaultTab, setExportImportDefaultTab] = useState<'export' | 'import'>('export');

  // Toast feedback state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'syncing'>('saved');
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(new Date());
  const [cloudConnectionState, setCloudConnectionState] = useState<CloudConnectionState>(
    () => firebaseSyncService.getConnectionState().state
  );
  const [isCloudSyncing, setIsCloudSyncing] = useState<boolean>(false);
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<Date | null>(null);
  const [extrasSyncTick, setExtrasSyncTick] = useState<number>(0);

  // Custom dialog modal state
  const [dialogState, setDialogState] = useState<{
    isOpen: boolean;
    type: 'confirm' | 'alert';
    title: string;
    message: string;
    onConfirm?: () => void;
  }>({
    isOpen: false,
    type: 'confirm',
    title: '',
    message: '',
  });

  const showCustomConfirm = useCallback((title: string, message: string, onConfirm: () => void) => {
    setDialogState({
      isOpen: true,
      type: 'confirm',
      title,
      message,
      onConfirm,
    });
  }, []);

  const showCustomAlert = useCallback((title: string, message: string) => {
    setDialogState({
      isOpen: true,
      type: 'alert',
      title,
      message,
    });
  }, []);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  }, []);

  const isApplyingCloudUpdateRef = useRef<boolean>(false);
  const lastCloudUpdatedAtRef = useRef<string | null>(null);
  const cloudSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentViewRef = useRef(currentView);
  const currentProjectIdRef = useRef<string | null>(currentProject?.id || null);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    currentProjectIdRef.current = currentProject?.id || null;
  }, [currentProject?.id]);

  const scheduleCloudSync = useCallback(
    (
      projId: string,
      payload?: {
        vessel: VesselSpec;
        schedule: ProjectSchedule;
        categories: WorkCategory[];
        workItems: WorkItem[];
        opnameItems: WorkItem[];
        defectSurveys: DefectSurvey[];
        signatures: Signatures;
      }
    ) => {
      if (cloudSyncTimerRef.current) {
        clearTimeout(cloudSyncTimerRef.current);
      }
      setSaveStatus('syncing');
      cloudSyncTimerRef.current = setTimeout(async () => {
        const storedProj = projectService.getProjectById(projId);
        const fullPayload = payload
          ? {
              ...payload,
              id: projId,
              status: payload.schedule?.status || storedProj?.status || 'Preparation',
              createdAt: storedProj?.createdAt || new Date().toISOString(),
              lastModified: storedProj?.lastModified || new Date().toISOString(),
              extras: collectProjectExtras({ id: projId, vessel: payload.vessel }),
            }
          : storedProj
          ? projectService.buildCloudPayload(storedProj)
          : null;

        if (!fullPayload) {
          setSaveStatus('saved');
          return;
        }

        const savedAt = await firebaseSyncService.saveProjectData(projId, fullPayload);
        if (savedAt) {
          lastCloudUpdatedAtRef.current = savedAt;
          setLastCloudSyncAt(new Date());
          setLastSavedTime(new Date());
        }
        setSaveStatus('saved');
      }, 1200);
    },
    []
  );

  // Synchronize state from SQLite DB (optionally pushing local mutations to cloud with debounce)
  const loadDataFromSqlite = useCallback(
    (options?: { skipCloudPush?: boolean }) => {
      if (!sqliteService.isReady()) return;

      const v = sqliteService.getVessel();
      const s = sqliteService.getProjectSchedule();
      const c = sqliteService.getWorkCategories();
      const w = sqliteService.getWorkItems();
      const op = sqliteService.getOpnameWorkItems();
      const d = sqliteService.getDefectSurveys();
      const sig = sqliteService.getSignatures();

      setVessel(v);
      setSchedule(s);
      setCategories(c);
      setWorkItems(w);
      setOpnameItems(op);
      setDefectSurveys(d);
      setSignatures(sig);

      // Keep local projectService snapshot updated without triggering duplicate immediate Firestore pushes
      const activeProj = projectService.getActiveProject();
      const isCloudOrInitRead = Boolean(options?.skipCloudPush || isApplyingCloudUpdateRef.current);
      if (activeProj && (!s?.id || s.id === activeProj.id || v?.id === activeProj.vessel?.id)) {
        const snapshotPayload = {
          vessel: v,
          schedule: s,
          categories: c,
          workItems: w,
          opnameItems: op,
          defectSurveys: d,
          signatures: sig,
        };
        projectService.updateProjectData(activeProj.id, snapshotPayload, {
          skipCloudSync: true,
          preserveLastModified: isCloudOrInitRead,
        });
        setAllProjects(projectService.getAllProjects());

        // Never echo incoming cloud updates or init reads back to Firestore
        if (!isCloudOrInitRead) {
          scheduleCloudSync(activeProj.id, snapshotPayload);
        }
      }
    },
    [scheduleCloudSync]
  );

  // Hydrate workspace SQLite + React state from an authoritative cloud/project object without pushing back to Firestore
  const hydrateWorkspaceFromProject = useCallback(
    (proj: ShipyardProject, cloudExtras?: any) => {
      isApplyingCloudUpdateRef.current = true;
      try {
        if (cloudExtras) {
          applyProjectExtras(proj, cloudExtras);
        }
        if (sqliteService.isReady()) {
          sqliteService.loadProjectData(proj);
          loadDataFromSqlite({ skipCloudPush: true });
        }
        setCurrentProject(proj);
        setExtrasSyncTick((t) => t + 1);
      } finally {
        isApplyingCloudUpdateRef.current = false;
      }
    },
    [loadDataFromSqlite]
  );

  // Manual full bidirectional cloud sync (used in Hub & Header)
  const handleForceCloudSync = useCallback(
    async (silent = false) => {
      setIsCloudSyncing(true);
      try {
        await sqliteService.init();
        await firebaseSyncService.verifyConnection();
        const cloudDocs = await firebaseSyncService.loadAllProjects();
        if (!cloudDocs) {
          if (!silent) {
            showToast('Gagal terhubung ke Cloud Firestore. Periksa koneksi internet Anda.');
          }
          return;
        }

        const { hydratedCount, removedCount, toUpload, activeProjectUpdated } =
          projectService.reconcileCloudProjects(cloudDocs);

        if (toUpload.length > 0) {
          await Promise.all(toUpload.map((p) => projectService.pushProjectToCloud(p)));
        }

        const updatedList = projectService.getAllProjects();
        setAllProjects(updatedList);

        const activeProj = projectService.getActiveProject();
        if (activeProj) {
          setCurrentProject(activeProj);
          if (activeProjectUpdated || !sqliteService.hadLocalDbOnBoot || currentViewRef.current === 'workspace') {
            const matchingDoc = cloudDocs.find((d) => d?.id === activeProj.id);
            const currentSqlId = sqliteService.getProjectSchedule()?.id;
            if (activeProjectUpdated || currentSqlId === activeProj.id || !sqliteService.hadLocalDbOnBoot) {
              hydrateWorkspaceFromProject(activeProj, matchingDoc?.extras);
            }
          }
        }

        setLastCloudSyncAt(new Date());
        if (!silent) {
          showToast(
            `Sinkronisasi Cloud selesai (${updatedList.length} proyek tersinkron${
              hydratedCount > 0 ? `, ${hydratedCount} diperbarui` : ''
            }${toUpload.length > 0 ? `, ${toUpload.length} diunggah` : ''}${
              removedCount > 0 ? `, ${removedCount} dibersihkan` : ''
            }).`
          );
        }
      } finally {
        setIsCloudSyncing(false);
      }
    },
    [hydrateWorkspaceFromProject, showToast]
  );

  // Global boot + continuous multi-device Firestore collection synchronization (runs on BOTH Hub & Workspace)
  useEffect(() => {
    let isCancelled = false;

    const unsubConn = firebaseSyncService.subscribeConnectionState((state) => {
      setCloudConnectionState(state);
    });

    const unsubProjects = projectService.subscribe(() => {
      setAllProjects(projectService.getAllProjects());
      const active = projectService.getActiveProject();
      if (active) setCurrentProject(active);
    });

    const handleDirtyExtras = (e: Event) => {
      if (isApplyingCloudUpdateRef.current) return;
      const customEvent = e as CustomEvent<{ projectId?: string }>;
      const targetId = customEvent?.detail?.projectId || currentProjectIdRef.current || projectService.getActiveProject()?.id;
      setExtrasSyncTick((t) => t + 1);
      if (targetId) {
        scheduleCloudSync(targetId);
      }
    };

    const handleCloudHydrated = () => {
      setExtrasSyncTick((t) => t + 1);
    };

    window.addEventListener('shipyard-cloud-dirty', handleDirtyExtras);
    window.addEventListener('shipyard-cloud-hydrated', handleCloudHydrated);

    // 1. Initialize SQLite & perform initial authoritative Firestore reconciliation
    const initAndSyncCloud = async () => {
      await sqliteService.init();
      if (isCancelled) return;

      // Flush local SQLite into matching projectService entry ONLY if it actually holds local edits not yet reflected
      if (sqliteService.hadLocalDbOnBoot) {
        const sqlV = sqliteService.getVessel();
        const sqlS = sqliteService.getProjectSchedule();
        const sqlC = sqliteService.getWorkCategories();
        const sqlW = sqliteService.getWorkItems();
        const sqlOp = sqliteService.getOpnameWorkItems();
        const sqlD = sqliteService.getDefectSurveys();
        const sqlSig = sqliteService.getSignatures();

        const targetProj =
          (sqlS?.id ? projectService.getProjectById(sqlS.id) : null) ||
          projectService.getAllProjects().find((p) => p.vessel?.id === sqlV?.id) ||
          projectService.getActiveProject();

        if (targetProj) {
          const itemCountChanged =
            sqlW.length !== (targetProj.workItems?.length || 0) ||
            sqlOp.length !== (targetProj.opnameItems?.length || 0) ||
            sqlD.length !== (targetProj.defectSurveys?.length || 0);

          if (itemCountChanged || sqlW.length > 0 || sqlOp.length > 0) {
            projectService.updateProjectData(
              targetProj.id,
              {
                vessel: sqlV,
                schedule: sqlS,
                categories: sqlC,
                workItems: sqlW,
                opnameItems: sqlOp,
                defectSurveys: sqlD,
                signatures: sqlSig,
              },
              { skipCloudSync: true, preserveLastModified: !itemCountChanged }
            );
          }
        }
        loadDataFromSqlite({ skipCloudPush: true });
      } else {
        loadDataFromSqlite({ skipCloudPush: true });
      }
      setLastSavedTime(new Date());

      // Fetch all Firestore projects across hub & workspace
      setIsCloudSyncing(true);
      try {
        const cloudDocs = await firebaseSyncService.loadAllProjects();
        if (isCancelled) return;

        if (cloudDocs) {
          const { toUpload, activeProjectUpdated, hydratedCount } =
            projectService.reconcileCloudProjects(cloudDocs);

          if (toUpload.length > 0) {
            await Promise.all(toUpload.map((p) => projectService.pushProjectToCloud(p)));
          }

          if (isCancelled) return;
          setAllProjects(projectService.getAllProjects());
          const activeProj = projectService.getActiveProject();
          if (activeProj) {
            const matchingDoc = cloudDocs.find((d) => d?.id === activeProj.id);
            const currentSqlId = sqliteService.getProjectSchedule()?.id;
            if (!sqliteService.hadLocalDbOnBoot || activeProjectUpdated || (hydratedCount > 0 && currentSqlId === activeProj.id)) {
              hydrateWorkspaceFromProject(activeProj, matchingDoc?.extras);
            } else {
              setCurrentProject(activeProj);
            }
          }
          setLastCloudSyncAt(new Date());
        }
      } finally {
        if (!isCancelled) {
          setIsCloudSyncing(false);
        }
      }
    };

    void initAndSyncCloud();

    // 2. Subscribe to real-time SQLite mutations while in workspace
    const unsubscribeSqlite = sqliteService.subscribe(() => {
      loadDataFromSqlite();
    });

    // 3. Subscribe to real-time Firestore collection updates across all projects
    const unsubscribeCollection = firebaseSyncService.subscribeAllProjects((liveDocs) => {
      if (isCancelled) return;
      const { hydratedCount, removedCount, activeProjectUpdated } =
        projectService.reconcileCloudProjects(liveDocs);

      if (hydratedCount > 0 || removedCount > 0) {
        setAllProjects(projectService.getAllProjects());
        const activeProj = projectService.getActiveProject();
        if (activeProj) {
          setCurrentProject(activeProj);
          if (activeProjectUpdated && currentViewRef.current === 'workspace') {
            const matchingDoc = liveDocs.find((d) => d?.id === activeProj.id);
            hydrateWorkspaceFromProject(activeProj, matchingDoc?.extras);
          }
        }
        setLastCloudSyncAt(new Date());
      }
    });

    return () => {
      isCancelled = true;
      unsubConn();
      unsubProjects();
      unsubscribeSqlite();
      unsubscribeCollection();
      window.removeEventListener('shipyard-cloud-dirty', handleDirtyExtras);
      window.removeEventListener('shipyard-cloud-hydrated', handleCloudHydrated);
      if (cloudSyncTimerRef.current) {
        clearTimeout(cloudSyncTimerRef.current);
      }
    };
  }, [hydrateWorkspaceFromProject, loadDataFromSqlite, scheduleCloudSync]);

  // Real-time single-project Firestore listener when inside workspace
  useEffect(() => {
    if (currentView !== 'workspace' || !currentProject?.id) return;

    const projId = currentProject.id;

    const applyCloudSnapshot = (cloudData: any) => {
      if (!cloudData || cloudData.isDeleted) return;
      if (cloudData.lastClientId && cloudData.lastClientId === CLIENT_INSTANCE_ID) {
        return;
      }
      if (cloudData.updatedAt && cloudData.updatedAt === lastCloudUpdatedAtRef.current) {
        return;
      }
      if (cloudData.updatedAt) {
        lastCloudUpdatedAtRef.current = cloudData.updatedAt;
      }

      const { activeProjectUpdated, hydratedCount } = projectService.reconcileCloudProjects([cloudData]);
      const latestProj = projectService.getProjectById(projId);
      if (latestProj && (activeProjectUpdated || hydratedCount > 0)) {
        hydrateWorkspaceFromProject(latestProj, cloudData.extras);
        setLastCloudSyncAt(new Date());
      }
    };

    const unsubscribe = firebaseSyncService.subscribeProjectData(projId, applyCloudSnapshot);
    return () => {
      unsubscribe();
    };
  }, [currentView, currentProject?.id, hydrateWorkspaceFromProject]);

  // Handle switching or opening a project (accepts object or string ID)
  const handleSelectProject = useCallback(
    (projectOrId: ShipyardProject | string) => {
      const targetId = typeof projectOrId === 'string' ? projectOrId : projectOrId.id;
      let project =
        projectService.getProjectById(targetId) || (typeof projectOrId === 'object' ? projectOrId : null);
      if (!project) {
        project = projectService.getActiveProject();
      }
      if (!project) return;

      // Check if user is logged in
      const activeUser = currentUser || authService.getCurrentUser();
      if (!activeUser) {
        setPendingProjectId(project.id);
        setPendingProjectName(project.vessel?.name || 'Kapal');
        setCurrentView('login');
        showToast(`Silakan login terlebih dahulu untuk mengakses workspace proyek ${project.vessel?.name || ''}`);
        return;
      }

      const currentLoadedSchedule = sqliteService.getProjectSchedule();
      const currentLoadedVessel = sqliteService.getVessel();
      const isAlreadyLoaded = Boolean(
        currentLoadedSchedule?.id === project.id &&
          currentLoadedVessel?.id === project.vessel?.id &&
          sqliteService.getWorkItems().length === (project.workItems?.length || 0)
      );

      projectService.setActiveProjectId(project.id);
      setCurrentProject(project);

      isApplyingCloudUpdateRef.current = true;
      try {
        if (!isAlreadyLoaded) {
          sqliteService.loadProjectData(project);
        }
        loadDataFromSqlite({ skipCloudPush: true });
      } finally {
        isApplyingCloudUpdateRef.current = false;
      }

      setCurrentView('workspace');
      showToast(`Beralih ke proyek kapal: ${project.vessel?.name || 'Kapal'}`);

      // Fetch freshest single-project snapshot from cloud (never pushing local template back)
      firebaseSyncService.loadProjectData(project.id).then((cloudData) => {
        if (!cloudData || cloudData.isDeleted) return;
        const { hydratedCount, activeProjectUpdated } = projectService.reconcileCloudProjects([cloudData]);
        const updatedProj = projectService.getProjectById(project.id);
        if (updatedProj && (hydratedCount > 0 || activeProjectUpdated)) {
          hydrateWorkspaceFromProject(updatedProj, cloudData.extras);
        }
      });
    },
    [currentUser, hydrateWorkspaceFromProject, loadDataFromSqlite, showToast]
  );

  const handleOpenLogin = () => {
    setPendingProjectId(null);
    setPendingProjectName(null);
    setCurrentView('login');
  };

  const handleSwitchProjectById = useCallback(
    (projectId: string) => {
      handleSelectProject(projectId);
    },
    [handleSelectProject]
  );

  const handleBackToProjectsHub = () => {
    setAllProjects(projectService.getAllProjects());
    setCurrentView('projects-hub');
  };

  const handleLoginSuccess = (user: UserProfile) => {
    setCurrentUser(user);
    const targetProjId = pendingProjectId;
    setPendingProjectId(null);
    setPendingProjectName(null);

    if (targetProjId) {
      const proj = projectService.getProjectById(targetProjId);
      if (proj) {
        projectService.setActiveProjectId(proj.id);
        setCurrentProject(proj);
        hydrateWorkspaceFromProject(proj);
        setCurrentView('workspace');
        showToast(`Selamat datang, ${user.name}! Mengakses workspace ${proj.vessel.name}`);
        return;
      }
    }

    // Default return to projects hub after login
    setAllProjects(projectService.getAllProjects());
    setCurrentView('projects-hub');
    showToast(`Selamat datang, ${user.name} (${user.role})!`);
  };

  const handleLogout = () => {
    authService.logout();
    setCurrentUser(null);
    setPendingProjectId(null);
    setPendingProjectName(null);
    setCurrentView('projects-hub');
    showToast('Anda telah keluar dari sistem.');
  };

  // Handle Global Keyboard Shortcut: ESC key to close active pop-ups/modals or reset active dialogs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        let hasClosedModal = false;

        if (dialogState.isOpen) {
          setDialogState((prev) => ({ ...prev, isOpen: false }));
          hasClosedModal = true;
        } else if (isAddSurveyOpen) {
          setIsAddSurveyOpen(false);
          setEditingSurvey(null);
          hasClosedModal = true;
        } else if (isPdfModalOpen) {
          setIsPdfModalOpen(false);
          hasClosedModal = true;
        } else if (isSqliteModalOpen) {
          setIsSqliteModalOpen(false);
          hasClosedModal = true;
        } else if (isVesselModalOpen) {
          setIsVesselModalOpen(false);
          hasClosedModal = true;
        } else if (isExportImportModalOpen) {
          setIsExportImportModalOpen(false);
          hasClosedModal = true;
        }

        if (hasClosedModal) {
          showToast('Pop-up / Modal ditutup (Esc)');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    dialogState.isOpen,
    isAddSurveyOpen,
    isPdfModalOpen,
    isSqliteModalOpen,
    isVesselModalOpen,
    isExportImportModalOpen,
  ]);

  // Compute Cost Summary for Tim PPC & Pimpro (Memoized to preserve Header React.memo)
  const costSummary = useMemo<CostSummary>(() => {
    let totalTonnageKg = 0;
    let totalBaseCost = 0;
    const subtotalByCategory: Record<string, { name: string; amount: number; tonnage: number }> = {};

    categories.forEach((cat) => {
      subtotalByCategory[cat.id] = { name: cat.name, amount: 0, tonnage: 0 };
    });

    workItems.forEach((item) => {
      if (item.weightKg && item.weightKg > 0) {
        totalTonnageKg += item.weightKg;
      }
      totalBaseCost += item.totalPrice || 0;

      if (subtotalByCategory[item.categoryId]) {
        subtotalByCategory[item.categoryId].amount += item.totalPrice || 0;
        if (item.weightKg) {
          subtotalByCategory[item.categoryId].tonnage += item.weightKg;
        }
      }
    });

    const marginPercent = 5;
    const ppnPercent = 11;
    const costWithMargin = totalBaseCost * (1 + marginPercent / 100);
    const grandTotalCost = costWithMargin * (1 + ppnPercent / 100);

    return {
      totalTonnageKg,
      totalWorkItems: workItems.length,
      subtotalByCategory,
      totalBaseCost,
      marginPercent,
      ppnPercent,
      grandTotalCost,
      totalCost: grandTotalCost,
    };
  }, [categories, workItems]);

  const unsyncedSurveyCount = useMemo(
    () => defectSurveys.filter((s) => s.syncStatus === 0).length,
    [defectSurveys]
  );

  // Handlers for Defect Surveys
  const handleSaveSurvey = (
    surveyData: Omit<DefectSurvey, 'id' | 'createdAt'>,
    editId?: string
  ) => {
    if (editId) {
      const existing = defectSurveys.find((s) => s.id === editId);
      if (existing) {
        sqliteService.updateDefectSurvey({
          ...existing,
          ...surveyData,
        });
        showToast(`Survey ${surveyData.locationZone} berhasil diperbarui di SQLite.`);
      }
    } else {
      sqliteService.addDefectSurvey(surveyData);
      showToast(`Data kerusakan baru zona ${surveyData.locationZone} tersimpan offline di SQLite!`);
    }
    setEditingSurvey(null);
  };

  const handleDeleteSurvey = (id: string) => {
    showCustomConfirm(
      'Konfirmasi Hapus Survey',
      'Apakah Anda yakin ingin menghapus catatan survey kerusakan ini? Tindakan ini tidak dapat dibatalkan.',
      () => {
        sqliteService.deleteDefectSurvey(id);
        showToast('Data survey telah dihapus dari SQLite.');
      }
    );
  };

  const handleConvertSurveyToBoq = (surveyId: string) => {
    const workItemId = sqliteService.convertSurveyToWorkItem(surveyId);
    if (workItemId) {
      showToast('Survey berhasil ditransfer ke BoQ VII. Steelwork Replating!');
    }
  };

  const handleSyncAllSurveys = () => {
    setSaveStatus('syncing');
    setTimeout(() => {
      sqliteService.syncAllSurveys();
      setSaveStatus('saved');
      setLastSavedTime(new Date());
      showToast('Semua survey offline berhasil disinkronkan ke server galangan.');
    }, 450);
  };

  // Handlers for Work Items
  const handleAddWorkItem = useCallback((item: Omit<WorkItem, 'id'>) => {
    sqliteService.addWorkItem(item);
    showToast(`Pekerjaan "${item.description}" ditambahkan dan nomor urut diperbarui otomatis.`);
  }, []);

  const handleUpdateWorkItem = useCallback((item: WorkItem) => {
    sqliteService.updateWorkItem(item);
    setWorkItems((prev) => prev.map((w) => (w.id === item.id ? item : w)));
  }, []);

  const handleUpdateWorkItemsBatch = useCallback((items: WorkItem[]) => {
    sqliteService.updateWorkItemsBatch(items);
    const itemMap = new Map(items.map((i) => [i.id, i]));
    setWorkItems((prev) => prev.map((w) => itemMap.get(w.id) || w));
  }, []);

  const handleDeleteWorkItem = useCallback((id: string) => {
    showCustomConfirm(
      'Konfirmasi Hapus Pekerjaan',
      'Apakah Anda yakin ingin menghapus item pekerjaan ini? Semua nomor urut (Area, Sub-system, Komponen) akan otomatis disusun ulang secara berurutan.',
      () => {
        sqliteService.deleteWorkItem(id);
        loadDataFromSqlite();
        showToast('Item pekerjaan dihapus dan nomor urut diperbarui otomatis.');
      }
    );
  }, [loadDataFromSqlite]);

  const handleBulkDeleteWorkItems = useCallback((ids: string[]) => {
    showCustomConfirm(
      'Konfirmasi Hapus Massal',
      `Apakah Anda yakin ingin menghapus ${ids.length} item pekerjaan yang dipilih? Nomor urut pekerjaan akan otomatis disusun ulang.`,
      () => {
        sqliteService.deleteWorkItems(ids);
        loadDataFromSqlite();
        showToast(`${ids.length} item pekerjaan berhasil dihapus dan nomor urut diperbarui otomatis.`);
      }
    );
  }, [loadDataFromSqlite]);

  const handleClearAllWorkItems = useCallback(() => {
    showCustomConfirm(
      'Kosongkan Seluruh Repair List',
      'Apakah Anda yakin ingin mengosongkan semua isi kategori di Repair List? Semua item pekerjaan akan dihapus, namun seluruh daftar Kategori (I s/d XII) tetap utuh dan siap digunakan.',
      () => {
        sqliteService.clearAllWorkItems();
        loadDataFromSqlite();
        showToast('Semua isi kategori di Repair List berhasil dikosongkan.');
      }
    );
  }, [loadDataFromSqlite]);

  const handleBatchSaveWorkItems = useCallback((newWorkItemsList: WorkItem[]) => {
    sqliteService.importWorkItems(newWorkItemsList, 'replace');
    loadDataFromSqlite();
    showToast('Perubahan susunan, salinan & pemindahan baris berhasil disimpan.');
  }, [loadDataFromSqlite]);

  // Handlers for Opname Items (strictly isolated from Repair List)
  const handleAddOpnameItem = useCallback((item: Omit<WorkItem, 'id'>) => {
    sqliteService.addOpnameWorkItem(item);
    showToast(`Pekerjaan "${item.description}" ditambahkan ke tab Opname & Subcont.`);
  }, []);

  const handleUpdateOpnameItem = useCallback((item: WorkItem) => {
    sqliteService.updateOpnameWorkItem(item);
    setOpnameItems((prev) => prev.map((o) => (o.id === item.id ? item : o)));
  }, []);

  const handleUpdateOpnameItemsBatch = useCallback((items: WorkItem[]) => {
    sqliteService.updateOpnameWorkItemsBatch(items);
    const itemMap = new Map(items.map((i) => [i.id, i]));
    setOpnameItems((prev) => prev.map((o) => itemMap.get(o.id) || o));
  }, []);

  const handleDeleteOpnameItem = useCallback((id: string) => {
    showCustomConfirm(
      'Konfirmasi Hapus Item Opname',
      'Apakah Anda yakin ingin menghapus item ini dari tab Opname & Subcont? (Tabel Repair List tidak akan terpengaruh)',
      () => {
        sqliteService.deleteOpnameWorkItem(id);
        loadDataFromSqlite();
        showToast('Item opname dihapus dan nomor urut diperbarui.');
      }
    );
  }, [loadDataFromSqlite, showCustomConfirm]);

  const handleBulkDeleteOpnameItems = useCallback((ids: string[]) => {
    showCustomConfirm(
      'Konfirmasi Hapus Massal Opname',
      `Apakah Anda yakin ingin menghapus ${ids.length} item opname yang dipilih? (Tabel Repair List tidak akan terpengaruh)`,
      () => {
        sqliteService.deleteOpnameWorkItems(ids);
        loadDataFromSqlite();
        showToast(`${ids.length} item opname berhasil dihapus.`);
      }
    );
  }, [loadDataFromSqlite, showCustomConfirm]);

  const handleClearAllOpnameItems = useCallback(() => {
    showCustomConfirm(
      'Kosongkan Seluruh Tabel Opname',
      'Apakah Anda yakin ingin mengosongkan semua item di tab Opname & Subcont? (Tabel Repair List tetap utuh dan aman).',
      () => {
        sqliteService.clearAllOpnameWorkItems();
        loadDataFromSqlite();
        showToast('Semua item di tab Opname berhasil dikosongkan.');
      }
    );
  }, [loadDataFromSqlite, showCustomConfirm]);

  const handleBatchSaveOpnameItems = useCallback((newOpnameList: WorkItem[]) => {
    sqliteService.importOpnameWorkItems(newOpnameList, 'replace');
    loadDataFromSqlite();
    showToast('Perubahan tabel Opname berhasil disimpan.');
  }, [loadDataFromSqlite]);

  const handleSyncOpnameFromRepairList = useCallback((mode: 'replace' | 'merge_new' = 'merge_new') => {
    showCustomConfirm(
      mode === 'replace' ? 'Sinkron Ulang Opname dari Repair List' : 'Tarik Item Baru dari Repair List',
      mode === 'replace'
        ? 'Tindakan ini akan menyalin ulang seluruh data dari Repair List ke tab Opname. Data opname saat ini akan ditimpa. Lanjutkan?'
        : 'Tindakan ini akan menambahkan item-item baru dari Repair List yang belum ada di tabel Opname tanpa menimpa data yang sudah ada.',
      () => {
        sqliteService.syncOpnameFromRepairList(mode);
        loadDataFromSqlite();
        showToast(mode === 'replace' ? 'Tabel Opname berhasil disinkronkan dari Repair List!' : 'Item baru berhasil ditambahkan ke Opname.');
      }
    );
  }, [loadDataFromSqlite, showCustomConfirm]);

  // Manual & Auto Save Handlers
  const handleManualSave = useCallback(async () => {
    setSaveStatus('saving');
    sqliteService.flushPersist();
    loadDataFromSqlite({ skipCloudPush: true });
    if (cloudSyncTimerRef.current) {
      clearTimeout(cloudSyncTimerRef.current);
      cloudSyncTimerRef.current = null;
    }
    const activeProj = projectService.getActiveProject();
    let cloudSaved = false;
    if (activeProj) {
      setSaveStatus('syncing');
      const savedAt = await projectService.pushProjectToCloud(activeProj);
      if (savedAt) {
        lastCloudUpdatedAtRef.current = savedAt;
        setLastCloudSyncAt(new Date());
        cloudSaved = true;
      }
    }
    setSaveStatus('saved');
    setLastSavedTime(new Date());
    showToast(
      cloudSaved
        ? 'Seluruh data proyek tersimpan ke SQLite & tersinkron ke Cloud!'
        : 'Database tersimpan lokal (Cloud Sync menunggu koneksi internet).'
    );
  }, [loadDataFromSqlite, showToast]);

  // Save Vessel & Project Specs
  const handleSaveVesselAndSchedule = useCallback((newVessel: VesselSpec, newSchedule: ProjectSchedule) => {
    sqliteService.updateVessel(newVessel);
    sqliteService.updateProjectSchedule(newSchedule);
    sqliteService.flushPersist();
    loadDataFromSqlite();
    showToast('Informasi spesifikasi kapal & jadwal docking diperbarui.');
  }, [loadDataFromSqlite]);

  const handleSaveSignatures = useCallback((newSig: Signatures) => {
    sqliteService.updateSignatures(newSig);
    sqliteService.flushPersist();
    loadDataFromSqlite();
  }, [loadDataFromSqlite]);

  const handleExportExcel = useCallback(async () => {
    try {
      showToast('Memproses & mengunduh file Excel (.xlsx)...');
      const { exportShipyardExcel } = await import('./utils/excelExport');
      await exportShipyardExcel({
        vessel,
        schedule,
        categories,
        workItems,
        signatures,
        includePrices: false,
      });
      showToast('Dokumen Excel Repair List (tanpa RAB) berhasil diunduh!');
    } catch (err) {
      console.error('Export Excel error:', err);
      showToast('Gagal mengunduh file Excel.');
    }
  }, [vessel, schedule, categories, workItems, signatures, showToast]);

  const handleQuickExportWord = useCallback(async () => {
    try {
      showToast('Memproses & mengunduh dokumen Word (.doc)...');
      const { exportShipyardWord } = await import('./utils/wordExport');
      exportShipyardWord({
        vessel,
        schedule,
        categories,
        workItems,
        signatures,
        defectSurveys,
        includePrices: true,
      });
      showToast('Dokumen Word (Scope of Work & Repair List) berhasil diunduh!');
    } catch (err) {
      console.error('Export Word error:', err);
      showToast('Gagal mengunduh file Word.');
    }
  }, [vessel, schedule, categories, workItems, signatures, defectSurveys, showToast]);

  const handleDownloadTemplate = useCallback(async () => {
    try {
      showToast('Mengunduh template impor Excel...');
      const { generateImportTemplate } = await import('./utils/fileImport');
      generateImportTemplate(categories, workItems, vessel?.name);
      showToast('Template Excel berhasil diunduh.');
    } catch (err) {
      console.error('Download template error:', err);
      showToast('Gagal mengunduh template.');
    }
  }, [categories, workItems, vessel?.name, showToast]);

  const handleOpenAddSurvey = useCallback(() => {
    setEditingSurvey(null);
    setIsAddSurveyOpen(true);
  }, []);

  const handleCloseAddSurvey = useCallback(() => {
    setIsAddSurveyOpen(false);
    setEditingSurvey(null);
  }, []);

  const handleOpenPdfModal = useCallback(() => {
    setIsPdfModalOpen(true);
  }, []);

  const handleClosePdfModal = useCallback(() => {
    setIsPdfModalOpen(false);
  }, []);

  const handleOpenSqliteModal = useCallback(() => {
    setIsSqliteModalOpen(true);
  }, []);

  const handleCloseSqliteModal = useCallback(() => {
    setIsSqliteModalOpen(false);
  }, []);

  const handleOpenVesselModal = useCallback(() => {
    setIsVesselModalOpen(true);
  }, []);

  const handleCloseVesselModal = useCallback(() => {
    setIsVesselModalOpen(false);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setDialogState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleOpenExportImportModal = useCallback((tab: 'export' | 'import' = 'export') => {
    setExportImportDefaultTab(tab);
    setIsExportImportModalOpen(true);
  }, []);

  const handleCloseExportImportModal = useCallback(() => {
    setIsExportImportModalOpen(false);
  }, []);

  const handleImportWorkItems = useCallback(
    (
      newItems: WorkItem[],
      mode: 'replace' | 'append',
      extra?: {
        vesselSpec?: Partial<VesselSpec>;
        projectSchedule?: Partial<ProjectSchedule>;
        vesselPhotoUrl?: string;
      }
    ) => {
      sqliteService.importWorkItems(newItems, mode);

      if (extra) {
        if (extra.vesselSpec || extra.vesselPhotoUrl) {
          const currentV = sqliteService.getVessel();
          const updatedV: VesselSpec = {
            ...currentV,
            ...(extra.vesselSpec || {}),
            ...(extra.vesselPhotoUrl ? { photoUrl: extra.vesselPhotoUrl } : {}),
          };
          sqliteService.updateVessel(updatedV);
        }
        if (extra.projectSchedule) {
          const currentS = sqliteService.getProjectSchedule();
          const updatedS: ProjectSchedule = {
            ...currentS,
            ...extra.projectSchedule,
          };
          sqliteService.updateProjectSchedule(updatedS);
        }
      }

      loadDataFromSqlite();
      showToast(
        `Berhasil mengimpor ${newItems.length} item pekerjaan ${
          extra?.vesselSpec || extra?.vesselPhotoUrl ? '& spesifikasi/foto kapal' : ''
        } (${mode === 'replace' ? 'Ganti Seluruh Data' : 'Tambahkan ke Daftar'}).`
      );
    },
    [loadDataFromSqlite]
  );

  // Material estimates for the active project (Declared before early returns to preserve hook order)
  const activeProjectId = currentProject?.id || vessel?.id || 'proj-f049';
  const projectMaterials = useMemo(() => {
    return materialEstimationService.getMaterialEstimates(activeProjectId);
  }, [activeProjectId, workItems, extrasSyncTick]);

  const materialEstimateCost = useMemo(
    () => projectMaterials.reduce((sum, m) => sum + (m.totalCost || 0), 0),
    [projectMaterials]
  );

  const handlePlanProgressUpdateItems = useCallback(
    (items: WorkItem[]) => {
      setWorkItems(items);
      handleUpdateWorkItemsBatch(items);
    },
    [handleUpdateWorkItemsBatch]
  );

  const handleNavigateToRepairList = useCallback(() => setActiveTab('repair-list'), []);
  const handleNavigateToMaterialEstimation = useCallback(() => setActiveTab('material-estimation'), []);
  const handleNavigateToOpname = useCallback(() => setActiveTab('opname'), []);
  const handleNavigateToSatisfactionNote = useCallback(() => setActiveTab('satisfaction-note'), []);
  const handleOpenImportModal = useCallback(() => handleOpenExportImportModal('import'), [handleOpenExportImportModal]);

  // VIEW 1: Login Screen (Shown when requested or logging in for a project)
  if (currentView === 'login') {
    return (
      <div className="min-h-screen bg-slate-900 font-sans selection:bg-emerald-500 selection:text-white">
        <LoginScreen
          onLoginSuccess={handleLoginSuccess}
          pendingProjectName={pendingProjectName}
          onBackToHub={() => setCurrentView('projects-hub')}
        />
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-lg border border-slate-700 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>{toastMessage}</span>
          </div>
        )}
      </div>
    );
  }

  // VIEW 2: Project Selection & Management Hub (Interface before entering project workspace)
  if (currentView === 'projects-hub' || !currentProject) {
    return (
      <div className="min-h-screen bg-slate-950 font-sans selection:bg-emerald-500 selection:text-white flex flex-col">
        <ProjectSelectionHub
          currentUser={currentUser}
          onSelectProject={handleSelectProject}
          onLogout={handleLogout}
          onOpenLogin={handleOpenLogin}
          onNotify={showToast}
          onConfirm={showCustomConfirm}
          cloudConnectionState={cloudConnectionState}
          isCloudSyncing={isCloudSyncing}
          lastCloudSyncAt={lastCloudSyncAt}
          onSyncCloud={() => handleForceCloudSync(false)}
        />
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-lg border border-slate-700 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>{toastMessage}</span>
          </div>
        )}
        <CustomDialogModal
          isOpen={dialogState.isOpen}
          type={dialogState.type}
          title={dialogState.title}
          message={dialogState.message}
          onConfirm={dialogState.onConfirm}
          onClose={() => setDialogState((prev) => ({ ...prev, isOpen: false }))}
        />
      </div>
    );
  }

  // VIEW 3: Specific Ship Project Technical Workspace
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* Top Application Header */}
      <Header
        vessel={vessel}
        schedule={schedule}
        costSummary={costSummary}
        surveyCount={defectSurveys.length}
        unsyncedSurveyCount={unsyncedSurveyCount}
        totalWorkItemsCount={workItems.length}
        saveStatus={saveStatus}
        lastSavedTime={lastSavedTime}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        materialEstimateCount={projectMaterials.length}
        materialEstimateCost={materialEstimateCost}
        currentUser={currentUser}
        onBackToProjects={handleBackToProjectsHub}
        onLogout={handleLogout}
        onSwitchProject={handleSwitchProjectById}
        allProjects={allProjects}
        currentProjectId={currentProject?.id || activeProjectId || ''}
        onOpenAddSurvey={handleOpenAddSurvey}
        onOpenPdfModal={handleOpenPdfModal}
        onExportExcel={handleExportExcel}
        onOpenSqliteModal={handleOpenSqliteModal}
        onOpenVesselModal={handleOpenVesselModal}
        onSyncAll={handleSyncAllSurveys}
        onOpenExportImportModal={handleOpenExportImportModal}
        onQuickExportWord={handleQuickExportWord}
        onQuickExportPdf={handleOpenPdfModal}
        onDownloadTemplate={handleDownloadTemplate}
        onManualSave={handleManualSave}
      />

      {/* Main Content Area */}
      <main className="w-full max-w-full min-w-0 px-2 sm:px-3 py-3 flex-1">
        {activeTab === 'repair-list' && (
          <RepairListTable
            categories={categories}
            workItems={workItems}
            projectId={activeProjectId}
            vessel={vessel}
            schedule={schedule}
            onAddItem={handleAddWorkItem}
            onUpdateItem={handleUpdateWorkItem}
            onDeleteItem={handleDeleteWorkItem}
            onBulkDeleteItems={handleBulkDeleteWorkItems}
            onClearAllItems={handleClearAllWorkItems}
            onBatchSaveWorkItems={handleBatchSaveWorkItems}
            onExportExcel={handleExportExcel}
            onImportWorkItems={handleImportWorkItems}
            onNotify={showToast}
          />
        )}

        {activeTab === 'material-estimation' && (
          <Suspense fallback={TabLoadingFallback}>
            <MaterialEstimationView
              projectId={activeProjectId}
              vessel={vessel}
              schedule={schedule}
              categories={categories}
              workItems={workItems}
              onNotify={showToast}
              onNavigateToRepairList={handleNavigateToRepairList}
            />
          </Suspense>
        )}

        {activeTab === 'opname' && (
          <Suspense fallback={TabLoadingFallback}>
            <OpnameVerificationTable
              categories={categories}
              workItems={opnameItems}
              vessel={vessel}
              schedule={schedule}
              currentUser={currentUser}
              signatures={signatures}
              onUpdateItem={handleUpdateOpnameItem}
              onAddItem={handleAddOpnameItem}
              onDeleteItem={handleDeleteOpnameItem}
              onBulkDeleteItems={handleBulkDeleteOpnameItems}
              onBatchUpdateItems={handleBatchSaveOpnameItems}
              onClearAllItems={handleClearAllOpnameItems}
              onSyncFromRepairList={handleSyncOpnameFromRepairList}
              onExportExcel={handleExportExcel}
              onExportPdf={handleOpenPdfModal}
              onExportWord={handleQuickExportWord}
            />
          </Suspense>
        )}

        {activeTab === 'satisfaction-note' && (
          <Suspense fallback={TabLoadingFallback}>
            <SatisfactionNoteModule
              opnameItems={opnameItems}
              workItems={workItems}
              categories={categories}
              vessel={vessel}
              schedule={schedule}
            />
          </Suspense>
        )}

        {activeTab === 'work-done-report' && (
          <Suspense fallback={TabLoadingFallback}>
            <WorkDoneReportModule
              opnameItems={opnameItems}
              workItems={workItems}
              categories={categories}
              vessel={vessel}
              schedule={schedule}
              onNotify={showToast}
            />
          </Suspense>
        )}

        {activeTab === 'defect-surveys' && (
          <Suspense fallback={TabLoadingFallback}>
            <DefectSurveyList
              surveys={defectSurveys}
              onOpenAddModal={handleOpenAddSurvey}
              onEditSurvey={(survey) => {
                setEditingSurvey(survey);
                setIsAddSurveyOpen(true);
              }}
              onDeleteSurvey={handleDeleteSurvey}
              onConvertToWorkItem={handleConvertSurveyToBoq}
              onSyncAll={handleSyncAllSurveys}
              onExportExcel={handleExportExcel}
              onExportPdf={handleOpenPdfModal}
              onExportWord={handleQuickExportWord}
              onOpenImportModal={handleOpenImportModal}
              onDownloadTemplate={handleDownloadTemplate}
              onOpenFullModal={handleOpenExportImportModal}
            />
          </Suspense>
        )}

        {activeTab === 'plan-vs-actual' && (
          <Suspense fallback={TabLoadingFallback}>
            <PlanProgressModule
              vessel={vessel}
              schedule={schedule}
              categories={categories}
              workItems={workItems}
              onUpdateItems={handlePlanProgressUpdateItems}
              onSaveToast={showToast}
            />
          </Suspense>
        )}

        {activeTab === 'cost-estimation' && (
          <Suspense fallback={TabLoadingFallback}>
            <RabModule
              categories={categories}
              workItems={workItems}
              opnameItems={opnameItems}
              vessel={vessel}
              schedule={schedule}
              onOpenPdfModal={handleOpenPdfModal}
              onExportExcel={handleExportExcel}
              onExportWord={handleQuickExportWord}
              onOpenImportModal={handleOpenImportModal}
              onDownloadTemplate={handleDownloadTemplate}
              onOpenFullModal={handleOpenExportImportModal}
              onAddItem={handleAddWorkItem}
              onUpdateItem={handleUpdateWorkItem}
              onDeleteItem={handleDeleteWorkItem}
              onBulkDeleteItems={handleBulkDeleteWorkItems}
              onUpdateItemsBatch={handleUpdateWorkItemsBatch}
              onUpdateOpnameItem={handleUpdateOpnameItem}
              onBatchUpdateOpnameItems={handleUpdateOpnameItemsBatch}
              onSyncOpnameFromRepairList={handleSyncOpnameFromRepairList}
              onNavigateToMaterialEstimation={handleNavigateToMaterialEstimation}
              onNavigateToOpname={handleNavigateToOpname}
              onNavigateToSatisfactionNote={handleNavigateToSatisfactionNote}
              onNotify={showToast}
            />
          </Suspense>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-2.5 text-xs text-slate-500 w-full">
        <div className="w-full px-2 sm:px-3 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-slate-500">
            <span className="font-medium text-slate-700">&copy; {new Date().getFullYear()} Sistem Reparasi Galangan Kapal</span>
            <span className="text-slate-300">&bull;</span>
            <span className="text-slate-500">Standar BKI &amp; IACS</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5 bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              <span>Prepared: <strong className="text-slate-700 font-medium">{signatures.preparedByName || 'Pimpro'}</strong> ({signatures.preparedByTitle})</span>
            </span>
            <span className="flex items-center gap-1.5 bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <span>Reviewed: <strong className="text-slate-700 font-medium">{signatures.reviewedByName || 'Owner Surveyor'}</strong> ({signatures.reviewedByTitle})</span>
            </span>
          </div>
        </div>
      </footer>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-lg border border-slate-700 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Modals (Mounted & lazy-loaded only when open) */}
      {isAddSurveyOpen && (
        <Suspense fallback={null}>
          <DefectSurveyModal
            isOpen={isAddSurveyOpen}
            onClose={handleCloseAddSurvey}
            onSave={handleSaveSurvey}
            initialSurvey={editingSurvey}
            projectId={schedule.id}
          />
        </Suspense>
      )}

      {isPdfModalOpen && (
        <Suspense fallback={null}>
          <PdfExportModal
            isOpen={isPdfModalOpen}
            onClose={handleClosePdfModal}
            vessel={vessel}
            schedule={schedule}
            categories={categories}
            workItems={workItems}
            signatures={signatures}
            defectSurveys={defectSurveys}
            onSaveSignatures={handleSaveSignatures}
          />
        </Suspense>
      )}

      {isSqliteModalOpen && (
        <Suspense fallback={null}>
          <SqliteConsoleModal
            isOpen={isSqliteModalOpen}
            onClose={handleCloseSqliteModal}
            vesselName={vessel.name}
            onConfirm={showCustomConfirm}
            onAlert={showCustomAlert}
          />
        </Suspense>
      )}

      {isVesselModalOpen && (
        <Suspense fallback={null}>
          <VesselProjectModal
            isOpen={isVesselModalOpen}
            onClose={handleCloseVesselModal}
            vessel={vessel}
            schedule={schedule}
            onSave={handleSaveVesselAndSchedule}
            onAlert={showCustomAlert}
          />
        </Suspense>
      )}

      <CustomDialogModal
        isOpen={dialogState.isOpen}
        type={dialogState.type}
        title={dialogState.title}
        message={dialogState.message}
        onConfirm={dialogState.onConfirm}
        onClose={handleCloseDialog}
      />

      {isExportImportModalOpen && (
        <Suspense fallback={null}>
          <ExportImportModal
            isOpen={isExportImportModalOpen}
            onClose={handleCloseExportImportModal}
            initialTab={exportImportDefaultTab}
            vessel={vessel}
            schedule={schedule}
            categories={categories}
            workItems={workItems}
            signatures={signatures}
            defectSurveys={defectSurveys}
            onOpenPdfModal={() => {
              setIsExportImportModalOpen(false);
              setIsPdfModalOpen(true);
            }}
            onExportExcel={handleExportExcel}
            onImportWorkItems={handleImportWorkItems}
            onNotify={showToast}
            onConfirm={showCustomConfirm}
            onAlert={showCustomAlert}
          />
        </Suspense>
      )}
    </div>
  );
}
