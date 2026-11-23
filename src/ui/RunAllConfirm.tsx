import { ConfirmDialog } from "./kit";

/** The confirm before Run all or Run the other N queues more than `RUN_ALL_CONFIRM_ABOVE` runs: it
 *  names the number; its button is the one that opened it ("Run all 25", "Run the other 25"); Cancel
 *  runs nothing. The Needs-you card and the result card open it. */
export function RunAllConfirm({ name, count, action, onConfirm, onCancel }: { name: string; count: number; action: string; onConfirm: () => void; onCancel: () => void }): React.JSX.Element {
  return (
    <ConfirmDialog title={`Run ${count} runs?`} confirm={action} onConfirm={onConfirm} onCancel={onCancel} testId="run-all-confirm">
      <p>
        Runner runs <b>{name}</b> {count} times, one after another, each when the queue lets it. Stopping one of them drops the rest.
      </p>
    </ConfirmDialog>
  );
}
