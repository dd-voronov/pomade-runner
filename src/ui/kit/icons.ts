// The icon set: the prototype's `IC` — 16 px grid, 1.25 stroke, Pomade's stroke language. Each value
// is the inside of a 16×16 `<svg>`, drawn with `currentColor`; `Icon` renders one by name. A new
// icon is added here, in the same language.

export const ICONS = {
  play: '<path d="M5.5 3.8v8.4L12 8z" stroke-linejoin="round"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',
  restart: '<path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.26"/><path d="M11.6 2.3v2.6H9"/>',
  edit: '<path d="M3 13l.6-2.6 7.3-7.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L5.6 12.4z" stroke-linejoin="round"/><path d="M9.8 4.2l2 2"/>',
  file: '<path d="M4.5 2.5H9l2.5 2.5v8a.5.5 0 0 1-.5.5H4.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" stroke-linejoin="round"/><path d="M9 2.5V5h2.5"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.8 6.5l2 1.5-2 1.5M8.2 10h3"/>',
  service: '<path d="M1.8 8.5h2.5l1.7-4 2.4 7.5 1.9-3.5h3.9" stroke-linejoin="round"/>',
  script: '<path d="M3.5 4.5L7 8l-3.5 3.5M8.5 11.5h4" stroke-linejoin="round"/>',
  agent: '<path d="M7.5 2.5l1.3 3.5 3.5 1.3-3.5 1.3-1.3 3.5-1.3-3.5-3.5-1.3 3.5-1.3z" stroke-linejoin="round"/><path d="M12.5 10.8v2.6M11.2 12.1h2.6"/>',
  git: '<circle cx="5" cy="3.8" r="1.5"/><circle cx="5" cy="12.2" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.3v5.4M11 7.5c0 2.2-1.9 2.9-4.6 3.7"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.3"/><circle cx="8" cy="5.3" r=".6" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M6 3.5L10.5 8 6 12.5" stroke-linejoin="round"/>',
  back: '<path d="M9.5 3.5L5 8l4.5 4.5" stroke-linejoin="round"/>',
  collapse: '<path d="M7.5 4L3.5 8l4 4M12.5 4l-4 4 4 4" stroke-linejoin="round"/>',
  expand: '<path d="M8.5 4l4 4-4 4M3.5 4l4 4-4 4" stroke-linejoin="round"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  check: '<path d="M3.5 8.4l3 3 6-6.6" stroke-linejoin="round"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4" stroke-linejoin="round"/>',
  warn: '<path d="M8 2.6l5.8 10.2H2.2z" stroke-linejoin="round"/><path d="M8 6.6v3"/><circle cx="8" cy="11.2" r=".55" fill="currentColor" stroke="none"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.4 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke-linejoin="round"/>',
  dots: '<circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="8" cy="8" r="2.7"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  moon: '<path d="M12.9 9.7A5.4 5.4 0 0 1 6.3 3.1a5.4 5.4 0 1 0 6.6 6.6z" stroke-linejoin="round"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M3.7 12.3l1.2-1.2M11.1 4.9l1.2-1.2"/>',
  runner: '<circle cx="8" cy="8" r="5.6"/><path d="M6.8 5.7v4.6L10.6 8z" stroke-linejoin="round"/>',
  files: '<path d="M5.8 2.2h4.4l2.7 2.7v7.1a.9.9 0 0 1-.9.9H5.8a.9.9 0 0 1-.9-.9V3.1a.9.9 0 0 1 .9-.9z" stroke-linejoin="round"/><path d="M10.2 2.2v2.7h2.7M3.1 4.9v8a.9.9 0 0 0 .9.9h6.2"/>',
  bell: '<path d="M4 11.1V7.6a4 4 0 0 1 8 0v3.5l1.1 1.3H2.9z" stroke-linejoin="round"/><path d="M6.4 13.8a1.7 1.7 0 0 0 3.2 0"/>',
  board: '<rect x="2.5" y="3" width="3" height="10" rx=".8"/><rect x="6.5" y="3" width="3" height="6.5" rx=".8"/><rect x="10.5" y="3" width="3" height="4" rx=".8"/>',
  people: '<circle cx="6" cy="6" r="2.2"/><path d="M2.2 13c.3-2.2 1.8-3.4 3.8-3.4s3.5 1.2 3.8 3.4"/><path d="M10.4 4.2a2.1 2.1 0 0 1 0 3.9M11.8 9.9c1.2.5 1.9 1.5 2.1 3.1"/>',
  trash: '<path d="M2.8 4.5h10.4M6.3 4.5V3a.5.5 0 0 1 .5-.5h2.4a.5.5 0 0 1 .5.5v1.5M4.2 4.5l.6 8.1a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.1M6.8 7v4M9.2 7v4" stroke-linejoin="round"/>',
  ext: '<path d="M6.5 3.5h-3v9h9v-3M9.3 3.5h3.2v3.2M12.5 3.5L7.6 8.4" stroke-linejoin="round"/>',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;
