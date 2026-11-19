import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Provider } from "@/lib/oauth";

export function ProviderIcon({ provider }: { provider: Provider }) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0">
        <path
          fill="#4285F4"
          d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96Z"
        />
      </svg>
    );
  }
  if (provider === "github") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0 fill-foreground">
        <path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .3Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="2.6 2.6 19.2 19.2" aria-hidden="true" className="size-4 shrink-0 fill-foreground">
      <path d="M16.37 12.76c.02 2.58 2.26 3.44 2.29 3.45-.02.06-.36 1.23-1.18 2.43-.71 1.04-1.45 2.08-2.62 2.1-1.14.02-1.51-.68-2.82-.68-1.31 0-1.72.66-2.8.7-1.12.04-1.98-1.12-2.7-2.16-1.47-2.12-2.59-5.99-1.08-8.61.75-1.3 2.09-2.12 3.54-2.14 1.11-.02 2.15.75 2.82.75.67 0 1.94-.92 3.27-.79.56.02 2.12.23 3.12 1.69-.08.05-1.86 1.09-1.84 3.26ZM14.22 6.4c.6-.72 1-1.73.89-2.73-.86.04-1.91.57-2.53 1.3-.55.64-1.04 1.67-.91 2.65.96.07 1.95-.49 2.55-1.22Z" />
    </svg>
  );
}

export function FederatedOptions({
  showDivider,
  showPasskey,
  providers,
  busy,
  onPasskey,
  onProvider,
}: {
  showDivider: boolean;
  showPasskey: boolean;
  providers: readonly { id: Provider; label: string }[];
  busy: boolean;
  onPasskey?: (() => void) | undefined;
  onProvider: (provider: Provider) => void;
}) {
  if (!showPasskey && providers.length === 0) return null;

  const gridCols =
    providers.length >= 3 ? "grid-cols-3" : providers.length === 2 ? "grid-cols-2" : "grid-cols-1";

  return (
    <>
      {showDivider && (
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] text-muted-foreground">or continue with</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      <div className="grid gap-2">
        {showPasskey && onPasskey && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={onPasskey}
            className="w-full justify-center gap-2 text-[13px]"
          >
            <Fingerprint className="size-4 shrink-0 text-foreground" />
            <span>Continue with a passkey</span>
          </Button>
        )}
        {providers.length > 0 && (
          <div className={`grid gap-2 ${gridCols}`}>
            {providers.map(({ id, label }) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="lg"
                aria-label={`Continue with ${label}`}
                disabled={busy}
                onClick={() => onProvider(id)}
                className="w-full justify-center gap-2 px-2.5 text-[13px]"
              >
                <ProviderIcon provider={id} />
                <span>{providers.length === 1 ? `Continue with ${label}` : label}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
