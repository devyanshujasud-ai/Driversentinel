import { useCallback, useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import { Camera, RefreshCw } from "lucide-react";

type Props = {
  registerCapture: (fn: () => string | null) => void;
  scanning?: boolean;
  onReady?: () => void;
};

export default function CameraFeed({ registerCapture, scanning = true, onReady }: Props) {
  const camRef = useRef<Webcam | null>(null);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [key, setKey] = useState(0);

  const capture = useCallback(() => camRef.current?.getScreenshot() ?? null, []);

  useEffect(() => {
    registerCapture(capture);
  }, [capture, registerCapture]);

  // If camera was held by OpenCV/backend, release it
  useEffect(() => {
    fetch(`${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/verify/prepare`, {
      method: "POST",
      mode: "cors",
    }).catch(() => {});
  }, []);

  const handleRetry = () => {
    setHasError(false);
    setErrorMessage("");
    // Release backend camera again before retrying
    fetch(`${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/verify/prepare`, {
      method: "POST",
      mode: "cors",
    })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => setKey((k) => k + 1), 500);
      });
  };

  if (hasError) {
    return (
      <div className="flex aspect-4/3 w-full flex-col items-center justify-center rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
        <Camera className="size-8 text-destructive/80 mb-2" />
        <p className="text-sm font-semibold text-destructive">Camera not available</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-xs">
          {errorMessage || "Check browser camera permissions or ensure another app is not using your webcam."}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent"
        >
          <RefreshCw className="size-3.5" />
          Retry Camera
        </button>
      </div>
    );
  }

  return (
    <div key={key} className="relative overflow-hidden rounded-xl border border-border bg-background">
      <Webcam
        ref={camRef}
        audio={false}
        mirrored
        screenshotFormat="image/jpeg"
        screenshotQuality={0.92}
        videoConstraints={{ facingMode: "user" }}
        className="aspect-4/3 w-full object-cover"
        onUserMedia={() => {
          setHasError(false);
          onReady?.();
        }}
        onUserMediaError={(err) => {
          console.error("[CameraFeed] Error accessing webcam:", err);
          setHasError(true);
          setErrorMessage(typeof err === "string" ? err : err?.message || "Webcam access denied");
        }}
      />

      {/* Framing guides */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-6 rounded-lg border border-primary/25" />
        {scanning && (
          <div className="absolute inset-x-6 top-6 h-px bg-primary/70 shadow-[0_0_12px_var(--primary)] animate-scanline" />
        )}
      </div>
    </div>
  );
}


