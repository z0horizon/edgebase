/** A form's error line, announced to screen readers; renders nothing without a message. */
export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-sm border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs leading-snug font-medium text-destructive"
    >
      {message}
    </p>
  );
}
