import { Eye, EyeOff } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasswordField({
  id,
  label,
  labelAction,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  label: string;
  labelAction?: ReactNode;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAction}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          className={className ? `pr-10 ${className}` : "h-10 pr-10 text-[14px]"}
          {...props}
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((prev) => !prev)}
          className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
