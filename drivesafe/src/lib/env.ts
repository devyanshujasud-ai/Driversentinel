/**
 * Client-visible configuration.
 *
 * Vite only exposes variables prefixed with VITE_ to the browser, so define:
 *   VITE_FIREBASE_API_KEY, VITE_FIREBASE_DB_URL, VITE_FIREBASE_PROJECT_ID, VITE_BACKEND_URL
 */
const env = import.meta.env as Record<string, string | undefined>;

export const FIREBASE_API_KEY = env["VITE_FIREBASE_API_KEY"] ?? "";
export const FIREBASE_DB_URL = env["VITE_FIREBASE_DB_URL"] ?? "";
export const FIREBASE_PROJECT_ID = env["VITE_FIREBASE_PROJECT_ID"] ?? "";
export const BACKEND_URL = (env["VITE_BACKEND_URL"] ?? "").replace(/\/$/, "");

export const firebaseConfigured = Boolean(FIREBASE_API_KEY && FIREBASE_DB_URL && FIREBASE_PROJECT_ID);
export const backendConfigured = Boolean(BACKEND_URL);
