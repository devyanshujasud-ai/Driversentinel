import { useEffect, useState } from "react";
import {
  BrainCircuit,
  Eye,
  EyeOff,
  Activity,
  AlertTriangle,
  CheckCircle2,
  X,
  RefreshCw,
  Zap,
} from "lucide-react";
import { BACKEND_URL } from "@/lib/env";

type Props = {
  open: boolean;
  driverName?: string;
  onClose: () => void;
};

export function DrowsinessMLModal({ open, driverName, onClose }: Props) {
  const [ear, setEar] = useState<number | null>(null);
  const [isDrowsy, setIsDrowsy] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [imgKey, setImgKey] = useState(Date.now());

  const backendHost = BACKEND_URL || "http://localhost:5000";

  // When modal opens, tell backend to start drowsiness monitor thread
  useEffect(() => {
    if (!open) return;

    setStreamError(false);
    setImgKey(Date.now());

    fetch(`${backendHost}/monitor/start`, { method: "POST" })
      .catch((err) => console.warn("[DrowsinessMLModal] Could not start monitor:", err));

    // Poll status & real-time EAR every 400ms while modal is open
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${backendHost}/monitor/status`);
        if (res.ok) {
          const data = await res.json();
          setEar(typeof data.ear === "number" ? data.ear : null);
          setIsDrowsy(Boolean(data.is_drowsy));
        }
      } catch {
        // backend might be busy
      }
    }, 400);

    return () => {
      clearInterval(interval);
    };
  }, [open, backendHost]);

  if (!open) return null;

  const threshold = 0.25;
  const isEyeClosed = ear !== null && ear < threshold;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-md animate-fade-in"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-primary/40 bg-card shadow-2xl shadow-primary/20 animate-fade-up">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border bg-gradient-to-r from-primary/15 via-background to-background px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/20 text-primary ring-1 ring-primary/40">
              <BrainCircuit className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight text-foreground">
                  Drowsiness ML Model Live Monitor
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Active
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Driver: <span className="font-semibold text-foreground">{driverName || "Verified Driver"}</span>
                {" · "}
                68-point facial landmark geometry &amp; continuous eye aspect ratio (EAR)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-secondary/60 p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </header>

        {/* Body */}
        <div className="p-6">
          {/* Status Metric Cards */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border/70 bg-secondary/30 p-3.5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium">Eye Aspect (EAR)</span>
                <Activity className="size-4 text-primary" />
              </div>
              <p className="mt-2 font-mono text-2xl font-bold tracking-tight">
                {ear !== null ? ear.toFixed(2) : "0.00"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Threshold: &lt; 0.25</p>
            </div>

            <div className="rounded-xl border border-border/70 bg-secondary/30 p-3.5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium">Eye Status</span>
                {isEyeClosed ? (
                  <EyeOff className="size-4 text-amber-400" />
                ) : (
                  <Eye className="size-4 text-emerald-400" />
                )}
              </div>
              <p
                className={`mt-2 text-lg font-bold ${
                  isEyeClosed ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {isEyeClosed ? "Closed / Low" : "Open / Normal"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {isEyeClosed ? "Below 0.25 trigger" : "Alertness optimal"}
              </p>
            </div>

            <div className="rounded-xl border border-border/70 bg-secondary/30 p-3.5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium">Trigger Rule</span>
                <Zap className="size-4 text-blue-400" />
              </div>
              <p className="mt-2 text-lg font-bold text-foreground">&gt; 3.0s Hold</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Continuous eye closure</p>
            </div>

            <div
              className={`rounded-xl border p-3.5 transition-colors ${
                isDrowsy
                  ? "border-destructive/60 bg-destructive/20 text-destructive animate-pulse"
                  : "border-border/70 bg-secondary/30"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Cab Alert</span>
                {isDrowsy ? (
                  <AlertTriangle className="size-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                )}
              </div>
              <p
                className={`mt-2 text-lg font-bold ${
                  isDrowsy ? "text-destructive" : "text-emerald-400"
                }`}
              >
                {isDrowsy ? "DROWSY!" : "Safe"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {isDrowsy ? "Alerting ESP32 OLED" : "Cab monitoring"}
              </p>
            </div>
          </div>

          {/* Drowsiness Warning Banner */}
          {isDrowsy && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-destructive/60 bg-destructive/15 px-4 py-3 text-destructive animate-bounce">
              <AlertTriangle className="size-5 shrink-0" />
              <div className="flex-1 text-xs">
                <strong className="text-sm font-bold">DROWSINESS DETECTED!</strong> Eyes closed for
                over 3 continuous seconds. Buzzer &amp; OLED display triggered on the vehicle.
              </div>
            </div>
          )}

          {/* Video Stream Container */}
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black shadow-inner">
            {!streamError ? (
              <img
                src={`${backendHost}/video_feed?k=${imgKey}`}
                alt="Real-Time Drowsiness ML Camera Stream"
                className="size-full object-contain"
                onError={() => setStreamError(true)}
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center p-6 text-center">
                <AlertTriangle className="size-10 text-amber-400 mb-2" />
                <p className="text-sm font-semibold text-foreground">
                  Camera stream connecting…
                </p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Initializing camera feed from Python Vision Backend with 68-point facial landmarks.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setStreamError(false);
                    setImgKey(Date.now());
                  }}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent"
                >
                  <RefreshCw className="size-3.5" />
                  Reconnect Feed
                </button>
              </div>
            )}
          </div>

          {/* Footer Controls */}
          <div className="mt-4 flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center">
            <p>
              Model: <span className="font-semibold text-foreground">dlib shape_predictor_68</span> ·
              Hardware sync: <span className="font-semibold text-foreground">ESP32 /drowsy</span>
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow transition-colors hover:bg-primary/90"
              >
                Proceed to Dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
