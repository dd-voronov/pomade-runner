// The form's Folder field: typed, or chosen — the workspace root, a project's folder, or any folder
// through Pomade's folder picker; a folder inside a project fills in the project.

import { useState, type ReactNode } from "react";
import type { ProjectListResult } from "pomade-kit/protocol";
import type { HostClient } from "pomade-kit/sdk";

import type { ProjectRecord } from "../../jobs/model";
import { Button, Field, Menu, MenuHeader, MenuItem, MenuSeparator, TextInput } from "../kit";
import styles from "./JobForm.module.css";
import type { FormField, FormState, FormValues } from "./state";

/** Pomade's projects: as `project.list` answers (groups, then projects in sidebar order), and as the
 *  checks take them. `list` is `null` until Pomade answers. */
export interface ProjectChoices {
  list: ProjectListResult | null;
  records: readonly ProjectRecord[];
}

/** What a section of the form is drawn from, and how it changes the form. */
export interface FormProps {
  host: HostClient;
  state: FormState;
  set<F extends FormField>(field: F, value: FormValues[F]): void;
  setFolder(folder: string): void;
  /** The field's errors as they show now, in the validator's words; `undefined` for none. */
  error(field: FormField): ReactNode;
  projects: ProjectChoices;
  /** The workspace folder's name ("git-base"). */
  workspaceName: string;
}

export function FolderField({ host, state, setFolder, error, projects, workspaceName }: FormProps): React.JSX.Element {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const { folder } = state.values;
  const pickOther = (): void => {
    host.files.pickFolder({ initial: folder.trim() === "." ? "" : folder.trim() }).then(
      ({ path }) => {
        if (path !== null) setFolder(path === "" ? "." : path);
      },
      () => undefined,
    );
  };
  return (
    <Field label="Folder" help="f.folder" error={error("folder")} hint={folder.trim() === "." ? `“.” is the workspace root, ${workspaceName}.` : undefined}>
      {(id) => (
        <div className={styles.pick}>
          <TextInput id={id} mono placeholder="Projects/coda-helper" value={folder} bad={error("folder") !== undefined} data-field="folder" onChange={(event) => setFolder(event.target.value)} />
          <Button className={styles.pickButton} icon="folder" aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => setMenu(event.currentTarget)}>
            Choose…
          </Button>
          {menu !== null && (
            <Menu anchor={menu} label="Choose a folder" onClose={() => setMenu(null)} testId="folder-menu">
              <MenuHeader>Workspace</MenuHeader>
              <MenuItem sub="workspace root" onSelect={() => setFolder(".")}>
                {workspaceName}
              </MenuItem>
              {projects.records.length > 0 && <MenuHeader>Projects</MenuHeader>}
              {projects.records.map((project) => (
                <MenuItem key={project.id} sub={<span className={styles.monoFamily}>{project.root}</span>} onSelect={() => setFolder(project.root)}>
                  {project.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem sub="Pomade's folder picker" onSelect={pickOther}>
                Other folder…
              </MenuItem>
            </Menu>
          )}
        </div>
      )}
    </Field>
  );
}
