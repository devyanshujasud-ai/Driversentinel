import { useEffect, useState } from "react";
import { BACKEND_URL, backendConfigured } from "./env";

/** Polls the vision backend for reachability (used only by the navbar dot). */
export function useBackendStatus(intervalMs = 15000) {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    if (!backendConfigured) {
      setOnline(false);
      return;
    }
    let cancelled = false;

    const ping = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/health`, {
          method: "GET",
          mode: "cors",
          cache: "no-store",
        });
        if (!cancelled) setOnline(res.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };

    void ping();
    const id = window.setInterval(ping, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return online;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const header = parts[0] ?? "";
  const body = parts[1] ?? "";
  const mime = /:(.*?);/.exec(header)?.[1] ?? "image/jpeg";
  const bytes = atob(body);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export async function postImage(
  endpoint: string,
  imageDataUrl: string,
  fields: Record<string, string> = {},
) {
  if (!backendConfigured) throw new Error("BACKEND_URL is not configured");
  const form = new FormData();
  form.append("image", dataUrlToBlob(imageDataUrl), "capture.jpg");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const res = await fetch(`${BACKEND_URL}${endpoint}`, { method: "POST", body: form });
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = { message: text };
  }
  if (!res.ok) throw new Error((payload["error"] as string) ?? `Request failed (${res.status})`);
  return payload;
}

export async function getDrivers(): Promise<Array<{ name: string; rfid: string; enrolledAt: string | number }>> {
  if (!backendConfigured) return [];
  try {
    const res = await fetch(`${BACKEND_URL}/drivers`, { method: "GET", mode: "cors" });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.drivers as Array<{ name: string; rfid: string; enrolledAt: string | number }>) || [];
  } catch {
    return [];
  }
}

