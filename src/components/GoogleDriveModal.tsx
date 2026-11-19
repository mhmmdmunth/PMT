import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  HardDrive,
  Folder,
  FolderPlus,
  File,
  FileText,
  FileSpreadsheet,
  Upload,
  Download,
  Trash2,
  ExternalLink,
  RefreshCw,
  Search,
  Check,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ShieldCheck,
  Layers,
  Ship,
  X,
  FileUp,
  RotateCcw,
  Clock,
  Sparkles,
} from 'lucide-react';
import { googleDriveService, DriveFile, DriveFolderBreadcrumb } from '../services/googleDriveService';
import {
  googleSignIn,
  initGoogleAuth,
  getGoogleAccessToken,
  getCachedGoogleUser,
  clearGoogleAccessToken,
} from '../services/googleAuthService';
import { VesselSpec, ProjectSchedule, WorkCategory, WorkItem, DefectSurvey, Signatures } from '../types';
import { exportShipyardExcel } from '../utils/excelExport';

interface GoogleDriveModalProps {
  isOpen: boolean;
  onClose: () => void;
  vessel: VesselSpec;
  schedule: ProjectSchedule;
  categories: WorkCategory[];
  workItems: WorkItem[];
  defectSurveys: DefectSurvey[];
  signatures: Signatures;
  onRestoreProjectData: (importedData: any) => void;
  onNotify: (msg: string) => void;
}

