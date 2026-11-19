import { getGoogleAccessToken, clearGoogleAccessToken } from './googleAuthService';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  parents?: string[];
  thumbnailLink?: string;
}

export interface DriveFolderBreadcrumb {
  id: string;
  name: string;
}

const APP_ROOT_FOLDER_NAME = 'Shipyard Technical Manager';

export class GoogleDriveService {
  /**
   * Helper to execute authorized Google Drive API requests
   */
  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await getGoogleAccessToken();
    if (!token) {
      throw new Error('Sesi Google Drive belum terhubung. Silakan Masuk dengan Google terlebih dahulu.');
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      clearGoogleAccessToken();
      throw new Error('Token otentikasi Google telah kadaluarsa. Silakan Masuk kembali dengan Google.');
    }

    if (!res.ok) {
      let errDetails = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson?.error?.message) {
          errDetails = errJson.error.message;
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`Google Drive API error (${res.status}): ${errDetails}`);
    }

    return res;
  }

  /**
   * List files and folders with optional folder filter or text search
   */
  public async listFiles(options: {
    folderId?: string;
    searchQuery?: string;
    pageSize?: number;
  } = {}): Promise<DriveFile[]> {
    const { folderId, searchQuery, pageSize = 40 } = options;

    const conditions: string[] = ['trashed = false'];

    if (folderId && folderId !== 'root') {
      conditions.push(`'${folderId}' in parents`);
    } else if (folderId === 'root') {
      conditions.push(`'root' in parents`);
    }

    if (searchQuery && searchQuery.trim()) {
      const escaped = searchQuery.replace(/'/g, "\\'");
      conditions.push(`name contains '${escaped}'`);
    }

    const q = encodeURIComponent(conditions.join(' and '));
    const fields = encodeURIComponent(
      'files(id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, iconLink, thumbnailLink, parents)'
    );
    const orderBy = encodeURIComponent('folder, modifiedTime desc');

    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=${orderBy}&pageSize=${pageSize}&spaces=drive`;

    const res = await this.fetchWithAuth(url);
    const data = await res.json();
    return data.files || [];
  }

  /**
   * Create a new folder
   */
  public async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const metadata: Record<string, any> = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };

    if (parentId && parentId !== 'root') {
      metadata.parents = [parentId];
    }

    const res = await this.fetchWithAuth('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink,parents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    });

    return await res.json();
  }

  /**
   * Find or create the root folder for Shipyard Technical Manager
   */
  public async getOrCreateAppFolder(): Promise<DriveFile> {
    const q = encodeURIComponent(
      `mimeType = 'application/vnd.google-apps.folder' and name = '${APP_ROOT_FOLDER_NAME}' and trashed = false`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,webViewLink)&pageSize=1`;

    const res = await this.fetchWithAuth(url);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      return data.files[0];
    }

    return await this.createFolder(APP_ROOT_FOLDER_NAME);
  }

  /**
   * Find or create a specific vessel project folder inside the app folder
   */
  public async getOrCreateVesselFolder(vesselName: string): Promise<DriveFile> {
    const appFolder = await this.getOrCreateAppFolder();
    const cleanVessel = vesselName.trim().toUpperCase() || 'PROYEK_KAPAL';

    const q = encodeURIComponent(
      `mimeType = 'application/vnd.google-apps.folder' and '${appFolder.id}' in parents and name = '${cleanVessel.replace(/'/g, "\\'")}' and trashed = false`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,webViewLink)&pageSize=1`;

    const res = await this.fetchWithAuth(url);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      return data.files[0];
    }

    return await this.createFolder(cleanVessel, appFolder.id);
  }

  /**
   * Upload file to Google Drive using multipart upload
   */
  public async uploadFile(options: {
    name: string;
    mimeType: string;
    content: string | Blob;
    parentId?: string;
    description?: string;
  }): Promise<DriveFile> {
    const { name, mimeType, content, parentId, description } = options;
    const token = await getGoogleAccessToken();
    if (!token) {
      throw new Error('Sesi Google Drive belum terhubung.');
    }

    const metadata: Record<string, any> = {
      name,
      mimeType,
    };

    if (parentId && parentId !== 'root') {
      metadata.parents = [parentId];
    }

    if (description) {
      metadata.description = description;
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata
    )}`;

    const fileContent =
      typeof content === 'string'
        ? content
        : await content.text().catch(async () => {
            // For binary blobs (e.g., pdf or excel)
            return content;
          });

    let bodyData: any;
    let headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    };

    if (content instanceof Blob) {
      // Build binary multipart body with Blob pieces
      const blobParts: BlobPart[] = [
        metadataPart,
        `${delimiter}Content-Type: ${mimeType}\r\n\r\n`,
        content,
        closeDelimiter,
      ];
      bodyData = new Blob(blobParts, { type: `multipart/related; boundary=${boundary}` });
    } else {
      bodyData =
        metadataPart +
        `${delimiter}Content-Type: ${mimeType}\r\n\r\n` +
        fileContent +
        closeDelimiter;
    }

    const uploadUrl =
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink,parents';

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: bodyData,
    });

    if (!res.ok) {
      let errDetails = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson?.error?.message) errDetails = errJson.error.message;
      } catch {
        // ignore
      }
      throw new Error(`Gagal mengunggah file ke Google Drive: ${errDetails}`);
    }

    return await res.json();
  }

  /**
   * Upload an entire project backup snapshot directly to the vessel's Drive folder
   */
  public async backupProjectToDrive(params: {
    vesselName: string;
    projectNo?: string;
    projectData: any;
  }): Promise<{ file: DriveFile; folder: DriveFile }> {
    const vesselFolder = await this.getOrCreateVesselFolder(params.vesselName);

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .replace(/\..+/, '');
    const cleanVessel = params.vesselName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Backup_${cleanVessel}_${params.projectNo || 'F049'}_${timestamp}.json`;

    const content = JSON.stringify(
      {
        ...params.projectData,
        exportedAt: now.toISOString(),
        backupType: 'Full Project Snapshot (SQLite & Work Items)',
        system: 'Shipyard Technical Management System BKI & IACS',
      },
      null,
      2
    );

    const uploaded = await this.uploadFile({
      name: filename,
      mimeType: 'application/json',
      content,
      parentId: vesselFolder.id,
      description: `Backup otomatis seluruh data spesifikasi, repair list BOQ, dan jadwal kapal ${params.vesselName}`,
    });

    return { file: uploaded, folder: vesselFolder };
  }

  /**
   * Download text content from a Google Drive file (JSON / CSV / TSV / TXT)
   */
  public async downloadFileText(fileId: string): Promise<string> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await this.fetchWithAuth(url);
    return await res.text();
  }

  /**
   * Download binary blob from Google Drive file (PDF, Excel, Images)
   */
  public async downloadFileBlob(fileId: string): Promise<Blob> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await this.fetchWithAuth(url);
    return await res.blob();
  }

  /**
   * Delete a file or folder from Google Drive
   * (Enforces explicit user confirmation in caller UI per Workspace Integration Skill)
   */
  public async deleteFile(fileId: string): Promise<void> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    await this.fetchWithAuth(url, {
      method: 'DELETE',
    });
  }
}

export const googleDriveService = new GoogleDriveService();
