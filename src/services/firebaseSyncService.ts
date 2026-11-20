import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  getDoc,
  getDocs,
  collection,
  getDocFromServer,
} from 'firebase/firestore';
import rawConfig from '../../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: rawConfig.apiKey,
  authDomain: rawConfig.authDomain,
  projectId: rawConfig.projectId,
  storageBucket: rawConfig.storageBucket,
  messagingSenderId: rawConfig.messagingSenderId,
  appId: rawConfig.appId,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app, (rawConfig as any).firestoreDatabaseId || '(default)');
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function buildFirestoreErrorInfo(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  return {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
  options?: { silent?: boolean }
): FirestoreErrorInfo {
  const errInfo = buildFirestoreErrorInfo(error, operationType, path);
  console.error('Firestore Error:', JSON.stringify(errInfo));
  if (!options?.silent) {
    throw new Error(JSON.stringify(errInfo));
  }
  return errInfo;
}

function cleanUndefined(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(cleanUndefined);
  }
  const cleaned: any = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      cleaned[key] = cleanUndefined(val);
    } else {
      cleaned[key] = null;
    }
  }
  return cleaned;
}

/**
 * Ensures Firestore documents stay safely under the 1 MiB document limit.
 * If oversized base64 images cause payload > 850 KB, trims heavy data:image URIs while keeping all structured data intact.
 */
function enforcePayloadSizeLimit(payload: any): any {
  const MAX_SAFE_BYTES = 850_000;
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= MAX_SAFE_BYTES) {
      return payload;
    }

    const cloned = JSON.parse(serialized);
    if (Array.isArray(cloned.defectSurveys)) {
      cloned.defectSurveys = cloned.defectSurveys.map((d: any) => {
        if (d && typeof d.photoUrl === 'string' && d.photoUrl.startsWith('data:image/') && d.photoUrl.length > 30_000) {
          return { ...d, photoUrl: '' };
        }
        return d;
      });
    }

    if (JSON.stringify(cloned).length > MAX_SAFE_BYTES && cloned.vessel?.photoUrl?.startsWith('data:image/')) {
      cloned.vessel.photoUrl = '';
    }

    return cloned;
  } catch {
    return payload;
  }
}

export const CLIENT_INSTANCE_ID = `client-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;

export type CloudConnectionState = 'checking' | 'connected' | 'offline' | 'error';

let connectionState: CloudConnectionState = 'checking';
let lastConnectionError: string | null = null;
const connectionListeners = new Set<(state: CloudConnectionState, err?: string | null) => void>();

function setConnectionState(next: CloudConnectionState, err: string | null = null) {
  connectionState = next;
  lastConnectionError = err;
  connectionListeners.forEach((cb) => cb(next, err));
}

async function testConnection(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    setConnectionState('connected', null);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client is offline).');
      setConnectionState('offline', msg);
    } else if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('missing or insufficient')) {
      // Server responded with permission check on test/connection -> Firestore is online & reachable
      setConnectionState('connected', null);
    } else {
      setConnectionState('error', msg);
    }
  }
}

// Run startup connection validation
testConnection();

export const firebaseSyncService = {
  getConnectionState(): { state: CloudConnectionState; error: string | null } {
    return { state: connectionState, error: lastConnectionError };
  },

  subscribeConnectionState(cb: (state: CloudConnectionState, err?: string | null) => void): () => void {
    connectionListeners.add(cb);
    cb(connectionState, lastConnectionError);
    return () => connectionListeners.delete(cb);
  },

  async verifyConnection(): Promise<CloudConnectionState> {
    await testConnection();
    return connectionState;
  },

  async saveProjectData(projectId: string, data: any): Promise<string | null> {
    const path = `projects/${projectId}`;
    try {
      const docRef = doc(db, 'projects', projectId);
      const sanitizedData = enforcePayloadSizeLimit(cleanUndefined({ ...data, id: projectId, isDeleted: false }));
      const updatedAt = new Date().toISOString();
      await setDoc(
        docRef,
        {
          ...sanitizedData,
          id: projectId,
          isDeleted: false,
          updatedAt,
          lastClientId: CLIENT_INSTANCE_ID,
        },
        { merge: true }
      );
      setConnectionState('connected', null);
      return updatedAt;
    } catch (e) {
      const info = handleFirestoreError(e, OperationType.WRITE, path, { silent: true });
      if (info.error.toLowerCase().includes('offline')) {
        setConnectionState('offline', info.error);
      } else {
        setConnectionState('error', info.error);
      }
      return null;
    }
  },

  async markProjectDeleted(projectId: string): Promise<boolean> {
    const path = `projects/${projectId}`;
    try {
      const docRef = doc(db, 'projects', projectId);
      await setDoc(
        docRef,
        {
          id: projectId,
          isDeleted: true,
          workItems: [],
          opnameItems: [],
          defectSurveys: [],
          updatedAt: new Date().toISOString(),
          lastClientId: CLIENT_INSTANCE_ID,
        },
        { merge: true }
      );
      setConnectionState('connected', null);
      return true;
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, path, { silent: true });
      return false;
    }
  },

  async loadProjectData(projectId: string): Promise<any | null> {
    const path = `projects/${projectId}`;
    try {
      const docRef = doc(db, 'projects', projectId);
      const snap = await getDoc(docRef);
      setConnectionState('connected', null);
      if (snap.exists()) {
        return { id: snap.id, ...snap.data() };
      }
      return null;
    } catch (e) {
      const info = handleFirestoreError(e, OperationType.GET, path, { silent: true });
      if (info.error.toLowerCase().includes('offline')) {
        setConnectionState('offline', info.error);
      }
      return null;
    }
  },

  async loadAllProjects(): Promise<any[] | null> {
    const path = 'projects';
    try {
      const snap = await getDocs(collection(db, path));
      setConnectionState('connected', null);
      const docs: any[] = [];
      snap.forEach((d) => {
        docs.push({ id: d.id, ...d.data() });
      });
      return docs;
    } catch (e) {
      const info = handleFirestoreError(e, OperationType.LIST, path, { silent: true });
      if (info.error.toLowerCase().includes('offline')) {
        setConnectionState('offline', info.error);
      } else {
        setConnectionState('error', info.error);
      }
      return null;
    }
  },

  subscribeAllProjects(onUpdate: (docs: any[]) => void): () => void {
    const path = 'projects';
    const unsubscribe = onSnapshot(
      collection(db, path),
      (snap) => {
        setConnectionState('connected', null);
        const docs: any[] = [];
        snap.forEach((d) => {
          docs.push({ id: d.id, ...d.data() });
        });
        onUpdate(docs);
      },
      (error) => {
        const info = handleFirestoreError(error, OperationType.LIST, path, { silent: true });
        if (info.error.toLowerCase().includes('offline')) {
          setConnectionState('offline', info.error);
        } else {
          setConnectionState('error', info.error);
        }
      }
    );
    return unsubscribe;
  },

  subscribeProjectData(projectId: string, onUpdate: (data: any) => void): () => void {
    const path = `projects/${projectId}`;
    const docRef = doc(db, 'projects', projectId);
    const unsubscribe = onSnapshot(
      docRef,
      (docSnap) => {
        setConnectionState('connected', null);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data?.lastClientId === CLIENT_INSTANCE_ID) {
            return;
          }
          onUpdate({ id: docSnap.id, ...data });
        }
      },
      (error) => {
        const info = handleFirestoreError(error, OperationType.GET, path, { silent: true });
        if (info.error.toLowerCase().includes('offline')) {
          setConnectionState('offline', info.error);
        }
      }
    );
    return unsubscribe;
  },
};
