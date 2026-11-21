// An agent's message as the result card shows it: its Markdown read for what a short answer uses —
// paragraphs, lists, headings as bold lines, **bold**, *emphasis* and `code` — and drawn as text,
// never as HTML, so nothing in a message can reach the page as markup.

import type { ReactNode } from "react";

import styles from "./RunCard.module.css";

/** One line's inline marks. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const marks = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let at = 0;
  for (const match of text.matchAll(marks)) {
    const mark = match[0];
    const index = match.index;
    if (index > at) parts.push(text.slice(at, index));
    if (mark.startsWith("**")) parts.push(<b key={index}>{mark.slice(2, -2)}</b>);
    else if (mark.startsWith("`")) parts.push(<code key={index}>{mark.slice(1, -1)}</code>);
    else parts.push(<em key={index}>{mark.slice(1, -1)}</em>);
    at = index + mark.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function MessageText({ text, testId }: { text: string; testId?: string }): React.JSX.Element {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className={styles.message} data-testid={testId}>
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (lines.every((line) => BULLET.test(line))) return <ul key={index}>{lines.map((line, n) => <li key={n}>{inline(line.replace(BULLET, ""))}</li>)}</ul>;
        if (lines.every((line) => NUMBERED.test(line))) return <ol key={index}>{lines.map((line, n) => <li key={n}>{inline(line.replace(NUMBERED, ""))}</li>)}</ol>;
        return (
          <p key={index}>
            {lines.map((line, n) => {
              const heading = /^#{1,6}\s+(.*)$/.exec(line);
              return (
                <span key={n}>
                  {heading === null ? inline(line) : <b>{inline(heading[1] ?? "")}</b>}
                  {n < lines.length - 1 && <br />}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
