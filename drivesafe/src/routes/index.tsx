import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ScanFace,
  EyeOff,
  Gauge,
  ArrowRight,
  BrainCircuit,
  AlertTriangle,
  CheckCircle2,
  X,
  Play,
  Square,
  Activity,
  Cpu,
  Video,
  RefreshCw,
  Eye,
  CircleDot,
} from "lucide-react";
import { BACKEND_URL } from "@/lib/env";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DriverSentinel — Multi-Factor Fatigue Detection" },
      {
        name: "description",
        content:
          "Adaptive drowsiness detection with eye-closure, yawning, head-nodding analysis and real-time reliability scoring for commercial fleets.",
      },
      { property: "og:title", content: "DriverSentinel — Multi-Factor Fatigue Detection" },
      {
        property: "og:description",
        content:
          "Adaptive drowsiness detection with eye-closure, yawning, head-nodding analysis for commercial fleets.",
      },
    ],
  }),
  component: Home,
});

const features = [
  {
    icon: ScanFace,
    title: "Face-Verified Access",
    body: "Only enrolled, credentialed drivers can start a shift. Identity is confirmed at the cab before ignition and cross-checked against the RFID tap.",
  },
  {
    icon: EyeOff,
    title: "Multi-Factor Drowsiness Detection",
    body: "Continuous eye-closure (EAR + PERCLOS), yawning (MAR), and head-nodding (3D pose) analysis with adaptive per-driver thresholds — no fixed cutoffs.",
  },
  {
    icon: Gauge,
    title: "Composite Fatigue Index",
    body: "Weighted multi-factor fatigue score (0–100%) combining eye state, yawn frequency, head pose, and PERCLOS with real-time reliability scoring.",
  },
];

