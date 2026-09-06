import { useCallback, useRef, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { CameraPanel } from "@/components/CameraPanel";
import { postImage } from "@/lib/backend";
import { useFirebaseValue } from "@/lib/firebase";
import { firebaseConfigured } from "@/lib/env";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Enroll Drivers — DriveSafe Admin" },
      {
        name: "description",
        content:
          "Enroll fleet drivers with an RFID credential and a reference face capture for verified cab access.",
      },
      { property: "og:title", content: "Enroll Drivers — DriveSafe Admin" },
      {
        property: "og:description",
        content: "Enroll fleet drivers with an RFID credential and a reference face capture.",
      },
    ],
  }),
  component: AdminPage,
});

type DriverNode = { name?: string; rfid?: string; enrolledAt?: number | string };

function AdminPage() {
  const captureRef = useRef<(() => string | null) | null>(null);
  const [name, setName] = useState("");
  const [rfid, setRfid] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [localDrivers, setLocalDrivers] = useState<DriverNode[]>([]);

  const { data: remoteDrivers } = useFirebaseValue<Record<string, DriverNode>>("drivers");

  const registerCapture = useCallback((fn: () => string | null) => {
    captureRef.current = fn;
  }, []);

  const drivers: DriverNode[] =
    firebaseConfigured && remoteDrivers
      ? Object.values(remoteDrivers)
      : localDrivers;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rfid.trim()) {
      toast.error("Driver name and RFID UID are required");
      return;
    }
    const photo = shot ?? captureRef.current?.() ?? null;
    if (!photo) {
      toast.error("Capture an enrollment photo first");
      return;
    }
    setSubmitting(true);
    try {
      await postImage("/enroll", photo, { name: name.trim(), rfid: rfid.trim() });
      toast.success(`${name.trim()} enrolled`);
      setLocalDrivers((prev) => [
        { name: name.trim(), rfid: rfid.trim(), enrolledAt: Date.now() },
        ...prev,
      ]);
      setName("");
      setRfid("");
      setShot(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Driver Enrollment</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Register a driver's credential and reference face capture.
      </p>

      <form onSubmit={onSubmit} className="panel mt-6 grid animate-fade-up gap-6 p-6 md:grid-cols-2">
        <div className="space-y-4">
          <Field label="Driver name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. A. Ramírez"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-ring"
            />
          </Field>
          <Field label="RFID UID">
            <input
              value={rfid}
              onChange={(e) => setRfid(e.target.value)}
              placeholder="04 A2 3F 91"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 font-mono text-sm outline-none transition-colors focus:border-ring"
            />
          </Field>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                const s = captureRef.current?.();
                if (s) {
                  setShot(s);
                  toast.success("Enrollment photo captured");
                } else toast.error("Camera unavailable — check permissions");
              }}
              className="flex-1 rounded-md border border-border bg-secondary px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-accent"
            >
              {shot ? "Retake photo" : "Capture photo"}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <UserPlus className="size-4" aria-hidden />
              )}
              Enroll
            </button>
          </div>
        </div>

        <div>
          {shot ? (
            <img
              src={shot}
              alt="Captured enrollment photo"
              className="aspect-4/3 w-full animate-fade-in rounded-xl border border-ok/40 object-cover"
            />
          ) : (
            <CameraPanel registerCapture={registerCapture} />
          )}
        </div>
      </form>

      <section className="panel mt-6 overflow-hidden">
        <header className="border-b border-border px-5 py-3.5">
          <h2 className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            Enrolled Drivers
          </h2>
        </header>
        <table className="w-full text-sm">
          <thead className="text-[11px] tracking-wider uppercase text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 text-left font-medium">Name</th>
              <th className="px-5 py-2.5 text-left font-medium">RFID UID</th>
              <th className="px-5 py-2.5 text-left font-medium">Enrolled</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d, i) => (
              <tr key={`${d.rfid}-${i}`} className="animate-fade-up border-t border-border/70">
                <td className="px-5 py-3">{d.name ?? "—"}</td>
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{d.rfid ?? "—"}</td>
                <td className="px-5 py-3 text-muted-foreground">
                  {d.enrolledAt ? new Date(d.enrolledAt).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr>
                <td colSpan={3} className="px-5 py-10 text-center text-sm text-muted-foreground">
                  No drivers enrolled yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium tracking-[0.16em] uppercase text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
