import { cn } from "cn";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  History,
  LogOut,
  Monitor,
  Moon,
  Radio,
  Send,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/BrandMark";
import { AccentSwatchPicker } from "@/components/ThemeCustomizer";
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
import { takeOAuthError, useAppName } from "@/lib/oauth";
import { clearSessionDrafts, viewKeyFromHash } from "@/lib/state";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { AuthPortal, PendingAccess } from "./pages/AuthPortal";

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
  users: { label: "Users", shortLabel: "Users", icon: Users, group: "top", page: UsersPage },
  send: { label: "Send push", shortLabel: "Send", icon: Send, group: "push", page: SendPage },
  pushes: {
    label: "Sent pushes",
    shortLabel: "History",
    icon: History,
    group: "push",
    page: PushesPage,
  },
  templates: {
    label: "Templates",
    shortLabel: "Templates",
    icon: FileText,
    group: "push",
    page: TemplatesPage,
  },
  account: {
    label: "Account & Security",
    shortLabel: "Security",
    icon: Settings,
    group: "security",
    page: AccountPage,
  },
} satisfies Record<
  string,
  {
    label: string;
    shortLabel: string;
    icon: typeof Users;
    group: "top" | "push" | "security";
    page: (p: { me: User; onRefresh?: () => Promise<void> }) => ReactNode;
  }
>;
type View = keyof typeof VIEWS;

