import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import Webcam from "react-webcam";
import {
  Camera,
  CheckCircle2,
  CreditCard,
  Loader2,
  ScanFace,
  ShieldCheck,
  Timer,
  XCircle,
} from "lucide-react";
import { postImage } from "@/lib/backend";
import { clearFirebasePending, syncDeviceLocationToFirebase, useFirebaseValue } from "@/lib/firebase";
import { firebaseConfigured } from "@/lib/env";
import { cn } from "@/lib/utils";

type PendingNode = {
  driver?: string;
  rfid?: string;
  time?: number;
} | null;

type ModalState =
  | { kind: "preparing" }
  | { kind: "waiting" }
  | { kind: "countdown"; secondsLeft: number }
  | { kind: "verifying" }
  | { kind: "success"; name: string; rfid: string; esp32Unlocked: boolean; esp32Error: string }
  | { kind: "failure"; message: string };

const COUNTDOWN_SECONDS = 3;
const AUTO_CLOSE_DELAY = 2000;

export function FaceVerifyModal() {
  const { data: pending } = useFirebaseValue<PendingNode>("pending");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ModalState | null>(null);
  const camRef = useRef<Webcam | null>(null);
  const navigate = useNavigate();

  // Open modal when Firebase /pending node appears
  useEffect(() => {
    if (!firebaseConfigured) return;
    if (pending && pending.driver) {
      setOpen(true);
      setState((prev) => {
        if (!prev) {
          // Tell backend to release the camera from drowsiness monitor
          fetch(`${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/verify/prepare`, {
            method: "POST",
            mode: "cors",
          })
            .catch(() => {})
            .finally(() => {
              setTimeout(() => setState({ kind: "waiting" }), 350);
            });
          return { kind: "preparing" };
        }
        return prev;
      });
    } else {
      // pending cleared in Firebase → close modal if still in pending states
      setState((prev) => {
        if (prev && (prev.kind === "preparing" || prev.kind === "countdown" || prev.kind === "verifying" || prev.kind === "waiting")) {
          setOpen(false);
          return null;
        }
        return prev;
      });
    }
  }, [pending]);

  // Called when webcam stream is actually live
  const onUserMedia = useCallback(() => {
    console.log("[FaceVerifyModal] Camera stream live");
    setState((prev) => {
      if (prev?.kind === "waiting" || prev?.kind === "preparing") {
        return { kind: "countdown", secondsLeft: COUNTDOWN_SECONDS };
      }
      return prev;
    });
  }, []);

  // Auto-close and redirect to dashboard after 2 seconds on success
  useEffect(() => {
    if (state?.kind === "success") {
      const timer = setTimeout(() => {
        setOpen(false);
        setState(null);
        void clearFirebasePending();
        navigate({ to: "/dashboard" });
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [state, navigate]);

  const doCapture = useCallback(async () => {
    const shot = camRef.current?.getScreenshot() ?? null;
    if (!shot) {
      setState({ kind: "failure", message: "NOT VERIFIED" });
      return;
    }
    setState({ kind: "verifying" });
    try {
      const res = await postImage("/verify", shot);
      const verified = res["verified"] !== false && Boolean(res["name"] ?? res["driver"]);
      const name = String(res["name"] ?? res["driver"] ?? "");
      const rfid = String(res["rfid"] ?? "");
      const esp32Unlocked = Boolean(res["esp32_unlocked"] ?? true);
      const esp32Error = String(res["esp32_error"] ?? "");

      if (verified) {
        // Clear Firebase /pending immediately so it never gets stuck
        void clearFirebasePending();

        // Mark state as success
        setState({ kind: "success", name, rfid, esp32Unlocked, esp32Error });

        // Start drowsiness detection model on backend
        fetch(`${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/monitor/start`, {
          method: "POST",
        }).catch((err) => console.warn("[Monitor] Auto-start monitor:", err));

        // Fetch browser device GPS location and sync to Firebase map
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              const { latitude, longitude } = position.coords;
              try {
                await syncDeviceLocationToFirebase(latitude, longitude);
                console.log("[Geolocation] Synced verified device location to Firebase:", latitude, longitude);
              } catch (err) {
                console.warn("[Geolocation] Could not push coords to Firebase:", err);
              }
            },
            (geoErr) => {
              console.warn("[Geolocation] Browser location access failed or denied:", geoErr.message);
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        }
      } else {
        setState({ kind: "failure", message: "NOT VERIFIED" });
      }
    } catch (err) {
      console.error("[FaceVerifyModal] Verification failed:", err);
      setState({ kind: "failure", message: "NOT VERIFIED" });
    }
  }, []);

  // Handle countdown timer
  useEffect(() => {
    if (!state || state.kind !== "countdown") return;

    if (state.secondsLeft <= 0) {
      void doCapture();
      return;
    }

    const timer = setTimeout(() => {
      setState({ kind: "countdown", secondsLeft: state.secondsLeft - 1 });
    }, 1000);

    return () => clearTimeout(timer);
  }, [state, doCapture]);

  const handleRetry = useCallback(() => {
    setState({ kind: "waiting" });
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    setState(null);
    void clearFirebasePending();
  }, []);

  if (!open) return null;


  const showCamera = state?.kind === "waiting" || state?.kind === "countdown" || state?.kind === "verifying";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative z-10 mx-4 w-full max-w-lg animate-fade-up">
        <div className="panel overflow-hidden rounded-2xl border border-primary/30 shadow-2xl shadow-primary/10">
          {/* Header */}
          <header className="flex items-center justify-between border-b border-border px-6 py-4 bg-primary/5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/15">
                <ScanFace className="size-5 text-primary" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-wide uppercase">
                  Face Verification Required
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Driver: <span className="font-semibold text-foreground">{pending.driver}</span>
                </p>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="Close"
            >
              <XCircle className="size-5" />
            </button>
          </header>

          {/* Body */}
          <div className="p-6">
            {/* Preparing — releasing camera from backend */}
            {state?.kind === "preparing" && (
              <div className="flex aspect-4/3 w-full items-center justify-center rounded-xl border border-border bg-background">
                <Loader2 className="mr-2 size-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Releasing camera…</span>
              </div>
            )}

            {/* Camera — directly rendered, no lazy/ClientOnly wrapper */}
            {showCamera && (
              <>
                <div className="relative overflow-hidden rounded-xl border border-border bg-background">
                  <Webcam
                    ref={camRef}
                    audio={false}
                    mirrored
                    screenshotFormat="image/jpeg"
                    screenshotQuality={0.92}
                    videoConstraints={{ facingMode: "user", width: 720, height: 540 }}
                    className="aspect-4/3 w-full object-cover"
                    onUserMedia={onUserMedia}
                    onUserMediaError={() => {
                      console.error("[FaceVerifyModal] Camera access denied");
                      setState({ kind: "failure", message: "Camera access denied — check browser permissions" });
                    }}
                  />

                  {/* Framing guides */}
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute inset-6 rounded-lg border border-primary/25" />
                    {state?.kind === "countdown" && (
                      <div className="absolute inset-x-6 top-6 h-px bg-primary/70 shadow-[0_0_12px_var(--primary)] animate-scanline" />
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  {state?.kind === "waiting" && (
                    <div className="flex items-center justify-center gap-3 rounded-lg border border-border bg-secondary px-5 py-3.5 animate-fade-in">
                      <Camera className="size-4 text-primary" />
                      <span className="text-sm text-muted-foreground">Waiting for camera access…</span>
                    </div>
                  )}

                  {state?.kind === "countdown" && (
                    <div className="flex items-center justify-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-5 py-3.5 animate-fade-in">
                      <Timer className="size-5 text-primary animate-pulse" />
                      <span className="text-sm font-semibold">
                        Auto-capturing in{" "}
                        <span className="font-mono text-lg text-primary">
                          {state.secondsLeft}
                        </span>
                        s…
                      </span>
                    </div>
                  )}

                  {state?.kind === "verifying" && (
                    <div className="flex items-center justify-center gap-3 rounded-lg border border-border bg-secondary px-5 py-3.5 animate-fade-in">
                      <Loader2 className="size-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">Verifying identity…</span>
                    </div>
                  )}

                  {(state?.kind === "countdown" || state?.kind === "waiting") && (
                    <button
                      onClick={doCapture}
                      className="mt-3 w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.99]"
                    >
                      Verify Now
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Success */}
            {state?.kind === "success" && (
              <div className="animate-fade-up rounded-xl border border-ok/40 bg-ok/10 p-6 text-center">
                <CheckCircle2 className="mx-auto size-12 text-ok" />
                <p className="mt-4 text-xl font-bold tracking-tight text-emerald-400 uppercase">
                  FACE VERIFIED SUCCESFFULLY
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground">{state.name}</p>

                {state.rfid && (
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs text-muted-foreground">
                    <CreditCard className="size-3" />
                    <span>
                      RFID: <span className="font-mono font-semibold text-foreground">{state.rfid}</span>
                    </span>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm">
                  <ShieldCheck className="size-5 text-emerald-400" />
                  <span className="font-semibold text-emerald-300">
                    Session Activated! Closing window in 2s…
                  </span>
                </div>
              </div>
            )}

            {/* Failure */}
            {state?.kind === "failure" && (
              <div className="animate-fade-up rounded-xl border border-danger/40 bg-danger/10 p-6 text-center">
                <XCircle className="mx-auto size-12 text-danger" />
                <p className="mt-4 text-xl font-bold tracking-tight text-danger uppercase">
                  NOT VERIFIED
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Face does not match RFID card owner or enrollment database.
                </p>
                <button
                  onClick={handleRetry}
                  className={cn(
                    "mt-5 rounded-md border border-border bg-secondary px-5 py-2.5",
                    "text-sm font-semibold transition-colors hover:bg-accent"
                  )}
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
