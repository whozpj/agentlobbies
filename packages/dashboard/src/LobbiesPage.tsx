import { useState } from "react";
import { api, lobbyName, type Lobby, type Me } from "./api";
import { DeleteLobbyModal } from "./LobbyPage";
import { Modal, StatusDot } from "./ui";

const ROLE_LABEL: Record<string, string> = { host: "Owner", member: "Member", observer: "Viewer" };

function PromptModal(props: { title: string; label: string; placeholder: string; action: string; onSubmit: (value: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (!value.trim()) return;
    try {
      await props.onSubmit(value.trim());
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
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

function LobbyCard({ lobby, onDelete }: { lobby: Lobby; onDelete: () => void }) {
  const agents = lobby.roster.filter((a) => a.client !== "cli");
  const people = lobby.people.length;
  const online = agents.filter((a) => a.status !== "offline").length;
  const label = lobby.myRole === "host" ? "Delete" : lobby.myRole ? "Leave" : "Remove";
  return (
    <div className="lobby-card-wrap">
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
      {/* Outside the link, so clicking it never opens the lobby. */}
      <button className="icon-btn card-delete" aria-label={`${label} ${lobbyName(lobby)}`} title={label} onClick={onDelete}>
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" className="trash" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />
    </svg>
  );
}

export function LobbiesPage({ lobbies, me, onChange }: { lobbies: Lobby[]; me: Me | null; onChange: () => void }) {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const [deleting, setDeleting] = useState<Lobby | null>(null);
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
        ? <div className="empty"><b>No lobbies yet</b><p className="muted">Create one, or join with an invite link. New here? Follow the <a href="#/get-started">get started guide</a>.</p></div>
        : <div className="lobby-grid">{lobbies.map((l) => <LobbyCard key={l.lobbyId} lobby={l} onDelete={() => setDeleting(l)} />)}</div>}
      {deleting && <DeleteLobbyModal lobby={deleting} me={me} onClose={() => { setDeleting(null); onChange(); }} />}
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
