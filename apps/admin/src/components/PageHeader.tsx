import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function PushUnconfiguredBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-amber-600/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-400/25 dark:text-amber-200"
    >
      {children}
    </div>
  );
}
