import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Loader2, ScanFace, XCircle, ShieldCheck, ShieldAlert, CreditCard } from "lucide-react";
import { CameraPanel } from "@/components/CameraPanel";
import { postImage } from "@/lib/backend";
import { clearFirebasePending, syncDeviceLocationToFirebase } from "@/lib/firebase";

export const Route = createFileRoute("/verify")({
  head: () => ({
    meta: [
      { title: "Verify Driver — DriveSafe" },
      {
        name: "description",
        content:
          "Capture a live face scan to verify the driver's identity before the shift begins.",
      },
      { property: "og:title", content: "Verify Driver — DriveSafe" },
      {
        property: "og:description",
        content: "Capture a live face scan to verify the driver's identity before the shift begins.",
      },
    ],
  }),
  component: VerifyPage,
});

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; name: string; rfid: string; esp32Unlocked: boolean; esp32Error: string }
  | { kind: "failure"; message: string };

function VerifyPage() {
  const captureRef = useRef<(() => string | null) | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const navigate = useNavigate();

  // Auto-redirect to dashboard after 2 seconds on successful verification
  useEffect(() => {
    if (state.kind === "success") {
      const timer = setTimeout(() => {
        navigate({ to: "/dashboard" });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [state, navigate]);

  const registerCapture = useCallback((fn: () => string | null) => {
    captureRef.current = fn;
  }, []);

  const handleCapture = useCallback(async () => {
    const shot = captureRef.current?.();
    if (!shot) {
      setState({ kind: "failure", message: "Camera unavailable — check permissions" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await postImage("/verify", shot);
      const verified = res["verified"] !== false && Boolean(res["name"] ?? res["driver"]);
      const name = String(res["name"] ?? res["driver"] ?? "");
      const rfid = String(res["rfid"] ?? "");
      const esp32Unlocked = Boolean(res["esp32_unlocked"] ?? true);
      const esp32Error = String(res["esp32_error"] ?? "");
      if (verified) {
        void clearFirebasePending();
        fetch(`${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/monitor/start`, {
          method: "POST",
        }).catch(() => {});
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            void syncDeviceLocationToFirebase(pos.coords.latitude, pos.coords.longitude);
          });
        }
        setState({ kind: "success", name, rfid, esp32Unlocked, esp32Error });
      } else {
        setState({ kind: "failure", message: "NOT VERIFIED" });
      }
    } catch {
      setState({ kind: "failure", message: "NOT VERIFIED" });
    }
  }, []);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-5 py-16">
      <div className="panel w-full animate-fade-up p-6">
        <header className="mb-5 flex items-center gap-2.5">
          <ScanFace className="size-4 text-primary" aria-hidden />
          <h1 className="text-sm font-semibold tracking-[0.18em] uppercase">Identity Check</h1>
        </header>

        <CameraPanel registerCapture={registerCapture} scanning={state.kind === "idle"} />

        <div className="mt-5">
          {state.kind === "idle" && (
            <button
              onClick={handleCapture}
              className="w-full rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Capture &amp; Verify
            </button>
          )}

          {state.kind === "loading" && (
            <div className="flex animate-fade-in items-center justify-center gap-3 rounded-md border border-border bg-secondary px-5 py-3.5">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
              <span className="text-sm text-muted-foreground">Verifying identity…</span>
            </div>
          )}

          {state.kind === "success" && (
            <div className="animate-fade-up rounded-md border border-ok/40 bg-ok/10 p-6 text-center">
              <CheckCircle2 className="mx-auto size-9 text-ok" aria-hidden />
              <p className="mt-4 text-xl font-bold tracking-tight text-emerald-400 uppercase">
                FACE VERIFIED SUCCESFFULLY
              </p>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {state.name || "Driver verified"}
              </p>

              {/* RFID UID badge */}
              {state.rfid && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs text-muted-foreground">
                  <CreditCard className="size-3" />
                  <span>RFID: <span className="font-mono font-semibold text-foreground">{state.rfid}</span></span>
                </div>
              )}

              {/* ESP32 unlock status */}
              {state.esp32Unlocked ? (
                <div className="mt-4 flex items-center justify-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm">
                  <ShieldCheck className="size-5 text-emerald-400" />
                  <span className="font-semibold text-emerald-300">
                    Session Activated on ESP32!
                  </span>
                </div>
              ) : (
                <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
                  <div className="flex items-center justify-center gap-2">
                    <ShieldAlert className="size-5 text-amber-400" />
                    <span className="font-semibold text-amber-300">
                      {state.esp32Error || "ESP32 not reachable — tap RFID card first"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-amber-200/70">
                    Face verified successfully. Tap your RFID card on the ESP32 first, then verify again.
                  </p>
                </div>
              )}

              <Link
                to="/dashboard"
                className="mt-5 inline-flex rounded-md bg-ok px-5 py-2.5 text-sm font-semibold text-ok-foreground transition-opacity hover:opacity-90"
              >
                Go to Dashboard
              </Link>
            </div>
          )}

          {state.kind === "failure" && (
            <div className="animate-fade-up rounded-md border border-danger/40 bg-danger/10 p-6 text-center">
              <XCircle className="mx-auto size-9 text-danger" aria-hidden />
              <p className="mt-4 text-xl font-bold tracking-tight text-danger uppercase">NOT VERIFIED</p>
              <p className="mt-1 text-xs text-muted-foreground">{state.message}</p>
              <button
                onClick={() => setState({ kind: "idle" })}
                className="mt-5 rounded-md border border-border bg-secondary px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-accent"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Position your face clearly in frame and ensure good lighting
      </p>
    </div>
  );
}
