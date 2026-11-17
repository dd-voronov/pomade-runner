import { useState } from "react";
import type { HostClient } from "pomade-kit/sdk";

import { APP_ID } from "../app";
import { SETTINGS_SET_METHOD } from "../integrations/runner-api";
import { describeJobError } from "../jobs/format";
import { DEFAULT_SETTINGS, minutesText, parseMinutes, SETTINGS_FIELDS, type SettingsField } from "../scheduler/settings";
import styles from "./Runs.module.css";
import { useAction } from "./useAction";
import { useSettings } from "./useRunnerApi";

const LABELS: Record<SettingsField, string> = {
  "max-low-priority-runs": "Low-priority runs at once",
  "warm-up": "Warm-up after login or wake",
  "long-run-warning": "Long-run warning after",
  "history-days": "Keep history (days)",
};

/** One setting: its value as the file writes it, Save and Default. */
function Field({ host, name, value }: { host: HostClient; name: SettingsField; value: number }): React.JSX.Element {
  const spec = SETTINGS_FIELDS[name];
  const shown = spec.kind === "duration" ? minutesText(value) : String(value);
  const [text, setText] = useState(shown);
  const [base, setBase] = useState(shown);
  const action = useAction();
  if (base !== shown) {
    setBase(shown);
    setText(shown);
  }
  const save = (raw: number | null): void => action.run(() => host.apps.call(APP_ID, SETTINGS_SET_METHOD, { field: name, value: raw }));
  const typed = (): number | null => (spec.kind === "duration" ? parseMinutes(text) : /^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
  const fallback = DEFAULT_SETTINGS[spec.key];
  return (
    <form
      className={styles.field}
      data-testid={`setting-${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        const raw = typed();
        if (raw === null) action.run(() => Promise.reject(new Error(spec.kind === "duration" ? `write a duration, e.g. ${spec.example}` : `write a whole number, e.g. ${spec.example}`)));
        else save(raw);
      }}
    >
      <label className={styles.meta} htmlFor={`setting-${name}-input`}>
        {LABELS[name]} <code className={styles.key}>{name}</code>
      </label>
      <span className={styles.fieldLine}>
        <input id={`setting-${name}-input`} className={styles.input} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className={styles.button}>
          Save
        </button>
        <button type="button" className={styles.button} disabled={value === fallback} onClick={() => save(null)}>
          Default ({spec.kind === "duration" ? minutesText(fallback) : fallback})
        </button>
      </span>
      {action.error !== null && (
        <span className={styles.error} role="alert">
          {action.error}
        </span>
      )}
    </form>
  );
}

/** The workspace settings, as `Apps/pomade-runner/settings.yaml` says them; each one written
 *  field-only. A stand-in until the real Settings view. */
export function SettingsView({ host }: { host: HostClient }): React.JSX.Element {
  const settings = useSettings(host);
  if (settings.status === "loading") return <section data-testid="settings-loading" />;
  if (settings.status !== "ready") {
    return (
      <p className={styles.error} role="alert" data-testid="settings-problem">
        {settings.status === "failed" ? settings.message : "Runner's scheduler is not running."}
      </p>
    );
  }
  const { path, exists, errors } = settings.value;
  return (
    <section className={`${styles.section} ${styles.settings}`} data-testid="settings">
      <p className={styles.note}>
        {path}
        {exists ? "" : " — no file yet: every setting is its default"}
      </p>
      {errors.map((error) => (
        <p key={`${error.line}-${error.field}`} className={styles.error} role="alert" data-testid="settings-error">
          Line {error.line}: {describeJobError(error)}
        </p>
      ))}
      <div className={styles.fields}>
        {(Object.keys(SETTINGS_FIELDS) as SettingsField[]).map((name) => (
          <Field key={name} host={host} name={name} value={settings.value.settings[SETTINGS_FIELDS[name].key]} />
        ))}
      </div>
    </section>
  );
}
