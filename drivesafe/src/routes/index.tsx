import { useState } from "react";
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
} from "lucide-react";
import { BACKEND_URL } from "@/lib/env";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DriveSafe — Fleet Driver Fatigue Monitoring" },
      {
        name: "description",
        content:
          "Face-verified driver access, real-time drowsiness detection and automatic speed response for commercial fleets.",
      },
      { property: "og:title", content: "DriveSafe — Fleet Driver Fatigue Monitoring" },
      {
        property: "og:description",
        content:
          "Face-verified driver access, real-time drowsiness detection and automatic speed response for commercial fleets.",
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
    title: "Real-Time Drowsiness Detection",
    body: "Continuous eye-closure and head-pose analysis runs on-vehicle, raising a pre-alert long before the driver reaches a critical fatigue threshold.",
  },
  {
    icon: Gauge,
    title: "Automatic Speed Response",
    body: "When fatigue persists past the alert window, DriveSafe progressively limits throttle and signals the operations desk with an SOS event.",
  },
];

function Home() {
  const [showLiveDetector, setShowLiveDetector] = useState(false);
  const [streamError, setStreamError] = useState(false);

  const backendHost = BACKEND_URL || "http://localhost:5000";

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

  return (
    <div>
      {/* Hero Section */}
      <section className="signal-wash border-b border-border">
        <div className="mx-auto max-w-5xl px-5 py-24 text-center sm:py-32">
          <p className="animate-fade-in text-[11px] font-medium tracking-[0.32em] uppercase text-primary">
            Fleet Safety Systems
          </p>
          <h1 className="mt-6 animate-fade-up text-5xl font-semibold tracking-tight sm:text-6xl">
            DriveSafe
          </h1>
          <p className="mx-auto mt-6 max-w-2xl animate-fade-up text-lg leading-relaxed text-muted-foreground">
            Detects drowsiness, verifies the driver, and slows the vehicle down before fatigue
            causes an accident.
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
              Drowsiness ML Model
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
                Pre-trained Vision Model
              </div>
              <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                Real-Time Drowsiness Detection ML Model
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Uses 68-point facial landmark geometry and the Eye Aspect Ratio (EAR) metric to
                detect driver eye-closure duration, blinks, and microsleep in real-time.
              </p>
            </div>

            {!showLiveDetector ? (
              <button
                type="button"
                onClick={handleStartDetector}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 px-6 py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] hover:shadow-primary/30 active:scale-[0.98]"
              >
                <Play className="size-4 fill-current" />
                Detect Drowsiness (ML Model)
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStopDetector}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/20 px-6 py-3.5 text-sm font-semibold text-red-300 transition-all hover:bg-red-500/30 active:scale-[0.98]"
              >
                <Square className="size-4 fill-current" />
                Stop ML Camera Feed
              </button>
            )}
          </div>

          {/* Architecture Cards */}
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                  <Cpu className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Model Type</p>
                  <p className="font-semibold">dlib 68-Point Model</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                shape_predictor_68_face_landmarks.dat with landmark indices 36–47.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                  <Activity className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Detection Metric</p>
                  <p className="font-semibold">Eye Aspect Ratio (EAR)</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Threshold: EAR &lt; 0.25 (eyes closed) continuously for &gt; 3.0 seconds.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                  <CheckCircle2 className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Hardware Intercept</p>
                  <p className="font-semibold">ESP32 Buzzer &amp; OLED</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Triggered via POST /drowsy over local WiFi network to the cab.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400">
                  <ScanFace className="size-4" />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Identity Sync</p>
                  <p className="font-semibold">Face Verification</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                128D deep face embeddings cross-referenced against active driver RFID.
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
                      Live Pre-trained ML Drowsiness Monitor
                    </h3>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Direct stream from Python Vision Backend with real-time 68-point facial landmark contours and EAR calculations.
                  </p>
                </div>
                <div className="flex items-center gap-2">
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

              {/* In-Browser vs Backend Notification Banner */}
              <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <span className="font-semibold">Architecture Note:</span> In-browser client-side
                WASM execution is replaced by the <strong>pre-trained Python dlib model</strong> running on your Vision Backend. The camera stream below shows your live eye tracking and EAR in real-time!
              </div>

              {/* Video Stream Container */}
              <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black shadow-inner">
                {!streamError ? (
                  <img
                    src={`${backendHost}/video_feed?t=${Date.now()}`}
                    alt="Real-Time Drowsiness ML Stream"
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

              {/* Instructions */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-emerald-400" />
                  <span>Green contour: Eyes Open (Normal)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-red-500" />
                  <span>Red contour: Eyes Closed (EAR &lt; 0.25)</span>
                </div>
                <div className="flex items-center gap-2 font-medium text-primary">
                  <span>Close eyes for 2 seconds to trigger ESP32 alarm!</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
