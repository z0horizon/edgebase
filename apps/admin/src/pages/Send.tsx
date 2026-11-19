import { BODY_MAX, MAX_RECIPIENTS, TITLE_MAX } from "@edgebase/core/limits";
import { cn } from "cn";
import { Check, Plus, Radio, Search, Send, Users, X } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { FormError } from "@/components/FormError";
import { PageHeader, PushUnconfiguredBanner } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  api,
  type Category,
  errorMessage,
  listUsers,
  type Template,
  type Text,
  type User,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import { fillPreview, SEND_RECIPIENTS_KEY } from "@/lib/state";

const NONE = "none";
const SEARCH_LIMIT = 8;
const COLLAPSED_CHIP_LIMIT = 10;

/** `name=value` per line; the first `=` splits, so values may contain `=`. */
function parseVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    if (key) vars[key] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  return vars;
}

export function SendPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [target, setTarget] = useState<"users" | "topic">("users");
  // Maps userId -> display label (email when picked from list, or the raw ID when pasted).
  const [recipients, setRecipients] = useState<Record<string, string>>(() => {
    const prefill = sessionStorage.getItem(SEND_RECIPIENTS_KEY);
    if (!prefill) return {};
    sessionStorage.removeItem(SEND_RECIPIENTS_KEY);
    try {
      const parsed = JSON.parse(prefill) as Record<string, string>;
      return Object.fromEntries(Object.entries(parsed).slice(0, MAX_RECIPIENTS));
    } catch {
      return {};
    }
  });
  const [showAllChips, setShowAllChips] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [directory, setDirectory] = useState<{ users: User[]; total: number } | null>(null);
  const latestDirectory = useRef(0);
  const [topic, setTopic] = useState("all");
  const [templateName, setTemplateName] = useState(NONE);
  const [text, setText] = useState<Text>({ title: "", body: "" });
  const [vars, setVars] = useState("");
  const [category, setCategory] = useState<Category>("transactional");
  const [inbox, setInbox] = useState(true);
  const [sendAt, setSendAt] = useState("");
  const [locale, setLocale] = useState("");
  const [error, setError] = useState("");
  const [pushUnconfigured, setPushUnconfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per message, so a retry after a timeout is not sent twice; a new message gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api<{ templates: Template[] }>("/v1/templates")
      .then((r) => {
        setTemplates(r.templates);
        setPushUnconfigured(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 503) {
          setPushUnconfigured(true);
          return;
        }
        toast.error(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    const q = userQuery.trim();
    if (target !== "users" || q.length < 2) {
      setDirectory(null);
      return;
    }
    const req = ++latestDirectory.current;
    const timer = setTimeout(() => {
      listUsers({ limit: SEARCH_LIMIT, email: q })
        .then((res) => {
          if (req === latestDirectory.current) setDirectory(res);
        })
        .catch(() => {
          if (req === latestDirectory.current) setDirectory({ users: [], total: 0 });
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [target, userQuery]);

  const recipientIds = Object.keys(recipients);
  const visibleChipIds = showAllChips ? recipientIds : recipientIds.slice(0, COLLAPSED_CHIP_LIMIT);
  const hiddenChipCount = recipientIds.length - visibleChipIds.length;

  const addRawIds = (raw: string) => {
    const tokens = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = { ...recipients };
    let capped = false;
    let unresolvedEmail: string | null = null;
    for (const token of tokens) {
      const matched = directory?.users.find(
        (u) => u.id === token || u.email.toLowerCase() === token.toLowerCase(),
      );
      const id = matched ? matched.id : token;
      if (!matched && token.includes("@")) {
        unresolvedEmail = token;
        continue;
      }
      if (!(id in next) && Object.keys(next).length >= MAX_RECIPIENTS) {
        capped = true;
        break;
      }
      next[id] = matched ? matched.email : (recipients[id] ?? id);
    }
    if (capped) {
      toast.error(
        `Capped at ${MAX_RECIPIENTS} users per push. Use a topic to broadcast to everyone.`,
      );
    }
    if (unresolvedEmail) {
      setError(
        `Select a matching user from the dropdown for "${unresolvedEmail}", or paste user IDs.`,
      );
      return;
    }
    setRecipients(next);
    setUserQuery("");
    setError("");
  };

  const toggleUser = (u: User) => {
    if (u.id in recipients) {
      const { [u.id]: _, ...rest } = recipients;
      setRecipients(rest);
      setError("");
      return;
    }
    if (recipientIds.length >= MAX_RECIPIENTS) {
      toast.error(`A single push accepts at most ${MAX_RECIPIENTS} users.`);
      return;
    }
    setRecipients({ ...recipients, [u.id]: u.email });
    setError("");
  };

  const removeRecipient = (id: string) => {
    setRecipients((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  const onRecipientKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && userQuery.trim()) {
      event.preventDefault();
      addRawIds(userQuery);
    } else if (event.key === "Backspace" && !userQuery && recipientIds.length > 0) {
      if (!showAllChips && hiddenChipCount > 0) {
        setShowAllChips(true);
        return;
      }
      const lastId = recipientIds[recipientIds.length - 1];
      if (lastId) removeRecipient(lastId);
    }
  };

  const onRecipientPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (/[\s,]/.test(pasted.trim())) {
      event.preventDefault();
      addRawIds(pasted);
    }
  };

  const template = templates.find((t) => t.name === templateName);

  // What each language will show; "" is the default text.
  const preview = useMemo(() => {
    const values = parseVars(vars);
    const base = template ?? { ...text, translations: {} };
    const texts: Record<string, Text> = { "": base, ...base.translations };
    return Object.fromEntries(
      Object.entries(texts).map(([key, t]) => [
        key,
        { title: fillPreview(t.title, values), body: fillPreview(t.body, values) },
      ]),
    );
  }, [template, text, vars]);
  const shown = preview[locale] ?? preview[""] ?? { title: "", body: "" };

  const chooseTemplate = (name: string) => {
    setTemplateName(name);
    setLocale("");
    const chosen = templates.find((t) => t.name === name);
    if (chosen?.category) setCategory(chosen.category);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (target === "users") {
      if (userQuery.trim()) {
        setError("Select a matching user from the dropdown or click 'Add ID' before sending.");
        return;
      }
      if (recipientIds.length === 0) {
        setError("Select at least one user or paste a user ID.");
        return;
      }
      if (recipientIds.length > MAX_RECIPIENTS) {
        setError(`A single push supports at most ${MAX_RECIPIENTS} users.`);
        return;
      }
    }
    setBusy(true);
    try {
      const result = await api<{ id: number; users?: number; scheduled?: boolean }>("/v1/push", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: {
          to: target === "users" ? { userIds: recipientIds } : { topic: topic.trim() },
          category,
          inbox,
          ...(template ? { template: template.name, vars: parseVars(vars) } : text),
          ...(sendAt && { sendAt: new Date(sendAt).toISOString() }),
        },
      });
      toast.success(
        result.scheduled
          ? `Push #${result.id} scheduled`
          : target === "topic"
            ? `Push #${result.id} sent to topic ${topic.trim()}`
            : `Push #${result.id} sent to ${result.users} ${result.users === 1 ? "user" : "users"}`,
      );
      setIdempotencyKey(crypto.randomUUID());
      location.hash = "#pushes";
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Send push"
        description="Dispatch an immediate or scheduled FCM notification to selected accounts or a broadcast topic."
      />

      {pushUnconfigured && (
        <PushUnconfiguredBanner>
          FCM push delivery is not configured on this environment. Set{" "}
          <code className="font-mono font-medium">FCM_SERVICE_ACCOUNT</code> in Worker secrets to
          dispatch live notifications.
        </PushUnconfiguredBanner>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_348px]">
        <form className="divide-y overflow-hidden rounded-md border bg-card" onSubmit={submit}>
          <section className="grid gap-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-0.5">
                <h2 className="text-[13px] font-semibold text-foreground">Audience</h2>
                <p className="text-xs text-muted-foreground">
                  {target === "users"
                    ? `Target up to ${MAX_RECIPIENTS} specific accounts.`
                    : "Broadcast to every device subscribed to a topic."}
                </p>
              </div>
              <fieldset
                aria-label="Send target"
                className="inline-flex gap-0.5 rounded-md border bg-background p-0.5 dark:bg-background/80"
              >
                <label
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                    target === "users"
                      ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary dark:ring-input"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name="send-target"
                    value="users"
                    checked={target === "users"}
                    onChange={() => setTarget("users")}
                    className="sr-only"
                  />
                  <Users className="size-3.5" /> Selected users
                </label>
                <label
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                    target === "topic"
                      ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary dark:ring-input"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name="send-target"
                    value="topic"
                    checked={target === "topic"}
                    onChange={() => setTarget("topic")}
                    className="sr-only"
                  />
                  <Radio className="size-3.5" /> Broadcast topic
                </label>
              </fieldset>
            </div>

            {target === "users" ? (
              <div className="overflow-hidden rounded-md border border-input bg-background/40">
                <div className="relative flex items-center px-2.5">
                  <Search className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    type="text"
                    aria-label="User IDs"
                    placeholder={`Search by email (2+ chars), or paste up to ${MAX_RECIPIENTS} user IDs…`}
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    onKeyDown={onRecipientKeyDown}
                    onPaste={onRecipientPaste}
                    spellCheck={false}
                    className="h-8 w-full bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground"
                  />
                  {userQuery.trim() && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => addRawIds(userQuery)}
                    >
                      <Plus /> Add ID
                    </Button>
                  )}
                </div>

                {userQuery.trim().length >= 2 && (
                  <div
                    className="max-h-48 divide-y overflow-y-auto border-t bg-card"
                    role="listbox"
                    aria-label="Matching users"
                    aria-multiselectable="true"
                  >
                    {directory === null && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">Searching users…</p>
                    )}
                    {directory && directory.users.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No email matches &ldquo;{userQuery.trim()}&rdquo;. Press Enter to add as a
                        raw user ID.
                      </p>
                    )}
                    {directory?.users.map((u) => {
                      const selected = u.id in recipients;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => toggleUser(u)}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60",
                            selected && "bg-accent/50",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "grid size-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input bg-card",
                            )}
                          >
                            {selected && <Check className="size-2.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="truncate font-medium text-foreground">{u.email}</span>
                            {u.name && (
                              <span className="ml-2 truncate text-muted-foreground">{u.name}</span>
                            )}
                          </div>
                          <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {u.id.slice(0, 8)}…
                          </code>
                        </button>
                      );
                    })}
                    {directory && directory.total > directory.users.length && (
                      <p className="bg-muted/40 px-3 py-1.5 text-[11px] tabular-nums text-muted-foreground">
                        Showing top {directory.users.length} of {directory.total} matches.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-2 border-t bg-muted/30 px-2.5 py-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="tabular-nums text-muted-foreground">
                      <strong className="font-medium text-foreground">{recipientIds.length}</strong>{" "}
                      / {MAX_RECIPIENTS} recipients
                    </span>
                    {recipientIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setRecipients({})}
                        className="font-medium text-muted-foreground hover:text-destructive"
                      >
                        Clear all
                      </button>
                    ) : (
                      <span className="text-muted-foreground">
                        Exceeds {MAX_RECIPIENTS}? Switch to Broadcast topic.
                      </span>
                    )}
                  </div>

                  {recipientIds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {visibleChipIds.map((id) => {
                        const label = recipients[id] ?? id;
                        const isEmail = label.includes("@");
                        return (
                          <span
                            key={id}
                            className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-card py-0.5 pr-1 pl-2 text-xs text-foreground"
                          >
                            <span
                              className={cn("truncate", !isEmail && "font-mono text-[11px]")}
                              title={id}
                            >
                              {label}
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove ${label}`}
                              onClick={() => removeRecipient(id)}
                              className="grid size-4 shrink-0 place-items-center rounded-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        );
                      })}
                      {hiddenChipCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowAllChips(true)}
                          className="rounded-sm border bg-card px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground hover:text-foreground"
                        >
                          +{hiddenChipCount} more
                        </button>
                      )}
                      {showAllChips && recipientIds.length > COLLAPSED_CHIP_LIMIT && (
                        <button
                          type="button"
                          onClick={() => setShowAllChips(false)}
                          className="rounded-sm border bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          Collapse
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    aria-label="Topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    spellCheck={false}
                    placeholder="all"
                    className="flex-1 font-mono"
                    required
                  />
                  {(["all", "promotions"] as const).map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      size="sm"
                      variant={topic.trim() === preset ? "default" : "outline"}
                      className="font-mono"
                      onClick={() => setTopic(preset)}
                    >
                      #{preset}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Dispatches to all FCM tokens subscribed to{" "}
                  <code className="rounded-xs border bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {topic.trim() || "all"}
                  </code>
                  .
                </p>
              </div>
            )}
          </section>

          <section className="grid gap-3.5 px-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="template">Payload source</Label>
              <Select value={templateName} onValueChange={chooseTemplate}>
                <SelectTrigger id="template" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Inline copy (write message below)</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {template ? (
              <div className="grid gap-1.5">
                <Label htmlFor="vars">Template variables</Label>
                <Textarea
                  id="vars"
                  placeholder={"order=1042\neta=tomorrow"}
                  value={vars}
                  onChange={(e) => setVars(e.target.value)}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  One <code className="font-mono text-foreground">name=value</code> pair per line
                  for each <code className="font-mono text-foreground">{"{{name}}"}</code> token.
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="title">Title</Label>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {text.title.length}/{TITLE_MAX}
                    </span>
                  </div>
                  <Input
                    id="title"
                    maxLength={TITLE_MAX}
                    placeholder="Order #1042 shipped"
                    value={text.title}
                    onChange={(e) => setText({ ...text, title: e.target.value })}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="body">Body</Label>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {text.body.length}/{BODY_MAX}
                    </span>
                  </div>
                  <Textarea
                    id="body"
                    maxLength={BODY_MAX}
                    placeholder="Your package has been handed to the carrier."
                    value={text.body}
                    onChange={(e) => setText({ ...text, body: e.target.value })}
                  />
                </div>
              </>
            )}
          </section>

          <section className="grid gap-4 px-4 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <span className="text-xs leading-none font-medium text-foreground">Category</span>
                <fieldset
                  aria-label="Notification category"
                  className="grid grid-cols-2 gap-0.5 rounded-md border bg-background p-0.5 dark:bg-background/80"
                >
                  <label
                    className={cn(
                      "cursor-pointer rounded-sm px-2.5 py-1 text-center text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                      category === "transactional"
                        ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary dark:ring-input"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="push-category"
                      value="transactional"
                      checked={category === "transactional"}
                      onChange={() => setCategory("transactional")}
                      className="sr-only"
                    />
                    Transactional
                  </label>
                  <label
                    className={cn(
                      "cursor-pointer rounded-sm px-2.5 py-1 text-center text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                      category === "marketing"
                        ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary dark:ring-input"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="push-category"
                      value="marketing"
                      checked={category === "marketing"}
                      onChange={() => setCategory("marketing")}
                      className="sr-only"
                    />
                    Marketing
                  </label>
                </fieldset>
                <p className="text-[11px] text-muted-foreground">
                  {category === "marketing"
                    ? "Delivered only to users who opted in to marketing."
                    : "Account, order, or security updates."}
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="sendAt">Schedule (optional)</Label>
                <Input
                  id="sendAt"
                  type="datetime-local"
                  value={sendAt}
                  onChange={(e) => setSendAt(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Leave empty to enqueue immediately.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 border-t pt-3.5">
              <Checkbox
                id="inbox-toggle"
                checked={inbox}
                onCheckedChange={(v) => setInbox(v === true)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5 leading-snug">
                <Label htmlFor="inbox-toggle" className="cursor-pointer">
                  Persist copy to in-app D1 inbox
                </Label>
                <p className="text-xs text-muted-foreground">
                  Writes a durable inbox entry alongside the FCM push notification.
                </p>
              </div>
            </div>
          </section>

          <div className="grid gap-3 bg-muted/35 px-4 py-3">
            <FormError message={error} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                Idempotency-Key: {idempotencyKey.slice(0, 8)}…
              </span>
              <Button type="submit" disabled={busy}>
                <Send /> {sendAt ? "Schedule push" : "Send push"}
              </Button>
            </div>
          </div>
        </form>

        <aside
          className="divide-y overflow-hidden rounded-md border bg-card lg:sticky lg:top-6"
          aria-label="Preview"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/35 px-3.5 py-2.5">
            <span className="text-xs font-semibold text-foreground">Payload inspector</span>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Language">
              {Object.keys(preview).map((key) => (
                <button
                  key={key || "default"}
                  type="button"
                  role="tab"
                  aria-selected={key === locale}
                  onClick={() => setLocale(key)}
                  className={cn(
                    "rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors",
                    key === locale
                      ? "border-primary/30 bg-accent font-medium text-accent-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {key || "default"}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-muted/25 p-3.5">
            <div className="rounded-md border bg-card p-3 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.08)]">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">EdgeBase</span>
                <span className="ml-auto font-mono text-[10px]">now</span>
              </div>
              <p
                className={cn(
                  "mt-1.5 text-[13px] leading-snug font-semibold break-words text-foreground",
                  !shown.title && "font-normal text-muted-foreground",
                )}
              >
                {shown.title || "Notification title"}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
                {shown.body || "Notification body preview renders here as you type."}
              </p>
            </div>
          </div>

          <dl className="divide-y text-xs">
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <dt className="text-muted-foreground">Target</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {target === "users"
                  ? `${recipientIds.length} ${recipientIds.length === 1 ? "user" : "users"}`
                  : `topic:${topic.trim() || "all"}`}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-mono text-foreground">
                {template ? `template:${template.name}` : "inline"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <dt className="text-muted-foreground">Category</dt>
              <dd>
                <Badge variant={category === "marketing" ? "warning" : "secondary"}>
                  {category === "marketing" ? "Marketing" : "Transactional"}
                </Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <dt className="text-muted-foreground">Persistence</dt>
              <dd className="text-foreground">{inbox ? "FCM + D1 Inbox" : "FCM only"}</dd>
            </div>
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <dt className="text-muted-foreground">Dispatch</dt>
              <dd className="tabular-nums text-foreground">
                {sendAt ? formatDate(sendAt) : "Immediate"}
              </dd>
            </div>
          </dl>

          <p className="bg-muted/20 px-3.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Per-user pushes resolve each recipient&apos;s profile locale before falling back to
            default copy. Topic broadcasts always use default copy.
          </p>
        </aside>
      </div>
    </>
  );
}
