import { cn } from "cn";

/** Precision geometric brand glyph reflecting the 2x2 architectural grid without decorative gradients. */
export function BrandMark({
  className,
  tone = "sidebar",
}: {
  className?: string;
  tone?: "sidebar" | "surface";
}) {
  const accentFill = tone === "surface" ? "var(--primary)" : "var(--sidebar-primary)";
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
    >
      <rect x="2" y="2" width="7" height="7" rx="1" fill="currentColor" opacity="0.92" />
      <rect x="11" y="2" width="7" height="7" rx="1" fill={accentFill} />
      <rect x="2" y="11" width="7" height="7" rx="1" fill="currentColor" opacity="0.35" />
      <rect x="11" y="11" width="7" height="7" rx="1" fill="currentColor" opacity="0.68" />
    </svg>
  );
}
