import { cn } from "cn";
import {
  BellRing,
  ChevronsUpDown,
  FileText,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Send,
  Sun,
  Users,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { api, type Me, type User } from "@/lib/api";
import { takeOAuthError } from "@/lib/oauth";
import { clearSessionDrafts, viewKeyFromHash } from "@/lib/state";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { SignIn } from "./pages/SignIn";

const AccountPage = lazy(() => import("./pages/Account").then((m) => ({ default: m.AccountPage })));
const PushesPage = lazy(() => import("./pages/Pushes").then((m) => ({ default: m.PushesPage })));
const SendPage = lazy(() => import("./pages/Send").then((m) => ({ default: m.SendPage })));
const TemplatesPage = lazy(() =>
  import("./pages/Templates").then((m) => ({ default: m.TemplatesPage })),
);
const TwoFactorSetup = lazy(() =>
  import("./pages/TwoFactorSetup").then((m) => ({ default: m.TwoFactorSetup })),
);
const UsersPage = lazy(() => import("./pages/Users").then((m) => ({ default: m.UsersPage })));

const VIEWS = {
  users: { label: "Users", shortLabel: "Users", icon: Users, group: "ops", page: UsersPage },
  send: { label: "Send push", shortLabel: "Send", icon: Send, group: "ops", page: SendPage },
  pushes: {
    label: "Sent pushes",
    shortLabel: "Pushes",
    icon: BellRing,
    group: "ops",
    page: PushesPage,
  },
  templates: {
    label: "Templates",
    shortLabel: "Templates",
    icon: FileText,
    group: "ops",
    page: TemplatesPage,
  },
  account: {
    label: "Account & Security",
    shortLabel: "Security",
    icon: KeyRound,
    group: "security",
    page: AccountPage,
  },
} satisfies Record<
  string,
  {
    label: string;
    shortLabel: string;
    icon: typeof Users;
    group: "ops" | "security";
    page: (p: { me: User }) => ReactNode;
  }
>;
type View = keyof typeof VIEWS;

const OPS_KEYS: View[] = ["users", "send", "pushes", "templates"];
const SECURITY_KEYS: View[] = ["account"];

const viewFromHash = (): View => viewKeyFromHash(location.hash, VIEWS, "users");

function AccountMenu({
  me,
  side,
  align,
  onSignOut,
  className,
}: {
  me: User;
  side: "top" | "bottom";
  align: "start" | "end";
  onSignOut: () => void;
  className?: string;
}) {
  const { preference, setPreference } = useTheme();
  const hasDistinctName = Boolean(
    me.name &&
      me.name !== me.email &&
      me.name.toLowerCase() !== me.email.split("@")[0]?.toLowerCase(),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn(
            "flex items-center justify-between gap-2 rounded-md text-left transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent",
            className,
          )}
        >
          <span className="truncate font-medium text-sidebar-foreground">{me.email}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-56">
        <div className="px-2 py-1.5">
          {hasDistinctName && (
            <p className="truncate text-xs font-medium text-foreground">{me.name}</p>
          )}
          <p className="truncate text-xs text-muted-foreground" title={me.email}>
            {me.email}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            location.hash = "#account";
          }}
        >
          <KeyRound /> Account & Security
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(v) => setPreference(v as ThemePreference)}
        >
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>(viewFromHash);

  // The server decides who must set up a second factor; the page only follows its answer.
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
        <div className="flex w-56 flex-col gap-2 rounded-md border bg-card px-4 py-3.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-2.5 w-36" />
        </div>
      </div>
    );
  }

  const signOut = async () => {
    clearSessionDrafts(sessionStorage);
    await api("/api/auth/sign-out", { method: "POST", body: {} }).catch(() => {});
    setMe(null);
  };

  let content: ReactNode;
  if (me?.role !== "admin") {
    content = <SignIn notAdmin={me !== null} onSignedIn={loadSession} />;
  } else if (me.adminNeedsTwoFactor) {
    content = (
      <Suspense fallback={null}>
        <TwoFactorSetup email={me.email} onDone={loadSession} onSignOut={signOut} />
      </Suspense>
    );
  } else {
    const Page = VIEWS[view].page;
    const renderNavItem = (key: View) => {
      const { label, shortLabel, icon: Icon } = VIEWS[key];
      const active = view === key;
      return (
        <a
          key={key}
          href={`#${key}`}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none md:h-8 md:gap-2 md:px-2.5 md:text-[13px]",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0 transition-colors",
              active
                ? "text-primary-ink"
                : "text-muted-foreground group-hover:text-sidebar-foreground",
            )}
          />
          <span className="md:hidden">{shortLabel}</span>
          <span className="hidden md:inline">{label}</span>
        </a>
      );
    };

    content = (
      <div className="min-h-screen bg-background md:grid md:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="flex flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
          <div className="flex h-12 items-center justify-between gap-2 border-b border-sidebar-border px-3.5">
            <a
              href="#users"
              className="text-sm font-semibold tracking-tight text-sidebar-foreground focus-visible:outline-none"
            >
              EdgeBase
            </a>
            <AccountMenu
              me={me}
              side="bottom"
              align="end"
              onSignOut={signOut}
              className="h-7 max-w-[200px] border border-sidebar-border bg-card px-2.5 text-xs md:hidden"
            />
          </div>

          <nav
            className="flex items-center gap-1 overflow-x-auto px-2.5 py-2 md:flex-1 md:flex-col md:items-stretch md:gap-0.5 md:py-3"
            aria-label="Sections"
          >
            {OPS_KEYS.map(renderNavItem)}
            <div
              aria-hidden="true"
              className="hidden bg-sidebar-border md:my-2 md:block md:h-px md:w-full"
            />
            <div className="hidden md:flex md:flex-col md:gap-0.5">
              {SECURITY_KEYS.map(renderNavItem)}
            </div>
          </nav>

          <div className="mt-auto hidden border-t border-sidebar-border p-2 md:block">
            <AccountMenu
              me={me}
              side="top"
              align="start"
              onSignOut={signOut}
              className="h-9 w-full px-2.5 text-[13px] hover:bg-sidebar-accent"
            />
          </div>
        </aside>

        <main className="mx-auto w-full max-w-[1140px] px-4 py-5 sm:px-8 sm:py-7">
          <Suspense fallback={<Skeleton className="h-44 w-full rounded-md" />}>
            <Page me={me} />
          </Suspense>
        </main>
      </div>
    );
  }

  return (
    <>
      {content}
      <Toaster />
    </>
  );
}
