import { ICONS, type IconName } from "./icons";

/** One icon of the set, `size` px square (16 by default), in the current text colour. Decorative:
 *  the control around it carries the label. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number | undefined; className?: string | undefined }): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      aria-hidden="true"
      // The paths are the set's own constants, never user data.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
