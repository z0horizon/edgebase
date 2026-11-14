import { BellRing, FileText, KeyRound, Layers, LogOut, Send, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { api, type Me, type User } from "@/lib/api";
import { takeOAuthError } from "@/lib/oauth";
import { clearSessionDrafts, viewKeyFromHash } from "@/lib/state";
import { cn } from "@/lib/utils";
import { AccountPage } from "./pages/Account";
import { PushesPage } from "./pages/Pushes";
import { SendPage } from "./pages/Send";
import { SignIn } from "./pages/SignIn";
import { TemplatesPage } from "./pages/Templates";
import { TwoFactorSetup } from "./pages/TwoFactorSetup";
import { UsersPage } from "./pages/Users";

const VIEWS = {
  users: { label: "Users", icon: Users, page: UsersPage },
  send: { label: "Send a push", icon: Send, page: SendPage },
  pushes: { label: "Sent pushes", icon: BellRing, page: PushesPage },
  templates: { label: "Templates", icon: FileText, page: TemplatesPage },
  account: { label: "Account", icon: KeyRound, page: AccountPage },
} satisfies Record<
  string,
  { label: string; icon: typeof Users; page: (p: { me: User }) => ReactNode }
>;
type View = keyof typeof VIEWS;

const viewFromHash = (): View => viewKeyFromHash(location.hash, VIEWS, "users");

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>(viewFromHash);

  // The server decides who must set up TOTP; the page only follows its answer.
  const loadSession = useCallback(async () => {
    setMe(await api<Me>("/v1/me").catch(() => null));
  }, []);

  useEffect(() => {
    loadSession();
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadSession]);

  const inConsole = me?.role === "admin" && !me.adminNeedsTwoFactor;
  // A failed link-social comes back here signed in; a failed sign-in is shown by SignIn instead.
  useEffect(() => {
    const error = inConsole ? takeOAuthError() : "";
    if (error) toast.error(error);
  }, [inConsole]);

  if (me === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-background p-4">
        <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-4 shadow-xs">
          <Skeleton className="size-8 rounded-lg" />
          <div className="grid gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      </div>
    );
  }
  const signOut = async () => {
    clearSessionDrafts(sessionStorage);
    await api("/api/auth/sign-out", { method: "POST", body: {} }).catch(() => {});
    setMe(null);
  };
  if (me?.role !== "admin") {
    return (
      <>
        <SignIn notAdmin={me !== null} onSignedIn={loadSession} />
        <Toaster />
      </>
    );
  }
  if (me.adminNeedsTwoFactor) {
    return (
      <>
        <TwoFactorSetup email={me.email} onDone={loadSession} onSignOut={signOut} />
        <Toaster />
      </>
    );
  }
  const Page = VIEWS[view].page;
  const initial = (me.name || me.email).trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[252px_1fr]">
      <aside className="flex flex-col gap-3 border-b bg-sidebar p-3 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0 md:p-4">
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs">
              <Layers className="size-4" />
            </span>
            <div className="grid leading-tight">
              <span className="text-sm font-semibold tracking-tight">EdgeBase</span>
              <span className="text-[11px] text-muted-foreground">Admin console</span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={signOut}
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </Button>
        </div>

        <nav className="flex gap-1 overflow-x-auto md:mt-2 md:flex-col" aria-label="Sections">
          {(Object.keys(VIEWS) as View[]).map((key) => {
            const { label, icon: Icon } = VIEWS[key];
            const active = view === key;
            return (
              <a
                key={key}
                href={`#${key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="hidden h-4 w-1 rounded-full bg-primary md:absolute md:left-0 md:block"
                  />
                )}
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                {label}
              </a>
            );
          })}
        </nav>

        <div className="mt-auto hidden rounded-xl border bg-background/60 p-2.5 md:grid md:gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
            >
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              {me.name && <p className="truncate text-xs font-medium">{me.name}</p>}
              <p className="truncate text-xs text-muted-foreground" title={me.email}>
                {me.email}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="w-full justify-center" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl p-4 sm:p-6 md:p-8 lg:py-10">
        <Page me={me} />
      </main>
      <Toaster />
    </div>
  );
}
