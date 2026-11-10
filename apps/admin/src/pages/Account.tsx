import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { type Provider, startOAuth, useProviders } from "@/lib/oauth";

/** Linking happens here, from a session that passed two-factor, never by email match at sign-in. */
export function AccountPage() {
  const [linked, setLinked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = useProviders();

  useEffect(() => {
    api<{ providerId: string }[]>("/api/auth/list-accounts")
      .then((accounts) => setLinked(new Set(accounts.map((a) => a.providerId))))
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  const link = async (provider: Provider) => {
    setBusy(true);
    try {
      await startOAuth("/api/auth/link-social", provider);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Account"
        description="Link a provider account with your email to sign in with it, without a 2FA code."
      />
      <Card className="max-w-md">
        <CardContent className="grid gap-3">
          {providers.length === 0 && (
            <p className="text-sm text-muted-foreground">No sign-in provider is configured.</p>
          )}
          {providers.map(({ id, label }) => (
            <div key={id} className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{label}</span>
              {linked?.has(id) ? (
                <Badge variant="success">Linked</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || linked === null}
                  onClick={() => link(id)}
                >
                  Link {label}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
