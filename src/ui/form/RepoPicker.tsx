// The Git form's Repositories field: the workspace's repos, followed live, as a list of checkboxes in
// a box — grouped by top folder (`repoList.ts`), each group with a checkbox for all its repos, a
// filter from 10 repos up, Select all and Clear. The job file names the picked repos in the list's
// order, which is the order a run goes through them. A repo the file names that the workspace lacks
// stays picked, in a group of its own at the bottom, and is said under the box.

import { useId, useState, type ReactNode } from "react";

import { Field, Help, Icon, LinkButton } from "../kit";
import { useRepos } from "../useRunnerApi";
import type { FormProps } from "./FolderField";
import styles from "./RepoPicker.module.css";
import { FILTER_FROM, filterRepos, inListOrder, repoGroups, repoPath, TOP_LEVEL, type RepoRef } from "./repoList";

/** A list's checkbox: a real input, its box drawn over it — checked, `mixed` (some of a group's
 *  repos) or neither; `bad` for a repo the workspace lacks. */
function Box({ checked, mixed = false, bad = false, onChange, labelledBy, describedBy }: { checked: boolean; mixed?: boolean; bad?: boolean; onChange: () => void; labelledBy: string; describedBy: string }): React.JSX.Element {
  return (
    <span className={bad ? `${styles.box} ${styles.boxBad}` : styles.box}>
      <input
        type="checkbox"
        className={styles.input}
        checked={checked}
        ref={(input) => {
          if (input !== null) input.indeterminate = mixed;
        }}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <span className={styles.mark}>
        <Icon name={mixed ? "dash" : "check"} size={10} />
      </span>
    </span>
  );
}

/** One repo's row: its checkbox, its name and its path. */
function RepoRow({ name, path, on, bad = false, onToggle }: { name: string; path: string; on: boolean; bad?: boolean; onToggle: () => void }): React.JSX.Element {
  const id = useId();
  return (
    <label className={[styles.row, on && styles.rowOn, bad && styles.rowBad].filter(Boolean).join(" ")} data-testid="repo-row" data-repo={name}>
      <Box checked={on} bad={bad} onChange={onToggle} labelledBy={`${id}-name`} describedBy={`${id}-path`} />
      <span id={`${id}-name`} className={styles.name} data-tip-cut="" data-testid="repo-name">
        {name}
      </span>
      <span id={`${id}-path`} className={path === "workspace root" || bad ? styles.path : `${styles.path} ${styles.mono}`} data-tip-cut="" data-testid="repo-path">
        {path}
      </span>
    </label>
  );
}

/** A group's head: its checkbox for all its repos shown, its title and "n of m". */
function GroupHead({ title, picked, of, onToggle }: { title: string; picked: number; of: number; onToggle: () => void }): React.JSX.Element {
  const id = useId();
  return (
    <label className={styles.head} data-testid="repo-group">
      <Box checked={picked === of} mixed={picked > 0 && picked < of} onChange={onToggle} labelledBy={`${id}-title`} describedBy={`${id}-count`} />
      <span id={`${id}-title`} className={styles.title} data-testid="repo-group-title">
        {title}
      </span>
      <span id={`${id}-count`} className={styles.count} data-testid="repo-group-count">
        {picked} of {of}
      </span>
    </label>
  );
}

