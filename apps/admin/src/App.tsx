import { BellRing, FileText, LogOut, Send, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { api, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
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
} satisfies Record<
  string,
  { label: string; icon: typeof Users; page: (p: { me: User }) => ReactNode }
>;
type View = keyof typeof VIEWS;

const viewFromHash = (): View => {
  const hash = location.hash.slice(1);
  return hash in VIEWS ? (hash as View) : "users";
};

export function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [view, setView] = useState<View>(viewFromHash);

  const loadSession = useCallback(async () => {
    const session = await api<{ user: User } | null>("/api/auth/get-session").catch(() => null);
    setMe(session?.user ?? null);
  }, []);

  useEffect(() => {
    loadSession();
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadSession]);

  if (me === undefined) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Skeleton className="h-8 w-40" />
      </div>
    );
  }
  const signOut = async () => {
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
  if (!me.twoFactorEnabled) {
    return (
      <>
        <TwoFactorSetup email={me.email} onDone={loadSession} onSignOut={signOut} />
        <Toaster />
      </>
    );
  }
  const Page = VIEWS[view].page;

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[240px_1fr]">
      <aside className="flex flex-col gap-1 border-b bg-muted/40 p-3 md:sticky md:top-0 md:h-screen md:border-r md:border-b-0 md:p-4">
        <div className="px-2 pb-4 font-semibold tracking-tight">EdgeBase</div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Sections">
          {(Object.keys(VIEWS) as View[]).map((key) => {
            const { label, icon: Icon } = VIEWS[key];
            return (
              <a
                key={key}
                href={`#${key}`}
                aria-current={view === key ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  view === key && "bg-background font-medium text-foreground shadow-xs",
                )}
              >
                <Icon className="size-4" />
                {label}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center justify-between gap-2 px-2 pt-3 md:grid md:pt-4">
          <p className="truncate text-xs text-muted-foreground" title={me.email}>
            {me.email}
          </p>
          <Button variant="outline" size="sm" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl p-4 md:p-8">
        <Page me={me} />
      </main>
      <Toaster />
    </div>
  );
}
