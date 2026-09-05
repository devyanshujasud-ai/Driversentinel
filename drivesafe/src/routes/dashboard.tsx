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
} from "lucide-react";
import { useFirebaseValue } from "@/lib/firebase";
import { firebaseConfigured } from "@/lib/env";
import { normalizeStatus, StatusBadge, type StatusKey } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Live Fleet Dashboard — DriveSafe" },
      {
        name: "description",
        content:
          "Live driver status, vehicle location and fatigue event log streaming from the DriveSafe fleet network.",
      },
      { property: "og:title", content: "Live Fleet Dashboard — DriveSafe" },
      {
        property: "og:description",
        content: "Live driver status, vehicle location and fatigue event log for your fleet.",
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

  const lat = status.location?.lat ?? 19.076;
  const lng = status.location?.lng ?? 72.8777;
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
