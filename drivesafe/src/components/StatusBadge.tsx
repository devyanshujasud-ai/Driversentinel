import { cn } from "@/lib/utils";

export type StatusKey = "normal" | "pre-alert" | "exceeded" | "fraud";

export function normalizeStatus(raw: unknown): StatusKey {
  const v = String(raw ?? "normal").toLowerCase();
  if (v.includes("fraud")) return "fraud";
  if (v.includes("sos") || v.includes("exceed")) return "exceeded";
  if (v.includes("pre") || v.includes("alert") || v.includes("warn")) return "pre-alert";
  return "normal";
}

export const STATUS_META: Record<StatusKey, { label: string; className: string }> = {
  normal: { label: "Normal", className: "border-ok/40 bg-ok/15 text-ok" },
  "pre-alert": { label: "Pre-Alert", className: "border-warn/40 bg-warn/15 text-warn" },
  exceeded: { label: "Exceeded / SOS", className: "border-danger/50 bg-danger/15 text-danger" },
  fraud: { label: "Fraud Flag", className: "border-fraud/40 bg-fraud/15 text-fraud" },
};

export function StatusBadge({ status }: { status: StatusKey }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-semibold tracking-wide uppercase",
        meta.className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}
