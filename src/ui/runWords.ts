// How far ahead a run is, in words, for the panel: "in 40 min". Pure.

/** How far ahead `at` is: "now", "in 40 min", "in 2 h 5 min", "in 3 days". */
export function aheadWords(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} min`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}
