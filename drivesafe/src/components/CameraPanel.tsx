import { Suspense, lazy } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { Camera } from "lucide-react";

const CameraFeed = lazy(() => import("./CameraFeed"));

function CameraFallback() {
  return (
    <div className="flex aspect-4/3 w-full items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
      <Camera className="mr-2 size-4" aria-hidden />
      <span className="text-sm">Starting camera…</span>
    </div>
  );
}

export function CameraPanel({
  registerCapture,
  scanning = true,
  onReady,
}: {
  registerCapture: (fn: () => string | null) => void;
  scanning?: boolean;
  onReady?: () => void;
}) {
  return (
    <ClientOnly fallback={<CameraFallback />}>
      <Suspense fallback={<CameraFallback />}>
        <CameraFeed registerCapture={registerCapture} scanning={scanning} onReady={onReady} />
      </Suspense>
    </ClientOnly>
  );
}

