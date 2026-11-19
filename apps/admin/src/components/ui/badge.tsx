import { cn } from "cn";
import type * as React from "react";

const VARIANTS = {
  default: "border-primary/25 bg-accent text-accent-foreground",
  secondary: "border-border bg-secondary text-secondary-foreground",
  success:
    "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300",
  warning:
    "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive dark:bg-destructive/15",
  outline: "border-border bg-card text-muted-foreground",
} as const;

export type BadgeVariant = keyof typeof VARIANTS;

export function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 [&>svg]:pointer-events-none [&>svg]:size-3",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
