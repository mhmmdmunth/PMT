import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, setDoc, onSnapshot, getDoc } from 'firebase/firestore';
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
const db = getFirestore(app, (rawConfig as any).firestoreDatabaseId || '(default)');

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

export const CLIENT_INSTANCE_ID = `client-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;

export const firebaseSyncService = {
  async saveProjectData(projectId: string, data: any): Promise<string | null> {
    try {
      const docRef = doc(db, 'projects', projectId);
      const sanitizedData = cleanUndefined(data);
      const updatedAt = new Date().toISOString();
      await setDoc(docRef, {
        ...sanitizedData,
        updatedAt,
        lastClientId: CLIENT_INSTANCE_ID,
      }, { merge: true });
      return updatedAt;
    } catch (e) {
      console.error('Error saving project data to Firestore:', e);
      return null;
    }
  },

  async loadProjectData(projectId: string): Promise<any | null> {
    try {
      const docRef = doc(db, 'projects', projectId);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        return snap.data();
      }
      return null;
    } catch (e) {
      console.error('Error loading project data from Firestore:', e);
      return null;
    }
  },

  async fetchProjectData(
    projectId: string
  ): Promise<{ status: 'found'; data: any } | { status: 'missing' } | { status: 'error' }> {
    try {
      const snap = await getDoc(doc(db, 'projects', projectId));
      return snap.exists() ? { status: 'found', data: snap.data() } : { status: 'missing' };
    } catch (e) {
      console.error('Error loading project data from Firestore:', e);
      return { status: 'error' };
    }
  },

  subscribeProjectData(projectId: string, onUpdate: (data: any) => void): () => void {
    const docRef = doc(db, 'projects', projectId);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data?.lastClientId === CLIENT_INSTANCE_ID) {
          return;
        }
        onUpdate(data);
      }
    }, (error) => {
      console.error('Firestore subscription error:', error);
    });
    return unsubscribe;
  }
};
