import type { PreparedCommit } from '../../shared/types.js';
import { api, socket } from '../api.js';
import { checkedFiles, guard, notify, prepared } from '../state.js';
import { askConfirm, askText } from './Dialogs.jsx';

/**
 * The prepared-commit queue at the top of the working-tree column.
 *
 * Entries come from this UI ("Prepare commit") or from files written into
 * `.bgcm/prepared/` by other tools. "Commit" types the git command into the
 * embedded terminal; nothing is committed behind the user's back.
 */
export function PreparedQueue({ repo }: { repo: string }) {
  const items = prepared.value;
  const picked = checkedFiles.value;

  const prepare = () =>
    guard(async () => {
      const scope = picked.size > 0 ? `${picked.size} selected file(s)` : 'all changes';
      const message = await askText('Prepare commit', `Commit message (${scope})`, {
        multiline: true,
        okLabel: 'Prepare',
      });
      if (!message) return;
      await api
        .post<{ item: PreparedCommit; items: PreparedCommit[] }>('/api/prepared', {
          repo,
          message,
          files: [...picked],
        })
        .then((r) => (prepared.value = r.items));
      checkedFiles.value = new Set();
      notify('info', 'Commit prepared');
    });

  return (
    <div class="queue">
      <div class="queue-head">
        <span>Prepared commits {items.length > 0 && <b>({items.length})</b>}</span>
        <button class="primary" onClick={prepare}>
          Prepare commit{picked.size > 0 ? ` (${picked.size})` : ''}
        </button>
      </div>
      {items.map((it) => (
        <div class="queue-item" key={it.id} title={it.message}>
          <div class="queue-msg">{firstLine(it.message)}</div>
          <div class="queue-meta">
            {it.files.length === 0 ? 'all changes' : `${it.files.length} file(s)`} · {it.createdBy}
          </div>
          <div class="queue-actions">
            <button
              class="primary"
              onClick={() =>
                socket.send({ type: 'term-run', run: { action: 'commit', repo, id: it.id } })
              }
            >
              Commit
            </button>
            <button
              onClick={() =>
                guard(async () => {
                  if (
                    !(await askConfirm('Discard prepared commit', firstLine(it.message), 'Discard'))
                  )
                    return;
                  const r = await api.del<{ items: PreparedCommit[] }>('/api/prepared', {
                    repo,
                    id: it.id,
                  });
                  prepared.value = r.items;
                })
              }
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}
