import { useState } from "react";
import { api, lobbyName, type Lobby } from "./api";
import { Modal, StatusDot } from "./ui";

const ROLE_LABEL: Record<string, string> = { host: "Owner", member: "Member", observer: "Viewer" };

function PromptModal(props: { title: string; label: string; placeholder: string; action: string; onSubmit: (value: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const submit = () => value.trim() && props.onSubmit(value.trim()).then(props.onClose, (e: Error) => setError(e.message));
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={<><button className="btn" onClick={props.onClose}>Cancel</button><button className="btn primary" disabled={!value.trim()} onClick={submit}>{props.action}</button></>}
    >
      <label className="field">
        <span>{props.label}</span>
        <input value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

function LobbyCard({ lobby }: { lobby: Lobby }) {
  const agents = lobby.roster.filter((a) => a.client !== "cli");
  const people = lobby.roster.length - agents.length;
  const online = agents.filter((a) => a.status !== "offline").length;
  return (
    <a className="lobby-card" href={`#/lobbies/${lobby.lobbyId}`}>
      <div className="lobby-card-head">
        <b>{lobbyName(lobby)}</b>
        {lobby.myRole && <span className="tag">{ROLE_LABEL[lobby.myRole]}</span>}
      </div>
      <div className="constellation" aria-hidden="true">
        {agents.map((a) => <StatusDot key={a.agentId} status={a.status} />)}
        {agents.length === 0 && <span className="muted">no agents yet</span>}
      </div>
      <div className="lobby-card-foot muted">
        <span>{online}/{agents.length} agents online · {people} {people === 1 ? "person" : "people"}</span>
        <span><StatusDot status={lobby.connection === "live" ? "active" : "offline"} /> {lobby.connection}</span>
      </div>
    </a>
  );
}

export function LobbiesPage({ lobbies, onChange }: { lobbies: Lobby[]; onChange: () => void }) {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const goTo = (lobbyId: string) => { onChange(); location.hash = `#/lobbies/${lobbyId}`; };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Lobbies</h1>
          <p className="muted">Lobbies you own or were invited to.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setDialog("join")}>Join with invite</button>
          <button className="btn primary" onClick={() => setDialog("create")}>Create lobby</button>
        </div>
      </div>
      {lobbies.length === 0
        ? <div className="empty"><b>No lobbies yet</b><p className="muted">Create one, or join with an invite link.</p></div>
        : <div className="lobby-grid">{lobbies.map((l) => <LobbyCard key={l.lobbyId} lobby={l} />)}</div>}
      {dialog === "create" && (
        <PromptModal title="Create lobby" label="Name" placeholder="food-app" action="Create" onClose={() => setDialog(null)}
          onSubmit={(name) => api.createLobby(name).then((r) => goTo(r.lobbyId))} />
      )}
      {dialog === "join" && (
        <PromptModal title="Join with invite" label="Invite link" placeholder="https://…/invite/…" action="Join" onClose={() => setDialog(null)}
          onSubmit={(link) => api.acceptInvite(link).then((r) => goTo(r.lobbyId))} />
      )}
    </div>
  );
}
