import type { Controller, HostKey } from "../app/controller";

/// Asks before trusting a host ssh has never seen. The fingerprints are the
/// keys the host offered just now; compare them with ones from a source you
/// trust (the host's console, its admin) before approving. Only these keys
/// are written to known_hosts.
export function HostKeyDialog({ controller, hostKey }: { controller: Controller; hostKey: HostKey }) {
  const { host, fingerprints, error } = hostKey;
  return (
    <div className="palette-backdrop" onMouseDown={() => controller.dismissHostKey()}>
      <div
        className="palette host-key"
        role="alertdialog"
        aria-labelledby="host-key-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && controller.dismissHostKey()}
      >
        <h2 id="host-key-title">{host} is new to this Mac</h2>
        <p>
          ssh has no key on record for {host}. Check that these fingerprints match the ones the host itself reports
          (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on it) before you trust it.
        </p>
        {fingerprints === null && !error && <p className="host-key-wait">Fetching {host}'s keys…</p>}
        {fingerprints && (
          <ul className="host-key-list">
            {fingerprints.map((key) => (
              <li key={key.fingerprint}>
                <span className="host-key-type">{key.keyType}</span>
                <code>{key.fingerprint}</code>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="host-key-error">{error}</p>}
        <div className="host-key-actions">
          {/* Cancel takes focus: the dialog can open while someone is typing
              elsewhere, and a stray Enter must never trust a key. */}
          <button autoFocus className="host-key-button" onClick={() => controller.dismissHostKey()}>
            Cancel
          </button>
          <button
            className="host-key-button primary"
            disabled={!fingerprints}
            onClick={() => void controller.trustHostKey()}
          >
            Trust and connect
          </button>
        </div>
      </div>
    </div>
  );
}