export const GoogleDriveModal: React.FC<GoogleDriveModalProps> = ({
  isOpen,
  onClose,
  vessel,
  schedule,
  categories,
  workItems,
  defectSurveys,
  signatures,
  onRestoreProjectData,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<'files' | 'backup' | 'upload'>('files');
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [googleUser, setGoogleUser] = useState<any>(null);
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);

  // File explorer states
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [currentFolder, setCurrentFolder] = useState<{ id: string; name: string }>({
    id: 'root',
    name: 'Google Drive Saya',
  });
  const [breadcrumbs, setBreadcrumbs] = useState<DriveFolderBreadcrumb[]>([
    { id: 'root', name: 'Drive' },
  ]);

  // Modals & form states
  const [isNewFolderOpen, setIsNewFolderOpen] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);

  // Destructive delete confirmation modal state (MANDATORY per Workspace skill)
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    file: DriveFile | null;
    isOpen: boolean;
  }>({ file: null, isOpen: false });
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Restore confirmation modal
  const [restoreConfirmation, setRestoreConfirmation] = useState<{
    file: DriveFile | null;
    isOpen: boolean;
    previewData?: any;
  }>({ file: null, isOpen: false });
  const [isRestoring, setIsRestoring] = useState<boolean>(false);

  // Backup / upload states
  const [isBackingUp, setIsBackingUp] = useState<boolean>(false);
  const [isExportingExcelToDrive, setIsExportingExcelToDrive] = useState<boolean>(false);
  const [selectedUploadFile, setSelectedUploadFile] = useState<File | null>(null);
  const [isUploadingCustomFile, setIsUploadingCustomFile] = useState<boolean>(false);

  // Check auth state on open
  useEffect(() => {
    if (!isOpen) return;

    const token = getGoogleAccessToken();
    const user = getCachedGoogleUser();
    if (token) {
      setIsConnected(true);
      setGoogleUser(user);
      loadFiles(currentFolder.id);
    } else {
      setIsConnected(false);
      setGoogleUser(null);
    }

    const unsubscribe = initGoogleAuth((user, token) => {
      if (token && user) {
        setIsConnected(true);
        setGoogleUser(user);
      } else {
        setIsConnected(false);
        setGoogleUser(null);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen]);

  // Load files for current folder
  const loadFiles = useCallback(async (folderId: string = 'root', search?: string) => {
    setIsLoadingFiles(true);
    try {
      const result = await googleDriveService.listFiles({
        folderId,
        searchQuery: search,
      });
      setFiles(result);
    } catch (err: any) {
      console.warn('Gagal memuat file dari Google Drive:', err);
      onNotify(err?.message || 'Gagal memuat daftar file dari Google Drive.');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [onNotify]);

  // Trigger search with debounce
  useEffect(() => {
    if (!isOpen || !isConnected) return;
    const timer = setTimeout(() => {
      loadFiles(currentFolder.id, searchQuery);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, currentFolder.id, isConnected, isOpen, loadFiles]);

  // Handle Google Sign In
  const handleGoogleSignIn = async () => {
    setIsAuthenticating(true);
    try {
      const res = await googleSignIn();
      if (res) {
        setIsConnected(true);
        setGoogleUser(res.user);
        onNotify(`Berhasil terhubung ke Google Drive sebagai ${res.user.displayName || res.user.email}`);
        // Navigate directly into app folder or vessel folder
        try {
          const vesselFolder = await googleDriveService.getOrCreateVesselFolder(vessel.name);
          setCurrentFolder({ id: vesselFolder.id, name: vesselFolder.name });
          setBreadcrumbs([
            { id: 'root', name: 'Drive' },
            { id: vesselFolder.id, name: vesselFolder.name },
          ]);
          loadFiles(vesselFolder.id);
        } catch {
          loadFiles('root');
        }
      }
    } catch (err: any) {
      console.error(err);
      onNotify(err?.message || 'Gagal menghubungkan akun Google.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Disconnect Google Drive
  const handleDisconnect = () => {
    clearGoogleAccessToken();
    setIsConnected(false);
    setGoogleUser(null);
    setFiles([]);
    onNotify('Sesi Google Drive ditutup.');
  };

  // Navigate into folder
  const handleOpenFolder = (folder: DriveFile) => {
    setCurrentFolder({ id: folder.id, name: folder.name });
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    loadFiles(folder.id);
  };

  // Navigate back via breadcrumb
  const handleNavigateBreadcrumb = (index: number) => {
    const target = breadcrumbs[index];
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    setCurrentFolder({ id: target.id, name: target.name });
    loadFiles(target.id);
  };

  // Quick jump to ship's dedicated folder
  const handleJumpToVesselFolder = async () => {
    setIsLoadingFiles(true);
    try {
      const vesselFolder = await googleDriveService.getOrCreateVesselFolder(vessel.name);
      setCurrentFolder({ id: vesselFolder.id, name: vesselFolder.name });
      setBreadcrumbs([
        { id: 'root', name: 'Drive' },
        { id: vesselFolder.id, name: vesselFolder.name },
      ]);
      await loadFiles(vesselFolder.id);
      onNotify(`Membuka folder khusus kapal: "${vesselFolder.name}"`);
    } catch (err: any) {
      onNotify(err?.message || 'Gagal membuka folder kapal di Google Drive.');
    } finally {
      setIsLoadingFiles(false);
    }
  };

  // Create new folder
  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;

    setIsCreatingFolder(true);
    try {
      await googleDriveService.createFolder(newFolderName.trim(), currentFolder.id);
      setIsNewFolderOpen(false);
      setNewFolderName('');
      onNotify(`Folder "${newFolderName}" berhasil dibuat di Google Drive!`);
      loadFiles(currentFolder.id);
    } catch (err: any) {
      onNotify(err?.message || 'Gagal membuat folder.');
    } finally {
      setIsCreatingFolder(false);
    }
  };

  // Confirm delete dialog (MANDATORY User Confirmation for Destructive Operations)
  const handleConfirmDelete = async () => {
    if (!deleteConfirmation.file) return;

    setIsDeleting(true);
    try {
      await googleDriveService.deleteFile(deleteConfirmation.file.id);
      onNotify(`"${deleteConfirmation.file.name}" berhasil dihapus dari Google Drive.`);
      setDeleteConfirmation({ file: null, isOpen: false });
      loadFiles(currentFolder.id);
    } catch (err: any) {
      onNotify(err?.message || 'Gagal menghapus file dari Google Drive.');
    } finally {
      setIsDeleting(false);
    }
  };

  // Backup Project Snapshot to Drive
  const handleBackupToDrive = async () => {
    setIsBackingUp(true);
    try {
      const projectPayload = {
        vessel,
        schedule,
        categories,
        workItems,
        defectSurveys,
        signatures,
      };

      const result = await googleDriveService.backupProjectToDrive({
        vesselName: vessel.name,
        projectNo: vessel.projectNo,
        projectData: projectPayload,
      });

      onNotify(`✅ Backup berhasil disimpan ke Google Drive: "${result.file.name}"`);
      if (currentFolder.id === result.folder.id) {
        loadFiles(currentFolder.id);
      }
    } catch (err: any) {
      onNotify(err?.message || 'Gagal mencadangkan proyek ke Google Drive.');
    } finally {
      setIsBackingUp(false);
    }
  };

  // Prepare and open Restore from Drive confirmation
  const handlePrepareRestore = async (file: DriveFile) => {
    try {
      const rawText = await googleDriveService.downloadFileText(file.id);
      const parsed = JSON.parse(rawText);

      if (!parsed.vessel && !parsed.workItems && !Array.isArray(parsed)) {
        throw new Error('Format file bukan backup proyek galangan yang valid.');
      }

      setRestoreConfirmation({
        file,
        isOpen: true,
        previewData: parsed,
      });
    } catch (err: any) {
      onNotify(err?.message || 'Gagal membaca isi file backup dari Google Drive.');
    }
  };

  // Execute restore
  const handleExecuteRestore = () => {
    if (!restoreConfirmation.previewData) return;

    setIsRestoring(true);
    try {
      onRestoreProjectData(restoreConfirmation.previewData);
      onNotify(`Proyek berhasil dipulihkan dari Google Drive: "${restoreConfirmation.file?.name}"`);
      setRestoreConfirmation({ file: null, isOpen: false });
      onClose();
    } catch (err: any) {
      onNotify(err?.message || 'Gagal memulihkan data proyek.');
    } finally {
      setIsRestoring(false);
    }
  };

  // Custom File Upload to Current Folder
  const handleUploadCustomFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUploadFile) return;

    setIsUploadingCustomFile(true);
    try {
      await googleDriveService.uploadFile({
        name: selectedUploadFile.name,
        mimeType: selectedUploadFile.type || 'application/octet-stream',
        content: selectedUploadFile,
        parentId: currentFolder.id,
      });

      onNotify(`File "${selectedUploadFile.name}" berhasil diunggah ke Google Drive!`);
      setSelectedUploadFile(null);
      setActiveTab('files');
      loadFiles(currentFolder.id);
    } catch (err: any) {
      onNotify(err?.message || 'Gagal mengunggah file ke Google Drive.');
    } finally {
      setIsUploadingCustomFile(false);
    }
  };

  // Helper file icon renderer
  const renderFileIcon = (mimeType: string) => {
    if (mimeType === 'application/vnd.google-apps.folder') {
      return <Folder className="w-5 h-5 text-amber-500 fill-amber-400" />;
    }
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
      return <FileSpreadsheet className="w-5 h-5 text-emerald-600" />;
    }
    if (mimeType.includes('pdf')) {
      return <FileText className="w-5 h-5 text-rose-600" />;
    }
    if (mimeType.includes('json') || mimeType.includes('text')) {
      return <FileText className="w-5 h-5 text-blue-600" />;
    }
    return <File className="w-5 h-5 text-slate-500" />;
  };

  // Format file size
  const formatFileSize = (bytesStr?: string) => {
    if (!bytesStr) return '-';
    const bytes = parseInt(bytesStr, 10);
    if (isNaN(bytes)) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl max-w-4xl w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Top Header Banner */}
        <div className="bg-[#0b2545] text-white p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b-2 border-emerald-400">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
              {/* Google Drive Tri-color Icon */}
              <svg className="w-6 h-6" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
                <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
                <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
                <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
                <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.25z" fill="#00832d"/>
                <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
                <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-black tracking-tight text-white flex items-center gap-1.5">
                  Integrasi Google Drive
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                  Cloud Storage
                </span>
              </div>
              <p className="text-xs text-slate-300">
                Penyimpanan cloud, pencadangan otomatis proyek kapal, dan pertukaran berkas teknis.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto">
            {isConnected && googleUser && (
              <div className="flex items-center gap-2 bg-slate-800/80 px-2.5 py-1 rounded-xl border border-slate-700 text-xs">
                {googleUser.photoURL ? (
                  <img src={googleUser.photoURL} alt="Avatar" className="w-5 h-5 rounded-full" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center font-bold text-[10px]">
                    {googleUser.displayName?.charAt(0) || 'G'}
                  </div>
                )}
                <span className="text-slate-200 font-medium truncate max-w-[140px] text-[11px]">
                  {googleUser.displayName || googleUser.email}
                </span>
                <button
                  onClick={handleDisconnect}
                  className="text-[10px] text-slate-400 hover:text-rose-400 font-bold ml-1 cursor-pointer"
                  title="Putuskan sambungan Google Drive"
                >
                  Keluar
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-5 pt-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 overflow-x-auto">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('files')}
              className={`px-3.5 py-2 font-bold text-xs rounded-t-xl transition-colors cursor-pointer flex items-center gap-1.5 border-t border-x ${
                activeTab === 'files'
                  ? 'bg-white text-slate-900 border-slate-200 shadow-2xs'
                  : 'bg-transparent text-slate-500 hover:text-slate-900 border-transparent'
              }`}
            >
              <HardDrive className="w-4 h-4 text-emerald-600" />
              <span>Jelajah File Drive</span>
            </button>

            <button
              onClick={() => setActiveTab('backup')}
              className={`px-3.5 py-2 font-bold text-xs rounded-t-xl transition-colors cursor-pointer flex items-center gap-1.5 border-t border-x ${
                activeTab === 'backup'
                  ? 'bg-white text-slate-900 border-slate-200 shadow-2xs'
                  : 'bg-transparent text-slate-500 hover:text-slate-900 border-transparent'
              }`}
            >
              <Sparkles className="w-4 h-4 text-amber-500" />
              <span>Backup &amp; Pulihkan Proyek</span>
            </button>

            <button
              onClick={() => setActiveTab('upload')}
              className={`px-3.5 py-2 font-bold text-xs rounded-t-xl transition-colors cursor-pointer flex items-center gap-1.5 border-t border-x ${
                activeTab === 'upload'
                  ? 'bg-white text-slate-900 border-slate-200 shadow-2xs'
                  : 'bg-transparent text-slate-500 hover:text-slate-900 border-transparent'
              }`}
            >
              <Upload className="w-4 h-4 text-blue-600" />
              <span>Unggah Dokumen / Foto</span>
            </button>
          </div>

          {isConnected && (
            <button
              onClick={handleJumpToVesselFolder}
              className="text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded-lg border border-emerald-200 transition-colors inline-flex items-center gap-1 mb-1.5 cursor-pointer shrink-0"
              title={`Buka folder khusus kapal ${vessel.name}`}
            >
              <Ship className="w-3.5 h-3.5 text-emerald-600" />
              <span>Folder Kapal: {vessel.name}</span>
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          
          {/* Unauthenticated View: Sign in with Google Button */}
          {!isConnected ? (
            <div className="py-12 px-4 text-center max-w-md mx-auto space-y-5">
              <div className="w-16 h-16 rounded-3xl bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto shadow-sm">
                <HardDrive className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="space-y-1.5">
                <h4 className="text-lg font-black text-slate-900">Hubungkan Akun Google Anda</h4>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Aplikasi ini membutuhkan izin Google Drive untuk mencadangkan data proyek kapal, mengunggah foto survei, dan menyimpan laporan teknis secara otomatis ke cloud.
                </p>
              </div>

              {/* Standard Sign in with Google Button as required by Workspace Integration skill */}
              <button
                onClick={handleGoogleSignIn}
                disabled={isAuthenticating}
                className="inline-flex items-center justify-center gap-3 w-full py-2.5 px-4 bg-white border border-slate-300 hover:border-slate-400 rounded-xl shadow-xs hover:shadow-md transition-all text-slate-700 font-bold text-xs cursor-pointer active:scale-98 disabled:opacity-50"
              >
                {isAuthenticating ? (
                  <RefreshCw className="w-5 h-5 text-emerald-600 animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 48 48">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                )}
                <span>Masuk dengan Google (Sign in with Google)</span>
              </button>

              <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                <span>Koneksi aman langsung melalui OAuth 2.0 resmi Google</span>
              </div>
            </div>
          ) : activeTab === 'files' ? (
            /* ================= TAB 1: FILE EXPLORER ================= */
            <div className="space-y-3">
              {/* Explorer Toolbar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                {/* Search */}
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Cari file atau folder di Google Drive..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setIsNewFolderOpen(true)}
                    className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1 cursor-pointer"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-amber-500" />
                    <span>+ Folder Baru</span>
                  </button>

                  <button
                    onClick={() => loadFiles(currentFolder.id)}
                    disabled={isLoadingFiles}
                    className="p-1.5 bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-lg transition-colors cursor-pointer"
                    title="Segarkan data Google Drive"
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoadingFiles ? 'animate-spin text-emerald-600' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Breadcrumb Navigation */}
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 overflow-x-auto py-1">
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={crumb.id}>
                    {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
                    <button
                      onClick={() => handleNavigateBreadcrumb(idx)}
                      className={`hover:underline cursor-pointer truncate max-w-[150px] ${
                        idx === breadcrumbs.length - 1 ? 'font-bold text-slate-800' : 'text-emerald-700'
                      }`}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              {/* New Folder Inline Form */}
              {isNewFolderOpen && (
                <form
                  onSubmit={handleCreateFolder}
                  className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2 animate-in fade-in"
                >
                  <Folder className="w-4 h-4 text-amber-600 shrink-0" />
                  <input
                    type="text"
                    placeholder="Nama folder baru (misal: Gambar Kerja, Sertifikat BKI)"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    autoFocus
                    className="flex-1 px-3 py-1 bg-white border border-amber-300 rounded-lg text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <button
                    type="submit"
                    disabled={isCreatingFolder || !newFolderName.trim()}
                    className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    {isCreatingFolder ? 'Membuat...' : 'Buat Folder'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewFolderOpen(false);
                      setNewFolderName('');
                    }}
                    className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800 font-bold"
                  >
                    Batal
                  </button>
                </form>
              )}

              {/* Files Table List */}
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                {isLoadingFiles ? (
                  <div className="py-12 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
                    <RefreshCw className="w-6 h-6 animate-spin text-emerald-600" />
                    <span>Memuat file dari Google Drive...</span>
                  </div>
                ) : files.length === 0 ? (
                  <div className="py-12 text-center text-xs text-slate-400 space-y-1">
                    <Folder className="w-8 h-8 text-slate-300 mx-auto" />
                    <p className="font-semibold text-slate-600">Tidak ada file atau folder di sini</p>
                    <p className="text-[11px] text-slate-400">
                      Gunakan tombol Backup atau Unggah Dokumen untuk menambahkan file ke Google Drive.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
                    {files.map((file) => {
                      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                      const isJsonBackup = file.name.endsWith('.json') && file.name.toLowerCase().includes('backup');

                      return (
                        <div
                          key={file.id}
                          className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors group"
                        >
                          <div
                            onClick={() => (isFolder ? handleOpenFolder(file) : null)}
                            className={`flex items-center gap-3 min-w-0 flex-1 ${
                              isFolder ? 'cursor-pointer' : ''
                            }`}
                          >
                            <div className="shrink-0">{renderFileIcon(file.mimeType)}</div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-slate-800 truncate flex items-center gap-2">
                                <span className={isFolder ? 'hover:text-emerald-700 hover:underline' : ''}>
                                  {file.name}
                                </span>
                                {isJsonBackup && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-amber-100 text-amber-800 border border-amber-300">
                                    Backup Proyek
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 flex items-center gap-2">
                                <span>{formatFileSize(file.size)}</span>
                                <span>&bull;</span>
                                <span>
                                  {file.modifiedTime
                                    ? new Date(file.modifiedTime).toLocaleDateString('id-ID', {
                                        day: '2-digit',
                                        month: 'short',
                                        year: 'numeric',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })
                                    : '-'}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Row Actions */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            {isJsonBackup && (
                              <button
                                onClick={() => handlePrepareRestore(file)}
                                className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded-md text-[11px] font-bold transition-colors inline-flex items-center gap-1 cursor-pointer"
                                title="Pulihkan / Restore data proyek ini dari Google Drive"
                              >
                                <RotateCcw className="w-3 h-3 text-amber-700" />
                                <span>Pulihkan</span>
                              </button>
                            )}

                            {file.webViewLink && (
                              <a
                                href={file.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                                title="Buka di Google Drive"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            )}

                            {/* Delete Button (Triggers Confirmation Modal) */}
                            <button
                              onClick={() => setDeleteConfirmation({ file, isOpen: true })}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              title="Hapus dari Google Drive"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : activeTab === 'backup' ? (
            /* ================= TAB 2: BACKUP & RESTORE ================= */
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <h4 className="font-extrabold text-sm text-emerald-950">
                      Backup Proyek Kapal: {vessel.name}
                    </h4>
                  </div>
                  <p className="text-xs text-emerald-800">
                    Mencadangkan seluruh BOQ Repair List ({workItems.length} item), jadwal docking ({schedule.dockingDurationDays || 30} hari), spesifikasi kapal, survei kerusakan, dan data teknis langsung ke Google Drive.
                  </p>
                </div>

                <button
                  onClick={handleBackupToDrive}
                  disabled={isBackingUp}
                  className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-extrabold text-xs rounded-xl shadow-md transition-all inline-flex items-center justify-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
                >
                  {isBackingUp ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4 fill-white" />
                  )}
                  <span>{isBackingUp ? 'Menyimpan ke Drive...' : '⚡ Simpan Backup ke Google Drive'}</span>
                </button>
              </div>

              {/* Instructions & Guidelines */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <h5 className="font-bold text-slate-800 flex items-center gap-1.5">
                    <Folder className="w-4 h-4 text-amber-500" />
                    <span>Lokasi Folder Otomatis</span>
                  </h5>
                  <p className="text-slate-600 text-[11px] leading-relaxed">
                    File backup akan disimpan secara otomatis di folder:
                    <br />
                    <code className="text-emerald-700 font-mono font-bold bg-emerald-50 px-1 py-0.5 rounded mt-1 inline-block">
                      Shipyard Technical Manager / {vessel.name.toUpperCase()}
                    </code>
                  </p>
                </div>

                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <h5 className="font-bold text-slate-800 flex items-center gap-1.5">
                    <RotateCcw className="w-4 h-4 text-blue-500" />
                    <span>Pemulihan Data (Restore)</span>
                  </h5>
                  <p className="text-slate-600 text-[11px] leading-relaxed">
                    Anda dapat memulihkan data kapan saja dari tab Jelajah File. Klik tombol <strong>Pulihkan</strong> pada file backup untuk mengembalikan status proyek secara akurat.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* ================= TAB 3: CUSTOM UPLOAD ================= */
            <div className="space-y-4">
              <form onSubmit={handleUploadCustomFile} className="space-y-4">
                <div className="p-6 border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-2xl bg-slate-50 text-center space-y-3 transition-colors">
                  <Upload className="w-10 h-10 text-slate-400 mx-auto" />
                  <div>
                    <h5 className="text-sm font-bold text-slate-800">
                      Pilih Dokumen Teknis, Laporan, atau Foto
                    </h5>
                    <p className="text-xs text-slate-500">
                      Mendukung PDF, Excel, Word, Foto Survei Kerusakan (JPG/PNG), Gambar CAD, atau file lainnya.
                    </p>
                  </div>

                  <input
                    type="file"
                    id="drive-custom-upload"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setSelectedUploadFile(e.target.files[0]);
                      }
                    }}
                    className="hidden"
                  />
                  <label
                    htmlFor="drive-custom-upload"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl text-xs font-bold text-slate-700 cursor-pointer shadow-xs transition-colors"
                  >
                    <FileUp className="w-4 h-4 text-emerald-600" />
                    <span>Pilih Berkas dari Komputer</span>
                  </label>

                  {selectedUploadFile && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl inline-flex items-center gap-2 text-xs font-bold text-emerald-900 mt-2">
                      <Check className="w-4 h-4 text-emerald-600" />
                      <span>{selectedUploadFile.name} ({(selectedUploadFile.size / 1024).toFixed(1)} KB)</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    Akan diunggah ke folder: <strong>{currentFolder.name}</strong>
                  </span>

                  <button
                    type="submit"
                    disabled={!selectedUploadFile || isUploadingCustomFile}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl shadow-xs transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-40"
                  >
                    {isUploadingCustomFile ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    <span>{isUploadingCustomFile ? 'Mengunggah...' : 'Unggah ke Google Drive'}</span>
                  </button>
                </div>
              </form>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="p-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-slate-500">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span>Google Workspace Integration API v3 &bull; Cloud Storage</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl font-bold transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>

      </div>

      {/* ================= MANDATORY DESTRUCTIVE CONFIRMATION MODAL ================= */}
      {deleteConfirmation.isOpen && deleteConfirmation.file && (
        <div className="fixed inset-0 z-60 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-rose-200 space-y-4">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-extrabold text-sm text-slate-900">
                  Konfirmasi Hapus File Google Drive
                </h4>
                <p className="text-xs text-slate-500">Tindakan ini tidak dapat dibatalkan.</p>
              </div>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Apakah Anda yakin ingin menghapus file berikut dari Google Drive Anda?
              <br />
              <strong className="text-slate-900 font-mono block mt-1 p-2 bg-slate-50 rounded border border-slate-200 break-all">
                {deleteConfirmation.file.name}
              </strong>
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmation({ file: null, isOpen: false })}
                disabled={isDeleting}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs cursor-pointer"
              >
                Batal
              </button>

              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer shadow-md disabled:opacity-50"
              >
                {isDeleting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                <span>{isDeleting ? 'Menghapus...' : 'Ya, Hapus File'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= RESTORE CONFIRMATION MODAL ================= */}
      {restoreConfirmation.isOpen && restoreConfirmation.file && (
        <div className="fixed inset-0 z-60 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-amber-200 space-y-4">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
                <RotateCcw className="w-6 h-6" />
              </div>
              <div>
                <h4 className="font-extrabold text-sm text-slate-900">
                  Konfirmasi Pemulihan Data Proyek
                </h4>
                <p className="text-xs text-slate-500">Restore dari Google Drive.</p>
              </div>
            </div>

            <div className="space-y-2 text-xs text-slate-600">
              <p>
                Anda akan memulihkan data proyek kapal dari file backup Google Drive:
                <strong className="block text-slate-900 font-mono p-2 bg-slate-50 rounded border border-slate-200 mt-1 break-all">
                  {restoreConfirmation.file.name}
                </strong>
              </p>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-[11px] space-y-1">
                <span className="font-bold block">⚠️ Catatan Penting:</span>
                <p>Data repair list, jadwal, dan spesifikasi kapal saat ini akan ditimpa dengan data dari file cadangan ini.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRestoreConfirmation({ file: null, isOpen: false })}
                disabled={isRestoring}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs cursor-pointer"
              >
                Batal
              </button>

              <button
                type="button"
                onClick={handleExecuteRestore}
                disabled={isRestoring}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer shadow-md disabled:opacity-50"
              >
                {isRestoring ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                <span>{isRestoring ? 'Memulihkan...' : 'Pulihkan Data Sekarang'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