export function RepoPicker({ host, state, set, error }: FormProps): React.JSX.Element {
  const repos = useRepos(host);
  const [query, setQuery] = useState("");
  const chosen = state.values.repos;
  const bad = error("repos") !== undefined;
  const field = (control: ReactNode, hint: ReactNode): React.JSX.Element => (
    <Field label="Repositories" help="f.repos" error={error("repos")} hint={hint}>
      {(id) => (
        <div id={id} className={styles.field} role="group" aria-label="Repositories" data-field="repos" data-testid="repo-picker">
          {control}
        </div>
      )}
    </Field>
  );

  if (repos.status !== "ready") {
    const named = chosen.length > 0 ? ` The job names ${chosen.join(", ")}.` : "";
    return field(
      null,
      repos.status === "loading" ? (
        "Reading the workspace's repos…"
      ) : (
        <span className={styles.problem}>
          Could not read the workspace's repos: {repos.status === "failed" ? repos.message : "Pomade did not answer"}.{named}
        </span>
      ),
    );
  }

  const known: readonly RepoRef[] = repos.value;
  const names = new Set(known.map((repo) => repo.name));
  const picked = new Set(chosen);
  const missing = chosen.filter((name) => !names.has(name));
  const filtering = known.length >= FILTER_FROM && query.trim() !== "";
  const shown = filtering ? filterRepos(known, query) : [...known];
  const shownNames = shown.map((repo) => repo.name);
  const pick = (next: Iterable<string>): void => set("repos", inListOrder(next, known));
  const add = (more: readonly string[]): void => pick([...chosen, ...more]);
  const drop = (less: readonly string[]): void => pick(chosen.filter((name) => !less.includes(name)));
  const toggle = (name: string): void => (picked.has(name) ? drop([name]) : add([name]));
  const allShown = shownNames.every((name) => picked.has(name));
  const noneShown = !shownNames.some((name) => picked.has(name));
  const fileOrder = chosen.join("\n") !== inListOrder(chosen, known).join("\n");

  if (known.length === 0 && missing.length === 0) return field(null, "The workspace has no git repos.");

  const top = (
    <div className={styles.top}>
      <span className={styles.selected} data-testid="repos-count">
        <b>{chosen.length - missing.length}</b> of {known.length} selected
      </span>
      <span className={styles.dot}>·</span>
      <LinkButton className={styles.action} disabled={allShown} onClick={() => add(shownNames)}>
        {filtering ? `Select ${shown.length} shown` : "Select all"}
      </LinkButton>
      <span className={styles.dot}>·</span>
      <LinkButton className={styles.action} disabled={filtering ? noneShown : chosen.length === 0} onClick={() => (filtering ? drop(shownNames) : pick([]))}>
        {filtering ? "Clear shown" : "Clear"}
      </LinkButton>
      {known.length >= FILTER_FROM && (
        <span className={styles.filter}>
          <Icon name="search" size={14} className={styles.lens} />
          <input
            type="search"
            className={styles.filterInput}
            value={query}
            placeholder="Filter by name or path"
            aria-label="Filter repositories"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query !== "" && (
            <button type="button" className={styles.clearFilter} aria-label="Clear the filter" onClick={() => setQuery("")}>
              <Icon name="x" size={10} />
            </button>
          )}
        </span>
      )}
    </div>
  );

  const groups = repoGroups(shown);
  const list = (
    <div className={known.length >= FILTER_FROM ? `${styles.list} ${styles.listFixed}` : styles.list} data-testid="repo-list">
      {groups.map((group) => {
        const groupNames = group.repos.map((repo) => repo.name);
        const on = groupNames.filter((name) => picked.has(name)).length;
        return (
          <div key={group.top} className={styles.group}>
            <GroupHead title={group.top === "" ? TOP_LEVEL : group.top} picked={on} of={groupNames.length} onToggle={() => (on === groupNames.length ? drop(groupNames) : add(groupNames))} />
            {group.repos.map((repo) => (
              <RepoRow key={`${repo.root}/${repo.name}`} name={repo.name} path={repoPath(repo)} on={picked.has(repo.name)} onToggle={() => toggle(repo.name)} />
            ))}
          </div>
        );
      })}
      {filtering && groups.length === 0 && <div className={styles.none}>No repo matches “{query.trim()}”.</div>}
      {!filtering && missing.length > 0 && (
        <div className={styles.group}>
          <div className={`${styles.head} ${styles.headBad}`} data-testid="repo-group">
            <span className={styles.title} data-testid="repo-group-title">
              Not in this workspace
            </span>
          </div>
          {missing.map((name) => (
            <RepoRow key={`missing/${name}`} name={name} path="named in the job file" on bad onToggle={() => drop([name])} />
          ))}
        </div>
      )}
    </div>
  );

  const hint = (
    <>
      {missing.length > 0 && (
        <span className={styles.missing} data-testid="repos-missing">
          <Icon name="warn" size={12} />
          <span>
            <b>{missing.join(", ")}</b> {missing.length === 1 ? "is" : "are"} not in this workspace — clear it, or bring the repo back.
          </span>
        </span>
      )}
      {fileOrder ? (
        <span className={styles.order} data-testid="repos-order">
          <span>Runs one repo at a time, in the job file&rsquo;s order: {chosen.join(", ")}.</span>
          <LinkButton className={styles.action} onClick={() => pick(chosen)}>
            Use this list&rsquo;s order
          </LinkButton>
        </span>
      ) : (
        <span className={styles.order} data-testid="repos-order">
          Runs one repo at a time, top to bottom in this list. <Help k="f.repos.order" />
        </span>
      )}
    </>
  );

  return field(
    <div className={bad ? `${styles.root} ${styles.bad}` : styles.root}>
      {top}
      {list}
    </div>,
    hint,
  );
}
