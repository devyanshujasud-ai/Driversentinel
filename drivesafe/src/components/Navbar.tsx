import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useBackendStatus } from "@/lib/backend";
import { cn } from "@/lib/utils";

const links = [
  { to: "/", label: "Home" },
  { to: "/verify", label: "Verify" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/admin", label: "Admin" },
] as const;

export function Navbar() {
  const online = useBackendStatus();

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-5">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-md border border-primary/40 bg-primary/10">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-[0.14em] uppercase">DriveSafe</span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:px-3"
              activeProps={{ className: "text-foreground bg-secondary" }}
            >
              {l.label}
            </Link>
          ))}

          <span
            className="ml-2 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
            title={online ? "Backend reachable" : "Backend offline"}
          >
            <span className="relative flex size-2">
              <span
                className={cn(
                  "absolute inline-flex size-full rounded-full opacity-70 animate-pulse-ring",
                  online ? "bg-ok" : "bg-danger",
                )}
              />
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  online ? "bg-ok" : "bg-danger",
                )}
              />
            </span>
            <span className="hidden text-[11px] font-medium tracking-wider uppercase text-muted-foreground sm:inline">
              {online ? "Online" : "Offline"}
            </span>
          </span>
        </div>
      </nav>
    </header>
  );
}
