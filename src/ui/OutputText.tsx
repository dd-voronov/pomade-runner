// A line of a run's output in the colours and bold the program printed: each styled span a React
// element with the palette's class, its text drawn as text — never as HTML.

import type { OutputLine, OutputStyle } from "../scheduler/terminal-text";
import styles from "./OutputText.module.css";

/** The classes a span's style draws with; faint text with no colour of its own is dim. */
function classOf(style: OutputStyle): string | undefined {
  const colour = style.colour ?? (style.faint ? "dim" : null);
  const classes = [colour === null ? undefined : styles[colour], style.bold ? styles.bold : undefined].filter((name) => name !== undefined);
  return classes.length === 0 ? undefined : classes.join(" ");
}

/** One line's spans: plain text where the program set no style. */
export function OutputText({ line }: { line: OutputLine }): React.JSX.Element {
  return (
    <>
      {line.map((span, index) => {
        const name = classOf(span.style);
        return name === undefined ? span.text : (
          <span key={index} className={name} data-colour={span.style.colour ?? undefined}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}