const PUSH_KEYS: View[] = ["send", "pushes", "templates"];
const ALL_KEYS: View[] = ["users", ...PUSH_KEYS, "account"];

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
  const { preference, accentSwatch, setPreference } = useTheme();
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
          aria-label="Account and appearance menu"
          className={cn(
            "flex items-center justify-between gap-2 rounded-md text-left transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-secondary",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[2px] border border-black/15 dark:border-white/25"
              style={{ backgroundColor: accentSwatch }}
            />
            <span className="truncate font-medium text-sidebar-foreground">{me.email}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-64 p-1.5">
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
          <Settings /> Account &amp; Security
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
        <div className="grid gap-1.5 px-2 py-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Primary color</span>
            <span className="font-mono text-[10px] text-muted-foreground">{accentSwatch}</span>
          </div>
          <AccentSwatchPicker compact />
        </div>
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
  const [pushMenuOpen, setPushMenuOpen] = useState(true);
  const appName = useAppName();

  // The server decides who must set up a second factor; the page only follows its answer.
  const loadSession = useCallback(async () => {
    setMe(await api<Me>("/v1/me").catch(() => null));
  }, []);

  useEffect(() => {
    loadSession();
    const onHash = () => {
      const next = viewFromHash();
      setView(next);
      if (PUSH_KEYS.includes(next)) setPushMenuOpen(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadSession]);

  const inConsole = me?.role === "admin" && !me.adminNeedsTwoFactor;
  // A failed link-social comes back here signed in; a failed sign-in is shown by AuthPortal instead.
  useEffect(() => {
    const error = inConsole ? takeOAuthError() : "";
    if (error) toast.error(error);
  }, [inConsole]);

  if (me === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-background p-4">
        <div className="flex w-60 flex-col gap-2.5 rounded-md border bg-card px-4 py-4">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-2.5 w-44" />
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
  if (me === null) {
    content = <AuthPortal onSignedIn={loadSession} />;
  } else if (me.role !== "admin") {
    content = <PendingAccess me={me} onRefresh={loadSession} onSignOut={signOut} />;
  } else if (me.adminNeedsTwoFactor) {
    content = (
      <Suspense fallback={null}>
        <TwoFactorSetup email={me.email} onDone={loadSession} onSignOut={signOut} />
      </Suspense>
    );
  } else {
    const Page = VIEWS[view].page;
    const inPushGroup = PUSH_KEYS.includes(view);
    const renderTopLink = (key: "users" | "account") => {
      const { label, icon: Icon } = VIEWS[key];
      const active = view === key;
      return (
        <a
          key={key}
          href={`#${key}`}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group hidden h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13.5px] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none md:flex",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-sidebar-foreground/85 hover:bg-secondary/75 hover:text-sidebar-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-4 shrink-0 transition-colors",
              active
                ? "text-sidebar-primary"
                : "text-sidebar-muted group-hover:text-sidebar-foreground",
            )}
          />
          <span>{label}</span>
        </a>
      );
    };

    const renderMobilePill = (key: View) => {
      const { shortLabel, icon: Icon } = VIEWS[key];
      const active = view === key;
      return (
        <a
          key={key}
          href={`#${key}`}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none md:hidden",
            active
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-sidebar-muted hover:bg-secondary/75 hover:text-sidebar-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0 transition-colors",
              active
                ? "text-sidebar-primary"
                : "text-sidebar-muted group-hover:text-sidebar-foreground",
            )}
          />
          <span>{shortLabel}</span>
        </a>
      );
    };

    content = (
      <div className="min-h-screen bg-background md:grid md:grid-cols-[248px_minmax(0,1fr)]">
        <aside className="flex flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
          <div className="flex h-13.5 items-center justify-between gap-2 border-b border-sidebar-border px-4">
            <a
              href="#users"
              className="inline-flex min-w-0 items-center gap-2.5 text-[14px] font-semibold tracking-tight text-sidebar-foreground focus-visible:outline-none"
            >
              <BrandMark />
              <span className="truncate">{appName || "EdgeBase"}</span>
            </a>
            <span className="hidden rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground md:inline-block">
              Admin
            </span>
            <AccountMenu
              me={me}
              side="bottom"
              align="end"
              onSignOut={signOut}
              className="h-7 max-w-[190px] border border-border bg-secondary/70 px-2 text-xs md:hidden"
            />
          </div>

          <nav
            className="flex items-center gap-1 overflow-x-auto px-2.5 py-2 md:flex-1 md:flex-col md:items-stretch md:gap-1 md:px-3 md:py-3.5"
            aria-label="Sections"
          >
            {ALL_KEYS.map(renderMobilePill)}

            {renderTopLink("users")}

            <div className="hidden md:grid md:gap-1">
              <button
                type="button"
                aria-expanded={pushMenuOpen}
                onClick={() => setPushMenuOpen((open) => !open)}
                className={cn(
                  "flex h-9 w-full items-center justify-between gap-2 rounded-md px-3 text-[13.5px] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
                  inPushGroup
                    ? "bg-secondary font-medium text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-secondary/75 hover:text-sidebar-foreground",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <Radio
                    className={cn(
                      "size-4 shrink-0",
                      inPushGroup ? "text-sidebar-primary" : "text-sidebar-muted",
                    )}
                  />
                  <span>Push notifications</span>
                </span>
                {pushMenuOpen ? (
                  <ChevronDown className="size-3.5 text-sidebar-muted" />
                ) : (
                  <ChevronRight className="size-3.5 text-sidebar-muted" />
                )}
              </button>

              {pushMenuOpen && (
                <div className="ml-[19px] grid gap-0.5 border-l border-sidebar-border pl-3">
                  {PUSH_KEYS.map((key) => {
                    const active = view === key;
                    return (
                      <a
                        key={key}
                        href={`#${key}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-8 items-center rounded-md px-2.5 text-[13px] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
                          active
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "text-sidebar-muted hover:bg-secondary/75 hover:text-sidebar-foreground",
                        )}
                      >
                        {VIEWS[key].label}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>

            {renderTopLink("account")}
          </nav>

          <div className="mt-auto hidden border-t border-sidebar-border p-2.5 md:block">
            <AccountMenu
              me={me}
              side="top"
              align="start"
              onSignOut={signOut}
              className="h-9 w-full px-2.5 text-[13px] hover:bg-secondary/80"
            />
          </div>
        </aside>

        <main className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-8 sm:py-7">
          <Suspense fallback={<Skeleton className="h-44 w-full rounded-md" />}>
            <Page me={me} onRefresh={loadSession} />
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
export { ALL_KEYS };
