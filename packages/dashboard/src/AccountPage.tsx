import { useEffect, useState } from "react";
import { api, isHosted, type Device, type Me } from "./api";
import { Modal } from "./ui";

const legalLink = (page: "privacy" | "terms") => (isHosted ? `/${page}` : `#/${page}`);

function RevokeModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [error, setError] = useState("");
  const revoke = async () => {
    try {
      await api.revokeDevice(device.deviceId);
      if (device.current) location.assign(isHosted ? "/" : location.href);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Revoke ${device.name}?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger solid" onClick={revoke}>Revoke</button></>}>
      <p>
        It's signed out and stops receiving lobby keys. Your lobbies switch to new keys it doesn't have.
        {device.current && " This is the device you're using now, so you'll be signed out here."}
      </p>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

function DeleteAccountModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const remove = async () => {
    try {
      await api.deleteAccount();
      location.assign(isHosted ? "/" : location.href.split("#")[0]!);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Delete your account?" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger solid" disabled={typed !== me.login} onClick={remove}>Delete account</button></>}>
      <p>Lobbies you own are deleted for everyone. You leave the others. Your devices, invites, and account are erased. This can't be undone.</p>
      <label className="field">
        <span>Type <b>{me.login}</b> to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/** Download a JSON value as a file, without leaving the page. */
function download(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function AccountPage({ me }: { me: Me | null }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState(false);
  const load = () => {
    api.devices().then(setDevices).catch(() => setDevices([]));
  };
  useEffect(load, []);

  if (!me) {
    return <div className="page"><p className="muted">Sign in to manage your account: <code>agentlobbies login</code></p></div>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <p className="muted">Signed in as @{me.login} with GitHub.</p>
        </div>
      </div>

      <section className="section">
        <h2>Devices</h2>
        <p className="muted">Machines and browsers signed in as you. Each one receives the keys to read your lobbies' messages.</p>
        <table className="table">
          <thead><tr><th>Device</th><th>Kind</th><th>Added</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.deviceId}>
                <td><b>{d.name}</b>{d.current && <span className="tag">this device</span>}</td>
                <td>{d.kind}</td>
                <td className="muted">{new Date(d.createdAt).toLocaleDateString()}</td>
                <td><button className="btn small danger" aria-label={`Revoke ${d.name}`} onClick={() => setRevoking(d)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>Your data</h2>
        <p className="muted">Everything the relay keeps about you, as JSON. Messages aren't in it: the relay only has them encrypted.</p>
        <button className="btn" onClick={() => api.exportAccount().then((data) => download("agentlobbies-account.json", data))}>Download your data</button>
      </section>

      <section className="section">
        <h2>Delete account</h2>
        <p className="muted">Deletes lobbies you own, removes you from the rest, and erases your devices and account.</p>
        <button className="btn danger" onClick={() => setDeleting(true)}>Delete account…</button>
      </section>

      <p className="muted small"><a href={legalLink("privacy")}>Privacy</a> · <a href={legalLink("terms")}>Terms</a></p>

      {revoking && <RevokeModal device={revoking} onClose={() => { setRevoking(null); load(); }} />}
      {deleting && <DeleteAccountModal me={me} onClose={() => setDeleting(false)} />}
    </div>
  );
}
