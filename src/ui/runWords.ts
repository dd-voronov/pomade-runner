// Times of runs in words for the panel and the tab: "in 40 min", "Wed 13:00". Pure; local time.

import { clockTime } from "./serviceWords";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

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

/** A moment as its weekday and time of day: "Wed 13:00". */
export function dayTime(at: number): string {
  return `${WEEKDAYS[new Date(at).getDay()] ?? ""} ${clockTime(at)}`;
}
