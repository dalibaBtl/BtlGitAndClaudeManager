import { api, socket } from '../api.js';
import { describeUpdate } from '../../shared/update.js';
import { guard, update, updateBuilt } from '../state.js';

/**
 * Bottom line of the Folders pane: the app's own version, always visible so a
 * screenshot says which build it came from. Three states: `version · commit`
 * (plus `local changes` for a development clone, which is never updated),
 * **Update available (n)** with a button that types the update into the
 * terminal like every git command that can prompt, and **New build ready**
 * with **Restart** once a newer bundle is on disk. Clicking the text asks the
 * server to check again.
 */
export function UpdateFooter() {
  const u = update.value;
  if (updateBuilt.value) {
    return (
      <footer class="nav-foot warn">
        <span title="npm run build finished; the running server is still the old one. Restart keeps this window.">
          New build ready
        </span>
        <button class="primary" onClick={() => void guard(() => api.post('/api/restart', {}))}>
          Restart
        </button>
      </footer>
    );
  }
  if (!u) return <footer class="nav-foot" />;
  const canUpdate = u.behind > 0 && u.blocked === null;
  return (
    <footer class={`nav-foot${canUpdate ? ' warn' : ''}`}>
      <span
        title={`${describeUpdate(u)}\nClick to check again`}
        onClick={() => void guard(() => api.post('/api/update/check', {}))}
      >
        {canUpdate
          ? `Update available (${u.behind})`
          : `${u.version} · ${u.commit}${u.blocked === 'dirty' ? ' · local changes' : ''}`}
      </span>
      {canUpdate && (
        <button
          class="primary"
          title={u.subjects.join('\n')}
          onClick={() => socket.send({ type: 'term-run', run: { action: 'app-update' } })}
        >
          Update
        </button>
      )}
    </footer>
  );
}