type Telemetry = {
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

function Home() {
  const [showLiveDetector, setShowLiveDetector] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  const backendHost = BACKEND_URL || "http://localhost:5000";

  // Poll telemetry when live detector is showing
  useEffect(() => {
    if (!showLiveDetector) {
      setTelemetry(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${backendHost}/monitor/status`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setTelemetry(data as Telemetry);
        }
      } catch {
        // ignore
      }
    };
    void poll();
    const id = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showLiveDetector, backendHost]);

  const handleStartDetector = async () => {
    setStreamError(false);
    setShowLiveDetector(true);
    try {
      await fetch(`${backendHost}/monitor/start`, { method: "POST" });
    } catch {
      // Stream img element will handle connection
    }
  };

  const handleStopDetector = async () => {
    setShowLiveDetector(false);
    try {
      await fetch(`${backendHost}/monitor/stop`, { method: "POST" });
    } catch {
      // ignore
    }
  };

  const handleRecalibrate = async () => {
    try {
      await fetch(`${backendHost}/monitor/calibrate`, { method: "POST" });
    } catch {
      // ignore
    }
  };

  return (
    <div>
      {/* Hero Section */}
      <section className="signal-wash border-b border-border">
        <div className="mx-auto max-w-5xl px-5 py-24 text-center sm:py-32">
          <p className="animate-fade-in text-[11px] font-medium tracking-[0.32em] uppercase text-primary">
            Fleet Safety Systems
          </p>
          <h1 className="mt-6 animate-fade-up text-5xl font-semibold tracking-tight sm:text-6xl">
            DriverSentinel
          </h1>
          <p className="mx-auto mt-6 max-w-2xl animate-fade-up text-lg leading-relaxed text-muted-foreground">
            Adaptive multi-factor drowsiness detection — eye closure, yawning, head nodding — with
            per-driver calibration and real-time reliability scoring. No fixed thresholds.
          </p>
          <div className="mt-10 flex animate-fade-up justify-center gap-4">
            <Link
              to="/verify"
              className="group inline-flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-semibold tracking-wide text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Start Verification
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
            <a
              href="#drowsiness-ml-section"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-card/60 px-5 py-3 text-sm font-medium tracking-wide text-foreground backdrop-blur transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <BrainCircuit className="size-4 text-primary" />
              Fatigue Detection Model
            </a>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="grid gap-5 md:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <article key={title} className="panel animate-fade-up p-6">
              <span className="flex size-10 items-center justify-center rounded-md border border-primary/30 bg-primary/10">
                <Icon className="size-5 text-primary" aria-hidden />
              </span>
              <h2 className="mt-5 text-base font-semibold">{title}</h2>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Drowsiness Detection ML Model Section */}
      <section id="drowsiness-ml-section" className="border-t border-border bg-card/30 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <BrainCircuit className="size-3.5" />
                Adaptive Vision Model
              </div>
              <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                Multi-Factor Fatigue Detection Engine
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Uses 68-point facial landmarks with adaptive per-driver calibration. Detects
                eye closure (EAR + PERCLOS), yawning (MAR), and head nodding (3D solvePnP pose).
                CLAHE preprocessing handles imperfect lighting.
              </p>
            </div>

            {!showLiveDetector ? (
              <button
                type="button"
                onClick={handleStartDetector}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 px-6 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] hover:shadow-primary/30 active:scale-[0.98]"
              >
                <Play className="size-4 fill-current" />
                Start Fatigue Detection
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStopDetector}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/20 px-6 py-3.5 text-sm font-semibold text-red-300 transition-all hover:bg-red-500/30 active:scale-[0.98]"
              >
                <Square className="size-4 fill-current" />
                Stop Detection
              </button>
            )}
          </div>

          {/* Architecture Cards */}
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                  <Eye className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Eye Analysis</p>
                  <p className="font-semibold">EAR + PERCLOS</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Adaptive EAR threshold calibrated per driver. PERCLOS tracks % closure over 60s sliding window. Blink filter distinguishes normal blinks (&lt;350ms) from micro-sleep.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                  <CircleDot className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Yawn Detection</p>
                  <p className="font-semibold">Mouth Aspect Ratio</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Inner lip landmarks (60–67) compute MAR. Adaptive threshold from calibration. Tracks yawn count over 5-min window.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Activity className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Head Pose</p>
                  <p className="font-semibold">3D solvePnP Tracking</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Pitch/Yaw/Roll estimated via cv2.solvePnP against a 3D face model. Detects head nodding (pitch drop &gt;15° from baseline).
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400">
                  <Cpu className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Preprocessing</p>
                  <p className="font-semibold">CLAHE + Calibration</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                CLAHE histogram equalization for dim/glare conditions. 5-second auto-calibration sets adaptive thresholds per driver.
              </p>
            </div>
          </div>

          {/* LIVE ML CAMERA FEED SECTION */}
          {showLiveDetector && (
            <div className="mt-10 overflow-hidden rounded-2xl border border-primary/40 bg-card p-6 shadow-2xl animate-fade-up">
              <div className="mb-4 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="flex size-2.5 animate-pulse rounded-full bg-emerald-400" />
                    <h3 className="text-lg font-bold text-foreground">
                      Live Multi-Factor Fatigue Monitor
                    </h3>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Real-time adaptive detection: EAR, MAR, Head Pose, PERCLOS, Blink Rate — with per-driver calibration and reliability scoring.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRecalibrate}
                    className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
                  >
                    <RefreshCw className="size-3.5" />
                    Re-Calibrate
                  </button>
                  <button
                    type="button"
                    onClick={handleStopDetector}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
                  >
                    <X className="size-3.5" />
                    Close Feed
                  </button>
                </div>
              </div>

              {/* Telemetry Dashboard */}
              {telemetry && (
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  <TelemetryCard
                    label="Fatigue"
                    value={`${telemetry.fatigue_score}%`}
                    color={telemetry.fatigue_score < 40 ? "emerald" : telemetry.fatigue_score < 70 ? "amber" : "red"}
                  />
                  <TelemetryCard
                    label="EAR"
                    value={telemetry.ear.toFixed(3)}
                    sub={`Thr: ${telemetry.ear_threshold.toFixed(3)}`}
                    color={telemetry.is_eye_closed ? "red" : "emerald"}
                  />
                  <TelemetryCard
                    label="MAR"
                    value={telemetry.mar.toFixed(3)}
                    sub={`Thr: ${telemetry.mar_threshold.toFixed(3)}`}
                    color={telemetry.is_yawning ? "red" : "emerald"}
                  />
                  <TelemetryCard
                    label="Head Pitch"
                    value={`${telemetry.head_pitch.toFixed(1)}°`}
                    color={telemetry.is_nodding ? "red" : "emerald"}
                  />
                  <TelemetryCard
                    label="PERCLOS"
                    value={`${telemetry.perclos.toFixed(1)}%`}
                    sub={`Blinks: ${telemetry.blink_rate}/min`}
                    color={telemetry.perclos > 15 ? "amber" : "emerald"}
                  />
                  <TelemetryCard
                    label="Reliability"
                    value={`${telemetry.reliability_score}%`}
                    sub={telemetry.reliability_status}
                    color={telemetry.reliability_score >= 70 ? "emerald" : telemetry.reliability_score >= 40 ? "amber" : "red"}
                  />
                </div>
              )}

              {/* Alert state + Calibration status */}
              {telemetry && (
                <div className="mb-4 flex flex-wrap gap-2">
                  <AlertStateBadge state={telemetry.alert_state} />
                  {telemetry.is_calibrated ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="size-3" />
                      Calibrated (EAR base: {telemetry.baseline_ear.toFixed(3)})
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-400">
                      Calibrating... {telemetry.calibration_progress}%
                    </span>
                  )}
                  {telemetry.yawn_count > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-400">
                      Yawns: {telemetry.yawn_count} / 5min
                    </span>
                  )}
                </div>
              )}

              {/* Video Stream Container */}
              <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black shadow-inner">
                {!streamError ? (
                  <img
                    src={`${backendHost}/video_feed?t=${Date.now()}`}
                    alt="Real-Time Multi-Factor Fatigue Detection Stream"
                    className="size-full object-contain"
                    onError={() => setStreamError(true)}
                  />
                ) : (
                  <div className="flex size-full flex-col items-center justify-center p-6 text-center">
                    <Video className="size-12 text-muted-foreground/40" />
                    <p className="mt-3 text-sm font-semibold text-foreground">
                      Camera Stream Unavailable
                    </p>
                    <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                      Ensure your webcam is connected and the Vision Backend is running on port 5000.
                    </p>
                    <button
                      type="button"
                      onClick={() => setStreamError(false)}
                      className="mt-4 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
                    >
                      Retry Connection
                    </button>
                  </div>
                )}
              </div>

              {/* Legend */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-emerald-400" />
                  <span>Green: Normal state</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-amber-400" />
                  <span>Amber: Pre-alert (yawning/PERCLOS rising)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-red-500" />
                  <span>Red: Critical (micro-sleep/nodding/high fatigue)</span>
                </div>
                <div className="flex items-center gap-2 font-medium text-primary">
                  <span>Adapts to YOUR face — no fixed thresholds</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function TelemetryCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: "emerald" | "amber" | "red";
}) {
  const borderColors = {
    emerald: "border-emerald-500/30",
    amber: "border-amber-500/30",
    red: "border-red-500/30",
  };
  const bgColors = {
    emerald: "bg-emerald-500/10",
    amber: "bg-amber-500/10",
    red: "bg-red-500/10",
  };
  const textColors = {
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
  };

  return (
    <div className={`rounded-lg border ${borderColors[color]} ${bgColors[color]} p-3`}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${textColors[color]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function AlertStateBadge({ state }: { state: string }) {
  const config: Record<string, { border: string; bg: string; text: string; icon: typeof Activity }> = {
    Normal: { border: "border-emerald-500/30", bg: "bg-emerald-500/10", text: "text-emerald-400", icon: CheckCircle2 },
    "Pre-Alert": { border: "border-amber-500/30", bg: "bg-amber-500/10", text: "text-amber-400", icon: AlertTriangle },
    Warning: { border: "border-orange-500/30", bg: "bg-orange-500/10", text: "text-orange-400", icon: AlertTriangle },
    CRITICAL: { border: "border-red-500/50", bg: "bg-red-500/15", text: "text-red-400", icon: AlertTriangle },
  };
  const c = config[state] ?? config["Normal"]!;
  const Icon = c.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border ${c.border} ${c.bg} px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${c.text}`}>
      <Icon className="size-3" />
      {state}
    </span>
  );
}
