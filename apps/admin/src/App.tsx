import {
  Bell,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
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
import { clearSessionDrafts, routeFromHash } from "@/lib/state";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
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
  users: { label: "Users", shortLabel: "Users", icon: Users, page: UsersPage },
  notifications: {
    label: "Dispatches",
    shortLabel: "Dispatches",
    icon: Bell,
    page: PushesPage,
  },
  templates: {
    label: "Templates",
    shortLabel: "Templates",
    icon: FileText,
    page: TemplatesPage,
  },
  account: {
    label: "Account & Security",
    shortLabel: "Security",
    icon: KeyRound,
    page: AccountPage,
  },
} satisfies Record<
  string,
  {
    label: string;
    shortLabel: string;
    icon: typeof Users;
    page: (p: { me: User }) => ReactNode;
  }
>;
type View = keyof typeof VIEWS;

const MOBILE_KEYS: View[] = ["users", "notifications", "templates", "account"];
const HASH_ALIASES: Record<string, View> = { pushes: "notifications", send: "notifications" };
const RAIL_COLLAPSED_KEY = "edgebase:rail-collapsed";
const NOTIF_OPEN_KEY = "edgebase:nav-notifications-open";

const route = () => routeFromHash(location.hash, VIEWS, "users", HASH_ALIASES);
const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
};
const writeFlag = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {}
};

