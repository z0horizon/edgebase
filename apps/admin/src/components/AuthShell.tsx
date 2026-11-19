import { cn } from "cn";
import type { InputHTMLAttributes, ReactNode } from "react";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-[#f4f5f7] px-4 py-10 dark:bg-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,#f8f9fb_0%,#f8f9fb_56%,#eef0f4_56.1%,#eef0f4_100%)] dark:bg-[linear-gradient(135deg,#0b0c0e_0%,#0b0c0e_56%,#0e1014_56.1%,#0e1014_100%)]"
      />

      <main className="relative z-10 w-full max-w-[400px]">
        <div className="rounded-[5px] border border-black/[0.06] bg-card px-7 py-9 shadow-[0_12px_40px_-10px_rgba(15,23,42,0.12),0_2px_6px_rgba(15,23,42,0.04)] sm:px-10 sm:py-10 dark:border-border dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.65)]">
          <h1 className="text-center text-[24px] leading-tight font-normal tracking-[-0.01em] text-balance text-foreground">
            {title}
          </h1>
          <p className="mt-2.5 text-center text-[14px] leading-normal text-balance text-muted-foreground">
            {subtitle}
          </p>
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function FloatingInput({
  id,
  label,
  requiredMark = false,
  endAdornment,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder"> & {
  id: string;
  label: string;
  requiredMark?: boolean;
  endAdornment?: ReactNode;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        placeholder=" "
        className={cn(
          "peer h-[52px] w-full rounded-[4px] border border-[#c2c8d0] bg-card px-3.5 text-[15px] text-foreground transition-[border-color,box-shadow] duration-150 outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-input",
          endAdornment ? "pr-11" : "",
          className,
        )}
        {...props}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute top-0 left-2.5 -translate-y-1/2 bg-card px-1 text-[12px] leading-none text-muted-foreground transition-all duration-150 select-none peer-placeholder-shown:top-1/2 peer-placeholder-shown:text-[15px] peer-focus:top-0 peer-focus:text-[12px] peer-focus:text-primary-ink"
      >
        {label}
        {requiredMark && <span aria-hidden="true"> *</span>}
      </label>
      {endAdornment && (
        <div className="absolute top-1/2 right-2 -translate-y-1/2">{endAdornment}</div>
      )}
    </div>
  );
}
