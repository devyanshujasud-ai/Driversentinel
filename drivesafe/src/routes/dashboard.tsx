import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  BatteryMedium,
  Clock,
  Signal,
  User,
  Activity,
  EyeOff,
  ScanFace,
  ShieldAlert,
  X,
  Eye,
  CircleDot,
  Gauge,
  BrainCircuit,
} from "lucide-react";
import { useFirebaseValue } from "@/lib/firebase";
import { firebaseConfigured, BACKEND_URL } from "@/lib/env";
import { normalizeStatus, StatusBadge, type StatusKey } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Live Fleet Dashboard — DriverSentinel" },
      {
        name: "description",
        content:
          "Live driver status, fatigue telemetry, vehicle location and event log streaming from the DriverSentinel fleet network.",
      },
      { property: "og:title", content: "Live Fleet Dashboard — DriverSentinel" },
      {
        property: "og:description",
        content: "Live driver status, fatigue telemetry, vehicle location and event log for your fleet.",
      },
    ],
  }),
  component: Dashboard,
});

type StatusNode = {
  state?: string;
  status?: string;
  driver?: string;
  sessionStart?: number;
  battery?: number;
  signal?: string;
  location?: { lat?: number; lng?: number; updated?: number };
};

type EventNode = {
  time?: number | string;
  type?: string;
  driver?: string;
};

type FatigueTelemetry = {
  running: boolean;
  ear: number;
  mar: number;
  head_pitch: number;
  head_yaw: number;
  head_roll: number;
  is_calibrated: boolean;
  calibration_progress: number;
  fatigue_score: number;
  reliability_score: number;
  reliability_status: string;
  is_yawning: boolean;
  is_nodding: boolean;
  is_eye_closed: boolean;
  is_drowsy: boolean;
  alert_state: string;
  perclos: number;
  blink_rate: number;
  yawn_count: number;
  ear_threshold: number;
  mar_threshold: number;
  baseline_ear: number;
  baseline_mar: number;
};

const DEMO_STATUS: StatusNode = {
  state: "pre-alert",
  driver: "A. Ramírez",
  battery: 82,
  signal: "LTE · Strong",
  location: { lat: 19.076, lng: 72.8777 },
};

const DEMO_EVENTS: Record<string, EventNode> = {
  e3: { time: Date.now() - 62_000, type: "Pre-Alert", driver: "A. Ramírez" },
  e2: { time: Date.now() - 640_000, type: "Drowsiness", driver: "A. Ramírez" },
  e1: { time: Date.now() - 1_800_000, type: "Face Verified", driver: "A. Ramírez" },
};

function eventIcon(type: string) {
  const t = type.toLowerCase();
  if (t.includes("fraud")) return { Icon: ShieldAlert, className: "text-fraud" };
  if (t.includes("sos") || t.includes("exceed")) return { Icon: AlertTriangle, className: "text-danger" };
  if (t.includes("micro") || t.includes("sleep")) return { Icon: EyeOff, className: "text-danger" };
  if (t.includes("nod")) return { Icon: Activity, className: "text-warn" };
  if (t.includes("yawn")) return { Icon: CircleDot, className: "text-warn" };
  if (t.includes("pre") || t.includes("alert")) return { Icon: EyeOff, className: "text-warn" };
  if (t.includes("verif") || t.includes("face")) return { Icon: ScanFace, className: "text-ok" };
  return { Icon: Activity, className: "text-primary" };
}

