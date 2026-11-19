import { cn } from "cn";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { AuthAppearanceControl } from "@/components/ThemeCustomizer";
import { useSignInOptions } from "@/lib/oauth";

export type AuthStep = {
  label: string;
  state: "done" | "current" | "pending";
};

export function AuthShell({
  title,
  subtitle,
  steps,
  topSlot,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  steps?: readonly AuthStep[];
  topSlot?: ReactNode;
  children: ReactNode;
}) {
  const { appName } = useSignInOptions();
  const displayApp = appName || "EdgeBase";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex w-full items-center justify-between gap-3 px-5 py-4 sm:px-8 sm:py-5">
        <a
          href="#signin"
          className="inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-foreground focus-visible:outline-none"
        >
          <BrandMark tone="surface" />
          <span>{displayApp}</span>
        </a>
        <AuthAppearanceControl />
      </header>

      <main className="grid flex-1 place-items-center px-4 pt-2 pb-12 sm:px-8">
        <div className="w-full max-w-[440px] overflow-hidden rounded-md border bg-card shadow-[0_10px_32px_-12px_rgba(25,26,28,0.09),0_1px_3px_rgba(25,26,28,0.04)] dark:shadow-[0_22px_52px_-16px_rgba(0,0,0,0.65)]">
          {topSlot && <div className="border-b bg-muted/45 p-2">{topSlot}</div>}

          {steps && steps.length > 0 && (
            <ol
              aria-label="Progress"
              className="grid border-b bg-muted/35"
              style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
            >
              {steps.map((step, index) => (
                <li
                  key={step.label}
                  className={cn(
                    "flex items-center justify-center gap-1.5 border-r px-2.5 py-2 text-[11px] font-medium last:border-r-0",
                    step.state === "current" && "bg-accent text-accent-foreground",
                    step.state === "done" && "text-emerald-700 dark:text-emerald-400",
                    step.state === "pending" && "text-muted-foreground",
                  )}
                >
                  <span className="font-mono text-[11px] tabular-nums">
                    {step.state === "done" ? <Check className="size-3" /> : `${index + 1}.`}
                  </span>
                  <span className="truncate">{step.label}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="px-6 py-7 sm:px-8 sm:py-8">
            <h1 className="text-[22px] leading-snug font-semibold tracking-[-0.025em] text-balance text-foreground">
              {title}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-pretty text-muted-foreground">
              {subtitle}
            </p>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
