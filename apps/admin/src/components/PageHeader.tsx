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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border/80 pb-5">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
    </header>
  );
}
