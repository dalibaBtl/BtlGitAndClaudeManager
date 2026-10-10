import { parseUnifiedDiff } from '../../shared/diff.js';
import {
  diffCollapsed,
  diffLoading,
  diffText,
  fullFile,
  loadDiff,
  selectedCommit,
  selectedFile,
} from '../state.js';

/**
 * Right pane: unified diff of the selected file, optionally with the whole
 * file as context. Collapses to a thin strip on the right edge; selecting a
 * file in the repo tree expands it again.
 */
export function DiffView() {
  const file = selectedFile.value;
  const files = parseUnifiedDiff(diffText.value);
  if (diffCollapsed.value) {
    return (
      <section class="pane diff-pane collapsed" title="Show diff">
        <button class="edge" onClick={() => (diffCollapsed.value = false)}>
          «
        </button>
        <span class="edge-label">{file ?? 'Diff'}</span>
      </section>
    );
  }
  return (
    <section class="pane diff-pane">
      <header>
        <button class="edge" title="Hide diff" onClick={() => (diffCollapsed.value = true)}>
          »
        </button>
        <span class="title" title={file ?? ''}>
          {file ?? 'Diff'}
        </span>
        {selectedCommit.value && <span class="meta">@ {selectedCommit.value.slice(0, 8)}</span>}
        <label class="check">
          <input
            type="checkbox"
            checked={fullFile.value}
            onChange={(e) => {
              fullFile.value = (e.target as HTMLInputElement).checked;
              void loadDiff();
            }}
          />
          whole file
        </label>
      </header>
      <div class="diff">
        {!file && <p class="empty">Select a file to see its changes.</p>}
        {file && diffLoading.value && files.length === 0 && <p class="empty">Loading…</p>}
        {file && !diffLoading.value && files.length === 0 && (
          <p class="empty">
            No differences{selectedCommit.value ? ' in this commit' : ' against HEAD'}.
          </p>
        )}
        {files.map((f, i) => (
          <div class="diff-file" key={i}>
            {f.binary && <p class="empty">Binary file.</p>}
            {f.hunks.map((h, j) => (
              <table class="hunk" key={j}>
                <tbody>
                  <tr class="hunk-head">
                    <td class="no" />
                    <td class="no" />
                    <td class="code">{h.header}</td>
                  </tr>
                  {h.lines.map((l, k) => (
                    <tr class={`line ${l.kind}`} key={k}>
                      <td class="no">{l.oldNo ?? ''}</td>
                      <td class="no">{l.newNo ?? ''}</td>
                      <td class="code">
                        <span class="sign">
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
