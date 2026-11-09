import { FileText, Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Template } from "@/lib/api";

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
        className="rounded bg-primary/10 px-1 py-0.5 font-mono text-[11px] font-medium text-primary"
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
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api<{ templates: Template[] }>("/v1/templates")).templates);
    } catch (e) {
      setTemplates([]);
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

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable pushes, with {{name}} where a value changes and a translation per language."
      >
        <Button onClick={() => setEditing({ template: null })}>
          <Plus /> New template
        </Button>
      </PageHeader>

      {templates === null && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((k) => (
            <Skeleton key={k} className="h-44 rounded-xl" />
          ))}
        </div>
      )}

      {templates?.length === 0 && (
        <div className="grid place-items-center gap-3 rounded-xl border border-dashed bg-card p-12 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground">
            <FileText className="size-5" />
          </span>
          <p className="text-sm text-muted-foreground">
            No templates yet. Save the pushes you send often.
          </p>
          <Button variant="outline" onClick={() => setEditing({ template: null })}>
            <Plus /> New template
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {templates?.map((t) => (
          <Card key={t.name} className="gap-4 shadow-xs transition-shadow hover:shadow-md">
            <CardHeader className="pb-0">
              <code className="w-fit rounded bg-secondary px-2 py-0.5 font-mono text-xs font-medium text-secondary-foreground">
                {t.name}
              </code>
              <CardAction>
                {t.category && (
                  <Badge variant={t.category === "marketing" ? "warning" : "secondary"}>
                    {t.category === "marketing" ? "Marketing" : "Transactional"}
                  </Badge>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              <div className="rounded-lg border bg-muted/35 p-3">
                <CardTitle className="text-sm break-words">
                  {highlightPlaceholders(t.title)}
                </CardTitle>
                {t.body && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
                    {highlightPlaceholders(t.body)}
                  </p>
                )}
              </div>
            </CardContent>
            <CardFooter className="mt-auto flex-wrap gap-2 border-t pt-3">
              <div className="mr-auto flex flex-wrap items-center gap-1">
                <Globe className="mr-0.5 size-3.5 text-muted-foreground" />
                {["Default", ...Object.keys(t.translations ?? {})].map((l) => (
                  <Badge key={l} variant="outline">
                    {l}
                  </Badge>
                ))}
              </div>
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
            </CardFooter>
          </Card>
        ))}
      </div>

      <TemplateDialog
        editing={editing}
        names={templates?.map((t) => t.name) ?? []}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Scheduled pushes that used it keep their text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove(deleting)}>
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      setError('Translations must be JSON, for example { "vi": { "title": "…", "body": "…" } }.');
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
        <form className="grid gap-4" onSubmit={save} key={template?.name ?? "new"}>
          <DialogHeader>
            <DialogTitle>{template ? `Edit ${template.name}` : "New template"}</DialogTitle>
            <DialogDescription>
              Write {"{{name}}"} where a value goes; it is filled in when you send.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="t-name">Name</Label>
            <Input
              id="t-name"
              name="name"
              defaultValue={template?.name}
              disabled={template !== null}
              pattern="[a-z0-9_.\-]{1,64}"
              title="Lowercase letters, digits, dots, dashes and underscores"
              placeholder="order-shipped"
              spellCheck={false}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-title">Title</Label>
            <Input
              id="t-title"
              name="title"
              defaultValue={template?.title}
              maxLength={120}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-body">Message</Label>
            <Textarea id="t-body" name="body" defaultValue={template?.body} maxLength={500} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-kind">Kind</Label>
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
          <div className="grid gap-2">
            <Label htmlFor="t-translations">Translations (JSON, optional)</Label>
            <Textarea
              id="t-translations"
              name="translations"
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              defaultValue={
                template?.translations ? JSON.stringify(template.translations, null, 2) : ""
              }
              placeholder={'{ "vi": { "title": "Đơn {{order}} đã gửi", "body": "Đang giao" } }'}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
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
