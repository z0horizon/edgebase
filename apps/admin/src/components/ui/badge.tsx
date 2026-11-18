import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default:
          "border-primary/25 bg-accent text-accent-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground",
        success:
          "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300",
        warning:
          "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive dark:bg-destructive/15",
        outline:
          "border-border bg-card text-muted-foreground",
        ghost: "border-transparent text-muted-foreground",
        link: "border-transparent text-primary-ink underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
