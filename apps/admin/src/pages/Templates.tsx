import { BODY_MAX, TEMPLATE_NAME_PATTERN, TITLE_MAX } from "@edgebase/core/limits";
import { Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FormError } from "@/components/FormError";
import { PageHeader, PushUnconfiguredBanner } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage, type Template } from "@/lib/api";
import { formatDate } from "@/lib/format";

const ANY = "any";
type Editing = { template: Template | null } | null;

function highlightPlaceholders(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\{\{\s*[\w.-]+\s*\}\}/g)) {
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <code
        key={start}
        className="rounded-xs border border-primary/25 bg-accent px-1 py-0.5 font-mono text-[11px] font-medium text-accent-foreground"
      >
        {match[0]}
      </code>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pushUnconfigured, setPushUnconfigured] = useState(false);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api<{ templates: Template[] }>("/v1/templates")).templates);
      setPushUnconfigured(false);
    } catch (e) {
      setTemplates([]);
      if (e instanceof ApiError && e.status === 503) {
        setPushUnconfigured(true);
        return;
      }
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (template: Template) => {
    try {
      await api(`/v1/templates/${encodeURIComponent(template.name)}`, { method: "DELETE" });
      toast.success(`Deleted ${template.name}`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filtered = useMemo(() => {
    if (!templates) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q),
    );
  }, [templates, filter]);

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable push payloads with {{variable}} interpolation and per-locale translations."
      >
        <Button size="sm" onClick={() => setEditing({ template: null })}>
          <Plus /> New template
        </Button>
      </PageHeader>

      {pushUnconfigured && (
        <PushUnconfiguredBanner>
          Push templates require push delivery to be enabled. Configure{" "}
          <code className="font-mono font-medium">FCM_SERVICE_ACCOUNT</code> in Worker secrets to
          create and manage templates.
        </PushUnconfiguredBanner>
      )}

      <div className="overflow-hidden rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by key or copy…"
              aria-label="Filter templates"
              className="h-7 pr-7 pl-8 text-xs"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                aria-label="Clear filter"
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {filtered !== null && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? "template" : "templates"}
            </span>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Key</TableHead>
              <TableHead>Default copy</TableHead>
              <TableHead className="hidden sm:table-cell">Category</TableHead>
              <TableHead className="hidden md:table-cell">Locales</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Updated</TableHead>
              <TableHead className="w-20 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered === null &&
              [1, 2, 3].map((k) => (
                <TableRow key={k}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-7 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {filtered?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-28 text-center text-xs text-muted-foreground">
                  {filter ? (
                    `No template matches "${filter.trim()}".`
                  ) : (
                    <>
                      No templates defined yet.{" "}
                      <button
                        type="button"
                        onClick={() => setEditing({ template: null })}
                        className="font-medium text-primary-ink underline underline-offset-4"
                      >
                        Create your first template
                      </button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            )}
            {filtered?.map((t) => {
              const locales = ["default", ...Object.keys(t.translations ?? {})];
              return (
                <TableRow key={t.name}>
                  <TableCell className="align-top">
                    <code className="rounded-sm border bg-muted/60 px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
                      {t.name}
                    </code>
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal align-top">
                    <div className="grid gap-0.5">
                      <span className="text-[13px] font-medium leading-snug break-words text-foreground">
                        {highlightPlaceholders(t.title)}
                      </span>
                      {t.body && (
                        <span className="line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
                          {highlightPlaceholders(t.body)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top sm:table-cell">
                    {t.category ? (
                      <Badge variant={t.category === "marketing" ? "warning" : "secondary"}>
                        {t.category === "marketing" ? "Marketing" : "Transactional"}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Any</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {locales.map((l) => (
                        <Badge key={l} variant="outline" className="font-mono text-[10px]">
                          {l}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right align-top text-xs tabular-nums text-muted-foreground lg:table-cell">
                    {formatDate(t.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="inline-flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${t.name}`}
                        onClick={() => setEditing({ template: t })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${t.name}`}
                        onClick={() => setDeleting(t)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <TemplateDialog
        editing={editing}
        names={templates?.map((t) => t.name) ?? []}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete template {deleting?.name}?</DialogTitle>
            <DialogDescription>
              Already-scheduled pushes that rendered this template retain their text.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                const target = deleting;
                setDeleting(null);
                remove(target);
              }}
            >
              Delete template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TemplateDialog({
  editing,
  names,
  onClose,
  onSaved,
}: {
  editing: Editing;
  names: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const template = editing?.template ?? null;
  const [category, setCategory] = useState(ANY);
  const [error, setError] = useState("");

  useEffect(() => {
    setCategory(template?.category ?? ANY);
    setError("");
  }, [template]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? template?.name ?? "");
    if (!template && names.includes(name)) {
      setError(`A template named ${name} already exists. Edit it instead.`);
      return;
    }
    const rawTranslations = String(form.get("translations") ?? "").trim();
    let translations: unknown;
    try {
      translations = rawTranslations ? JSON.parse(rawTranslations) : undefined;
    } catch {
      setError('Translations must be valid JSON, e.g. { "vi": { "title": "…", "body": "…" } }.');
      return;
    }
    try {
      await api(`/v1/templates/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: {
          title: form.get("title"),
          body: form.get("body"),
          ...(category !== ANY && { category }),
          ...(translations !== undefined && { translations }),
          // The page has no field for data; keep what the API stored, since PUT replaces it all.
          ...(template?.data && { data: template.data }),
        },
      });
      toast.success(`Saved ${name}`);
      onClose();
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-3.5" onSubmit={save} key={template?.name ?? "new"}>
          <DialogHeader>
            <DialogTitle>{template ? `Edit ${template.name}` : "New template"}</DialogTitle>
            <DialogDescription>
              Insert {"{{name}}"} tokens for runtime values supplied at send time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="t-name">Template key</Label>
            <Input
              id="t-name"
              name="name"
              defaultValue={template?.name}
              disabled={template !== null}
              pattern={TEMPLATE_NAME_PATTERN}
              title="Lowercase letters, digits, dots, dashes and underscores"
              placeholder="order-shipped"
              spellCheck={false}
              className="font-mono"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="t-title">Title</Label>
            <Input
              id="t-title"
              name="title"
              defaultValue={template?.title}
              maxLength={TITLE_MAX}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="t-body">Body</Label>
            <Textarea id="t-body" name="body" defaultValue={template?.body} maxLength={BODY_MAX} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="t-kind">Default category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="t-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Choose when sending</SelectItem>
                <SelectItem value="transactional">Transactional</SelectItem>
                <SelectItem value="marketing">Marketing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="t-translations">Translations (JSON, optional)</Label>
            <Textarea
              id="t-translations"
              name="translations"
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              defaultValue={
                template?.translations ? JSON.stringify(template.translations, null, 2) : ""
              }
              placeholder={'{ "vi": { "title": "Đơn {{order}} đã gửi", "body": "Đang giao" } }'}
            />
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save template</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