function useSessionTime(start?: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const base = start ?? null;
  if (now === null) return "--:--:--";
  const secs = Math.max(0, Math.floor((now - (base ?? now - 3_723_000)) / 1000));
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatTime(value: number | string | undefined) {
  if (value === undefined) return "--:--";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Dashboard() {
  const { data: liveStatus } = useFirebaseValue<StatusNode>("status");
  const { data: liveEvents } = useFirebaseValue<Record<string, EventNode>>("events");

  const status = (firebaseConfigured ? liveStatus : null) ?? DEMO_STATUS;
  const eventsMap = (firebaseConfigured ? liveEvents : null) ?? DEMO_EVENTS;

  const statusKey: StatusKey = normalizeStatus(status.state ?? status.status);
  const sessionTime = useSessionTime(status.sessionStart);
  const [acknowledged, setAcknowledged] = useState(false);

  // Poll fatigue telemetry from backend
  const backendHost = BACKEND_URL || "http://localhost:5000";
  const [fatigue, setFatigue] = useState<FatigueTelemetry | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${backendHost}/monitor/status`);
        if (res.ok && !cancelled) {
          setFatigue(await res.json() as FatigueTelemetry);
        }
      } catch {
        if (!cancelled) setFatigue(null);
      }
    };
    void poll();
    const id = window.setInterval(poll, 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [backendHost]);

  useEffect(() => {
    setAcknowledged(false);
  }, [statusKey]);

  const events = useMemo(
    () =>
      Object.entries(eventsMap ?? {})
        .map(([id, e]) => ({ id, ...e }))
        .sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime()),
    [eventsMap],
  );

  const [deviceLocation, setDeviceLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Fallback: If device coordinates exist in browser or GPS sensor hasn't pushed, use device location
  useEffect(() => {
    if (navigator.geolocation && (!status.location || (status.location.lat === 19.076 && status.location.lng === 72.8777))) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setDeviceLocation(coords);
          // Also sync to Firebase status/location
          import("@/lib/firebase").then(({ syncDeviceLocationToFirebase }) => {
            syncDeviceLocationToFirebase(coords.lat, coords.lng);
          });
        },
        (err) => console.warn("Browser geolocation prompt/error:", err.message),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    }
  }, [status.location]);

  const lat = status.location?.lat ?? deviceLocation?.lat ?? 19.076;
  const lng = status.location?.lng ?? deviceLocation?.lng ?? 72.8777;
  const critical = statusKey === "exceeded" || statusKey === "fraud";

  return (
    <div className="mx-auto max-w-7xl px-5 py-8">
      {critical && !acknowledged && (
        <div className="mb-6 flex animate-fade-in items-center gap-3 rounded-lg border border-danger/50 bg-danger/15 px-4 py-3.5">
          <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
          <p className="flex-1 text-sm font-semibold text-danger">
            {statusKey === "fraud"
              ? "Fraud flag raised — driver identity does not match the RFID credential."
              : "SOS: fatigue threshold exceeded — automatic speed limiting engaged."}
          </p>
          <button
            onClick={() => setAcknowledged(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/50 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/15"
          >
            <X className="size-3.5" aria-hidden /> Acknowledge
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Current Status" icon={Activity}>
          <StatusBadge status={statusKey} />
        </StatCard>
        <StatCard label="Active Driver" icon={User}>
          <p className="text-xl font-semibold tracking-tight">{status.driver ?? "—"}</p>
        </StatCard>
        <StatCard label="Session Time" icon={Clock}>
          <p className="font-mono text-xl font-medium tabular-nums">{sessionTime}</p>
        </StatCard>
        <StatCard label="Battery / Signal" icon={BatteryMedium}>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{status.battery ?? 82}%</span>
            <span className="flex items-center gap-1.5">
              <Signal className="size-3.5 text-ok" aria-hidden />
              {status.signal ?? "LTE · Strong"}
            </span>
          </div>
        </StatCard>
      </div>

      {/* Live Fatigue Telemetry Panel */}
      {fatigue && fatigue.running && (
        <section className="panel mt-5 overflow-hidden animate-fade-up">
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span className="flex size-2 animate-pulse rounded-full bg-emerald-400" />
              <h2 className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground">
                Live Fatigue Telemetry
              </h2>
            </div>
            <FatigueAlertBadge state={fatigue.alert_state} />
          </header>
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
            <MetricCell
              icon={Gauge}
              label="Fatigue Score"
              value={`${fatigue.fatigue_score}%`}
              alert={fatigue.fatigue_score >= 40}
              critical={fatigue.fatigue_score >= 70}
            />
            <MetricCell
              icon={Eye}
              label="EAR"
              value={fatigue.ear.toFixed(3)}
              sub={`Thr: ${fatigue.ear_threshold.toFixed(3)}`}
              alert={fatigue.is_eye_closed}
              critical={fatigue.is_drowsy}
            />
            <MetricCell
              icon={CircleDot}
              label="MAR (Yawn)"
              value={fatigue.mar.toFixed(3)}
              sub={`Yawns: ${fatigue.yawn_count}`}
              alert={fatigue.is_yawning}
            />
            <MetricCell
              icon={Activity}
              label="Head Pitch"
              value={`${fatigue.head_pitch.toFixed(1)}°`}
              sub={fatigue.is_nodding ? "NODDING" : "Stable"}
              alert={fatigue.is_nodding}
            />
            <MetricCell
              icon={EyeOff}
              label="PERCLOS"
              value={`${fatigue.perclos.toFixed(1)}%`}
              sub={`${fatigue.blink_rate}/min blinks`}
              alert={fatigue.perclos > 15}
            />
            <MetricCell
              icon={BrainCircuit}
              label="Reliability"
              value={`${fatigue.reliability_score}%`}
              sub={fatigue.reliability_status}
              alert={fatigue.reliability_score < 60}
            />
          </div>
        </section>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-5">
        <section className="panel overflow-hidden lg:col-span-3">
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground">
              Last Known Position
            </h2>
            <span className="font-mono text-xs text-muted-foreground">
              {lat.toFixed(4)}, {lng.toFixed(4)}
            </span>
          </header>
          <div className="relative">
            <iframe
              title="Vehicle location"
              className="h-[420px] w-full grayscale-[0.4] contrast-[1.05]"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://www.google.com/maps?q=${lat},${lng}&z=14&output=embed`}
            />
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <span className="absolute inset-0 m-auto size-4 rounded-full bg-primary/60 animate-pulse-ring" />
              <span className="relative block size-3.5 rounded-full border-2 border-background bg-primary" />
            </div>
          </div>
        </section>

        <section className="panel flex max-h-[492px] flex-col overflow-hidden lg:col-span-2">
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground">
              Event Log
            </h2>
            <span className="text-[11px] text-muted-foreground">live</span>
          </header>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-[11px] tracking-wider uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-2.5 text-left font-medium">Time</th>
                  <th className="px-3 py-2.5 text-left font-medium">Event</th>
                  <th className="px-5 py-2.5 text-left font-medium">Driver</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const { Icon, className } = eventIcon(String(e.type ?? ""));
                  return (
                    <tr key={e.id} className="animate-fade-up border-t border-border/70">
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                        {formatTime(e.time)}
                      </td>
                      <td className="px-3 py-3">
                        <span className="flex items-center gap-2">
                          <Icon className={cn("size-3.5", className)} aria-hidden />
                          {e.type ?? "Event"}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{e.driver ?? "—"}</td>
                    </tr>
                  );
                })}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-5 py-10 text-center text-sm text-muted-foreground">
                      No events recorded yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {!firebaseConfigured && (
        <p className="mt-5 text-xs text-muted-foreground">
          Showing sample telemetry — add VITE_FIREBASE_API_KEY, VITE_FIREBASE_DB_URL and
          VITE_FIREBASE_PROJECT_ID to stream live data.
        </p>
      )}
    </div>
  );
}

function StatCard({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="panel animate-fade-up p-5">
      <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.16em] uppercase text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <div className="mt-3.5">{children}</div>
    </div>
  );
}

function MetricCell({
  icon: Icon,
  label,
  value,
  sub,
  alert = false,
  critical = false,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
  critical?: boolean;
}) {
  const textColor = critical ? "text-red-400" : alert ? "text-amber-400" : "text-emerald-400";
  return (
    <div className="bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3 text-muted-foreground" aria-hidden />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className={cn("mt-1.5 font-mono text-lg font-bold tabular-nums", textColor)}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function FatigueAlertBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    Normal: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    "Pre-Alert": "border-amber-500/30 bg-amber-500/10 text-amber-400",
    Warning: "border-orange-500/30 bg-orange-500/10 text-orange-400",
    CRITICAL: "border-red-500/40 bg-red-500/15 text-red-400 animate-pulse",
    Initializing: "border-border bg-secondary/50 text-muted-foreground",
    Calibrating: "border-blue-500/30 bg-blue-500/10 text-blue-400",
    Searching: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    Stopped: "border-border bg-secondary/50 text-muted-foreground",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider", colors[state] ?? colors["Normal"])}>
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}
