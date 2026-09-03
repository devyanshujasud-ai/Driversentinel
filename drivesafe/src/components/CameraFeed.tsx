import { useCallback, useEffect, useRef } from "react";
import Webcam from "react-webcam";

type Props = {
  registerCapture: (fn: () => string | null) => void;
  scanning?: boolean;
};

export default function CameraFeed({ registerCapture, scanning = true }: Props) {
  const camRef = useRef<Webcam | null>(null);

  const capture = useCallback(() => camRef.current?.getScreenshot() ?? null, []);

  useEffect(() => {
    registerCapture(capture);
  }, [capture, registerCapture]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-background">
      <Webcam
        ref={camRef}
        audio={false}
        mirrored
        screenshotFormat="image/jpeg"
        screenshotQuality={0.92}
        videoConstraints={{ facingMode: "user", width: 720, height: 540 }}
        className="aspect-4/3 w-full object-cover"
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
