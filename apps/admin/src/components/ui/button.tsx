import { cn } from "cn";
import type * as React from "react";

const VARIANTS = {
  default: "border border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
  destructive:
    "border border-transparent bg-[#c92a2a] text-white hover:bg-[#b02323] focus-visible:ring-destructive/30",
  "destructive-outline":
    "border border-destructive/45 bg-destructive/[0.06] text-destructive hover:border-destructive/70 hover:bg-destructive/12 dark:border-destructive/40 dark:bg-destructive/10 dark:hover:bg-destructive/20 focus-visible:ring-destructive/30",
  outline:
    "border border-border bg-card text-foreground hover:bg-secondary/65 hover:border-input",
  secondary:
    "border border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
} as const;

const SIZES = {
  default: "h-8 gap-1.5 px-3 py-1.5 has-[>svg]:px-2.5",
  xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2",
  lg: "h-10 gap-2 px-4 text-[14px] has-[>svg]:px-3.5",
  "icon-sm": "size-7",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        !className?.includes("rounded-") && "rounded-md",
        "inline-flex shrink-0 cursor-pointer items-center justify-center text-[13px] font-medium whitespace-nowrap transition-[color,background-color,border-color] duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
