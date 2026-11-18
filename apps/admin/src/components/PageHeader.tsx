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
