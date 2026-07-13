export function StatusBadge({ status }: { status: string }) {
  const label = status.replace("_", " ");
  return <span className={`badge badge-${status}`}>{label}</span>;
}