function AccountMenu({
  me,
  side,
  align,
  collapsed = false,
  onSignOut,
  className,
}: {
  me: User;
  side: "top" | "bottom" | "right";
  align: "start" | "end";
  collapsed?: boolean;
  onSignOut: () => void;
  className?: string | undefined;
}) {
  const { preference, setPreference } = useTheme();
  const hasDistinctName = Boolean(
    me.name &&
      me.name !== me.email &&
      me.name.toLowerCase() !== me.email.split("@")[0]?.toLowerCase(),
  );
  const initial = (me.name || me.email).trim().charAt(0).toUpperCase() || "A";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          title={collapsed ? me.email : undefined}
          className={cn(
            "rounded-md transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent",
            collapsed
              ? "grid size-8 place-items-center border border-sidebar-border bg-card text-xs font-semibold text-sidebar-foreground hover:bg-sidebar-accent"
              : "flex items-center justify-between gap-2 text-left",
            className,
          )}
        >
          {collapsed ? (
            <span>{initial}</span>
          ) : (
            <>
              <span className="truncate font-medium text-sidebar-foreground">{me.email}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
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
  const [activeRoute, setActiveRoute] = useState(route);
  const [railCollapsed, setRailCollapsed] = useState(() => readFlag(RAIL_COLLAPSED_KEY, false));
  const [notifOpen, setNotifOpen] = useState(() => readFlag(NOTIF_OPEN_KEY, true));

  // The server decides who must set up a second factor; the page only follows its answer.
  const loadSession = useCallback(async () => {
    setMe(await api<Me>("/v1/me").catch(() => null));
  }, []);

  useEffect(() => {
    loadSession();
    const onHash = () => setActiveRoute(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadSession]);

  const inNotifications = activeRoute.view === "notifications" || activeRoute.view === "templates";
  useEffect(() => {
    if (inNotifications) {
      setNotifOpen(true);
      writeFlag(NOTIF_OPEN_KEY, true);
    }
  }, [inNotifications]);

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
      <Suspense fallback={null}>
        <TwoFactorSetup email={me.email} onDone={loadSession} onSignOut={signOut} />
        <Toaster />
      </Suspense>
    );
  }

  const view = activeRoute.view;
  const Page =
    view === "notifications" && activeRoute.subview === "send" ? SendPage : VIEWS[view].page;

  const toggleRail = () => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    writeFlag(RAIL_COLLAPSED_KEY, next);
  };

  const toggleNotif = () => {
    const next = !notifOpen;
    setNotifOpen(next);
    writeFlag(NOTIF_OPEN_KEY, next);
  };

  const renderDesktopLink = (key: "users" | "account") => {
    const { label, icon: Icon } = VIEWS[key];
    const active = view === key;
    return (
      <a
        key={key}
        href={`#${key}`}
        aria-current={active ? "page" : undefined}
        aria-label={railCollapsed ? label : undefined}
        title={railCollapsed ? label : undefined}
        className={cn(
          "group flex h-8 items-center rounded-md text-[13px] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
          railCollapsed ? "size-8 justify-center" : "gap-2 px-2.5",
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
        {!railCollapsed && <span className="truncate">{label}</span>}
      </a>
    );
  };

  const renderSubLink = (key: "notifications" | "templates") => {
    const active = view === key;
    return (
      <a
        key={key}
        href={`#${key}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 items-center rounded-md px-2 text-xs transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
      >
        <span className="truncate">{VIEWS[key].label}</span>
      </a>
    );
  };

  return (
    <div
      className={cn(
        "min-h-screen bg-background md:grid md:transition-[grid-template-columns] md:duration-150",
        railCollapsed ? "md:grid-cols-[52px_minmax(0,1fr)]" : "md:grid-cols-[224px_minmax(0,1fr)]",
      )}
    >
      <aside className="flex flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div
          className={cn(
            "flex h-12 items-center border-b border-sidebar-border",
            railCollapsed
              ? "justify-between px-3.5 md:justify-center md:px-0"
              : "justify-between gap-2 px-3.5",
          )}
        >
          <a
            href="#users"
            className={cn(
              "text-sm font-semibold tracking-tight text-sidebar-foreground focus-visible:outline-none",
              railCollapsed && "md:hidden",
            )}
          >
            EdgeBase
          </a>
          <button
            type="button"
            onClick={toggleRail}
            aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none md:grid"
          >
            {railCollapsed ? (
              <PanelLeftOpen className="size-3.5" />
            ) : (
              <PanelLeftClose className="size-3.5" />
            )}
          </button>
          <AccountMenu
            me={me}
            side="bottom"
            align="end"
            onSignOut={signOut}
            className="h-7 max-w-[200px] border border-sidebar-border bg-card px-2.5 text-xs md:hidden"
          />
        </div>

        <nav
          className="flex items-center gap-1 overflow-x-auto px-2.5 py-2 md:hidden"
          aria-label="Sections"
        >
          {MOBILE_KEYS.map((key) => {
            const { shortLabel, icon: Icon } = VIEWS[key];
            const active = view === key;
            return (
              <a
                key={key}
                href={`#${key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors duration-100",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", active && "text-primary-ink")} />
                <span>{shortLabel}</span>
              </a>
            );
          })}
        </nav>

        <nav
          className={cn(
            "hidden md:flex md:flex-1 md:flex-col md:gap-0.5 md:py-3",
            railCollapsed ? "md:items-center md:px-1.5" : "md:items-stretch md:px-2.5",
          )}
          aria-label="Sections"
        >
          {renderDesktopLink("users")}

          {railCollapsed ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Notifications"
                  title="Notifications"
                  className={cn(
                    "group grid size-8 place-items-center rounded-md transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent",
                    inNotifications
                      ? "bg-sidebar-accent text-primary-ink"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <Bell className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-44">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  Notifications
                </DropdownMenuLabel>
                <DropdownMenuItem
                  aria-current={view === "notifications" ? "page" : undefined}
                  className={cn(view === "notifications" && "bg-secondary font-medium")}
                  onSelect={() => {
                    location.hash = "#notifications";
                  }}
                >
                  <Bell /> Dispatches
                </DropdownMenuItem>
                <DropdownMenuItem
                  aria-current={view === "templates" ? "page" : undefined}
                  className={cn(view === "templates" && "bg-secondary font-medium")}
                  onSelect={() => {
                    location.hash = "#templates";
                  }}
                >
                  <FileText /> Templates
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex flex-col">
              <button
                type="button"
                aria-expanded={notifOpen}
                onClick={toggleNotif}
                className={cn(
                  "group flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
                  inNotifications && !notifOpen
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : inNotifications
                      ? "font-medium text-sidebar-foreground hover:bg-sidebar-accent/60"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <Bell
                  className={cn(
                    "size-3.5 shrink-0 transition-colors",
                    inNotifications
                      ? "text-primary-ink"
                      : "text-muted-foreground group-hover:text-sidebar-foreground",
                  )}
                />
                <span className="truncate">Notifications</span>
                <ChevronRight
                  className={cn(
                    "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                    notifOpen && "rotate-90",
                  )}
                />
              </button>
              {notifOpen && (
                <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-sidebar-border pl-2.5">
                  {renderSubLink("notifications")}
                  {renderSubLink("templates")}
                </div>
              )}
            </div>
          )}

          <div
            aria-hidden="true"
            className={cn("my-2 h-px bg-sidebar-border", railCollapsed ? "w-6" : "w-full")}
          />
          {renderDesktopLink("account")}
        </nav>

        <div
          className={cn(
            "mt-auto hidden border-t border-sidebar-border p-2 md:flex",
            railCollapsed ? "justify-center" : "block",
          )}
        >
          <AccountMenu
            me={me}
            side={railCollapsed ? "right" : "top"}
            align={railCollapsed ? "end" : "start"}
            collapsed={railCollapsed}
            onSignOut={signOut}
            className={
              railCollapsed ? undefined : "h-9 w-full px-2.5 text-[13px] hover:bg-sidebar-accent"
            }
          />
        </div>
      </aside>

      <main className="mx-auto w-full max-w-[1140px] px-4 py-5 sm:px-8 sm:py-7">
        <Suspense fallback={<Skeleton className="h-44 w-full rounded-md" />}>
          <Page me={me} />
        </Suspense>
      </main>
      <Toaster />
    </div>
  );
}
