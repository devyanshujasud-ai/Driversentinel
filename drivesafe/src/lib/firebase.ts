import { useEffect, useState } from "react";
import { FIREBASE_API_KEY, FIREBASE_DB_URL, FIREBASE_PROJECT_ID, firebaseConfigured } from "./env";

type Unsub = () => void;

let dbPromise: Promise<unknown> | null = null;

async function getDb() {
  if (!firebaseConfigured) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const [{ initializeApp, getApps }, { getDatabase }] = await Promise.all([
        import("firebase/app"),
        import("firebase/database"),
      ]);
      const app = getApps()[0]
        ? getApps()[0]
        : initializeApp({
            apiKey: FIREBASE_API_KEY,
            databaseURL: FIREBASE_DB_URL,
            projectId: FIREBASE_PROJECT_ID,
          });
      return getDatabase(app);
    })();
  }
  return dbPromise;
}

/** Subscribe to a Realtime Database path with onValue (live, no polling). */
export function useFirebaseValue<T>(path: string): {
  data: T | null;
  connected: boolean;
  ready: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(!firebaseConfigured);

  useEffect(() => {
    let cancelled = false;
    let unsub: Unsub | undefined;

    (async () => {
      const db = await getDb();
      if (!db || cancelled) {
        setReady(true);
        return;
      }
      const { ref, onValue } = await import("firebase/database");
      if (cancelled) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsub = onValue(ref(db as any, path), (snap) => {
        setData((snap.val() ?? null) as T | null);
        setConnected(true);
        setReady(true);
      }, () => {
        setConnected(false);
        setReady(true);
      });
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [path]);

  return { data, connected, ready };
}

/** Update a path in Firebase Realtime Database */
export async function updateFirebaseValue(path: string, value: Record<string, unknown>): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const { ref, update } = await import("firebase/database");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await update(ref(db as any, path), value);
    return true;
  } catch (err) {
    console.warn("Failed to update Firebase Realtime Database path:", path, err);
    return false;
  }
}

/** Sync browser device coordinates to Firebase location */
export async function syncDeviceLocationToFirebase(lat: number, lng: number): Promise<boolean> {
  return updateFirebaseValue("status/location", {
    lat,
    lng,
    updated: Date.now(),
    source: "device_gps",
  });
}

