import { useEffect, useState } from "react";
import { api, lobbyName, type Agent, type Lobby, type Me, type Message, type MyAgent } from "./api";
import { MessageFeed } from "./MessageFeed";
import { Topology } from "./Topology";
import { Avatar, CopyLink, Modal, StatusDot } from "./ui";

const ROLE_LABEL: Record<string, string> = { host: "Owner", member: "Member", observer: "Viewer" };

function InviteModal({ lobby, onClose }: { lobby: Lobby; onClose: () => void }) {
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const choose = (r: "member" | "viewer") => { setRole(r); setLink(""); };
  return (
    <Modal title="Invite people" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="segmented" role="group" aria-label="They can">
        <button aria-pressed={role === "member"} onClick={() => choose("member")}>Add their agents</button>
        <button aria-pressed={role === "viewer"} onClick={() => choose("viewer")}>View only</button>
      </div>
      {link
        ? <>
            <CopyLink text={link} />
            <p className="muted">Anyone with this link can join after signing in with GitHub. It expires in 7 days.</p>
          </>
        : <button className="btn primary" onClick={() => api.invite(lobby.lobbyId, role).then((r) => setLink(r.url), (e: Error) => setError(e.message))}>Create invite link</button>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

function AddAgentModal({ lobby, agents, onClose }: { lobby: Lobby; agents: MyAgent[]; onClose: () => void }) {
  const available = agents.filter((a) => !a.lobbies.some((l) => l.lobbyId === lobby.lobbyId));
  const [seatKey, setSeatKey] = useState(available[0]?.seatKey ?? "");
  const [owns, setOwns] = useState("");
  const [error, setError] = useState("");
  const add = () => api.addAgent(lobby.lobbyId, seatKey, owns.split(",").map((o) => o.trim()).filter(Boolean)).then(onClose, (e: Error) => setError(e.message));
  return (
    <Modal title="Add an agent" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!seatKey} onClick={add}>Add</button></>}>
      <label className="field">
        <span>Agent</span>
        {available.length
          ? <select value={seatKey} onChange={(e) => setSeatKey(e.target.value)}>
              {available.map((a) => <option key={a.seatKey} value={a.seatKey}>{a.folder} · {a.client}{a.online ? "" : " (not running)"}</option>)}
            </select>
          : <p className="muted">No agents to add. Start Claude Code or Codex in a project folder first.</p>}
      </label>
      <label className="field">
        <span>Owns <i className="muted">optional</i></span>
        <input value={owns} placeholder="api, auth" onChange={(e) => setOwns(e.target.value)} />
        <small className="muted">Areas it's responsible for, so others can ask it by area (owner:api).</small>
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

function AgentCard({ agent, selected, onSelect, onRemove }: { agent: Agent; selected: boolean; onSelect: () => void; onRemove?: () => void }) {
  return (
    <article className={selected ? "agent-card selected" : "agent-card"} onClick={onSelect}>
      <header>
        <StatusDot status={agent.status} />
        <b className="handle">{agent.handle}</b>
        {onRemove && (
          <button className="icon-btn small" aria-label={`Remove ${agent.handle}`} title="Remove from lobby" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
        )}
      </header>
      <div className="owner-line muted">
        {agent.owner && <span className="owner" data-testid={`owner-${agent.handle}`}><Avatar url={agent.owner.avatarUrl} size={16} />@{agent.owner.login}</span>}
        <span>{agent.client}</span>
      </div>
      {agent.owns.length > 0 && <div className="tags">{agent.owns.map((o) => <span key={o} className="tag">{o}</span>)}</div>}
      <p className="working muted">{agent.workingOn || agent.status}</p>
    </article>
  );
}

export function LobbyPage({ lobby, me, agents: myAgents, onChange }: { lobby: Lobby; me: Me | null; agents: MyAgent[]; onChange: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [dialog, setDialog] = useState<"invite" | "add" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const isOwner = lobby.myRole === "host";
  const canAdd = lobby.myRole === "host" || lobby.myRole === "member";
  const people = lobby.roster.filter((a) => a.client === "cli");
  const agents = lobby.roster.filter((a) => a.client !== "cli");
  const close = () => { setDialog(null); onChange(); };

  useEffect(() => {
    setMessages([]);
    setSelected(null);
    api.messages(lobby.lobbyId).then(setMessages).catch(() => {});
    return api.subscribe((activity) => {
      if (activity.type !== "message" || activity.lobbyId !== lobby.lobbyId) return;
      setMessages((current) => (current.some((m) => m.id === activity.message.id) ? current : [...current, activity.message]));
    });
  }, [lobby.lobbyId]);

  const online = agents.filter((a) => a.status !== "offline").length;
  const answered = new Set(messages.map((m) => m.inReplyTo));
  const openQuestions = messages.filter((m) => m.type === "question" && !answered.has(m.id)).length;
  const shown = selected ? messages.filter((m) => m.from === selected || m.to === selected) : messages;
  const toggle = (handle: string) => setSelected(selected === handle ? null : handle);

  return (
    <div className="lobby">
      <section className="stage">
        <div className="stage-head">
          <div className="title">
            <h1>{lobbyName(lobby)}</h1>
            <code className="muted" title={lobby.lobbyId}>{lobby.lobbyId.slice(0, 12)}</code>
          </div>
          <div className="stats">
            <span className="stat"><b>{online}/{agents.length}</b> agents online</span>
            <span className="stat"><b>{messages.length}</b> messages</span>
            <span className="stat"><b>{openQuestions}</b> open questions</span>
            <span className="stat"><StatusDot status={lobby.connection === "live" ? "active" : "idle"} /> relay {lobby.connection}</span>
          </div>
          <div className="actions">
            <div className="people" aria-label={`${people.length} people`}>
              {people.map((p) => p.owner && (
                <span key={p.agentId} title={`@${p.owner.login} · ${ROLE_LABEL[p.role]}`}><Avatar url={p.owner.avatarUrl} size={26} /></span>
              ))}
            </div>
            {isOwner && <button className="btn" onClick={() => setDialog("invite")}>Invite people</button>}
            {canAdd && <button className="btn primary" onClick={() => setDialog("add")}>Add agent</button>}
          </div>
        </div>

        <div className="canvas">
          <Topology agents={lobby.roster} latest={messages.at(-1)} selected={selected} onSelect={toggle} />
        </div>

        <div className="dock">
          {agents.map((a) => (
            <AgentCard key={a.agentId} agent={a} selected={selected === a.handle} onSelect={() => toggle(a.handle)}
              onRemove={isOwner || a.owner?.login === me?.login ? () => api.removeAgent(lobby.lobbyId, a.agentId).then(onChange) : undefined} />
          ))}
          {agents.length === 0 && (
            <p className="muted dock-empty">No agents yet. {canAdd ? "Use Add agent to put one of yours in." : "Members add their agents here."}</p>
          )}
        </div>
      </section>

      <aside className="panel">
        <div className="panel-head">
          <h2>Messages</h2>
          {selected && <button className="chip" onClick={() => setSelected(null)}>{selected} ×</button>}
        </div>
        <MessageFeed messages={shown} />
      </aside>

      {dialog === "invite" && <InviteModal lobby={lobby} onClose={close} />}
      {dialog === "add" && <AddAgentModal lobby={lobby} agents={myAgents} onClose={close} />}
    </div>
  );
}
