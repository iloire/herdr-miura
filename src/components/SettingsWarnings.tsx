import type { SettingsView } from "../app/useSettings";

/// What the settings file got wrong, over the foot of the terminal until
/// dismissed. The window keeps running on defaults for those keys.
export function SettingsWarnings({ view }: { view: SettingsView }) {
  if (!view.warnings.length) return null;
  return (
    <div className="settings-warnings" role="status">
      <div className="settings-warnings-body">
        <strong>Settings</strong>
        <ul>
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        {view.path && <span className="settings-warnings-path">{view.path}</span>}
      </div>
      <button type="button" aria-label="Dismiss" onClick={view.dismiss}>
        ×
      </button>
    </div>
  );
}
