export function relativeTime(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "just now";
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    const value = Math.floor(seconds / size);
    if (value) return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
