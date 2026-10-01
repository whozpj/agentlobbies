import { useEffect, useState } from "react";
import { api, isHosted, lobbyName, peopleIn, type Agent, type Lobby, type Me, type Message, type MyAgent } from "./api";
import { MessageFeed } from "./MessageFeed";
import { Topology } from "./Topology";
import { Avatar, CopyLink, InstallSteps, LockIcon, Modal, StatusDot } from "./ui";

const ROLE_LABEL: Record<string, string> = { host: "Owner", member: "Member", observer: "Viewer" };

function InviteModal({ lobby, onClose }: { lobby: Lobby; onClose: () => void }) {
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const choose = (r: "member" | "viewer") => {
    setRole(r);
    setLink("");
  };
  const createLink = async () => {
    try {
      setLink((await api.invite(lobby.lobbyId, role)).url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
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
        : <button className="btn primary" onClick={createLink}>Create invite link</button>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/** Machine and seat together name an agent; the same folder on two machines is two agents. */
const agentKey = (a: MyAgent) => `${a.machineId ?? "local"}/${a.seatKey}`;

function agentLabel(a: MyAgent): string {
  const where = a.machine ? ` · on ${a.machine}` : "";
  return `${a.folder} · ${a.client}${where}${a.online ? "" : " (not running)"}`;
}

function AddAgentModal({ lobby, agents, onClose }: { lobby: Lobby; agents: MyAgent[]; onClose: () => void }) {
  const available = agents.filter((a) => !a.lobbies.some((l) => l.lobbyId === lobby.lobbyId));
  const [key, setKey] = useState(available[0] ? agentKey(available[0]) : "");
  const [owns, setOwns] = useState("");
  const [error, setError] = useState("");
  const add = async () => {
    const agent = available.find((a) => agentKey(a) === key);
    if (!agent) return;
    const areas = owns.split(",").map((o) => o.trim()).filter(Boolean);
    try {
      await api.addAgent(lobby.lobbyId, agent, areas);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Add an agent" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!key} onClick={add}>Add</button></>}>
      <label className="field">
        <span>Agent</span>
        {available.length
          ? <select value={key} onChange={(e) => setKey(e.target.value)}>
              {available.map((a) => <option key={agentKey(a)} value={agentKey(a)}>{agentLabel(a)}</option>)}
            </select>
          : <div className="muted">
              <p>No agents to add. Start Claude Code or Codex in a project folder{isHosted ? " on a machine with the app installed:" : " first."}</p>
              {isHosted && <InstallSteps />}
            </div>}
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

function PeopleModal({ lobby, me, onClose }: { lobby: Lobby; me: Me | null; onClose: () => void }) {
  const [error, setError] = useState("");
  const isOwner = lobby.myRole === "host";
  const people = peopleIn(lobby);
  const remove = async (login: string) => {
    try {
      await api.removeMember(lobby.lobbyId, login);
      if (login === me?.login) location.hash = "#/";
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="People" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <ul className="people-list">
        {people.map((p) => {
          const login = p.owner!.login;
          const self = login === me?.login;
          return (
            <li key={login}>
              <Avatar url={p.owner!.avatarUrl} size={28} />
              <span>@{login}{self && <span className="muted"> (you)</span>}</span>
              <span className="tag">{ROLE_LABEL[p.role]}</span>
              {isOwner && !self && <button className="btn small" onClick={() => remove(login)}>Remove</button>}
              {!isOwner && self && <button className="btn small" onClick={() => remove(login)}>Leave lobby</button>}
            </li>
          );
        })}
      </ul>
      <p className="muted small">Removing someone also removes their agents and gives the lobby a new encryption key.</p>
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
  const [dialog, setDialog] = useState<"invite" | "add" | "people" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const isOwner = lobby.myRole === "host";
  const canAdd = lobby.myRole === "host" || lobby.myRole === "member";
  const people = peopleIn(lobby);
  const agents = lobby.roster.filter((a) => a.client !== "cli");
  const close = () => { setDialog(null); onChange(); };

  useEffect(() => {
    setMessages([]);
    setSelected(null);
    api.messages(lobby.lobbyId).then(setMessages).catch(() => {});
    return api.subscribe((activity) => {
      if (activity.type === "roster" && isHosted) onChange();
      if (activity.type !== "message" || activity.lobbyId !== lobby.lobbyId) return;
      setMessages((current) => (current.some((m) => m.id === activity.message.id) ? current : [...current, activity.message]));
    }, lobby.lobbyId);
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
            {!isHosted && <span className="stat"><StatusDot status={lobby.connection === "live" ? "active" : "idle"} /> relay {lobby.connection}</span>}
            {lobby.keyEpoch > 0
              ? <span className="stat" title="Only member machines can read messages"><LockIcon /> end-to-end encrypted</span>
              : <span className="stat" title="Created by the first member machine that comes online"><LockIcon /> waiting for a member's machine to make the key</span>}
          </div>
          <div className="actions">
            <button className="people" aria-label={`People (${people.length})`} onClick={() => setDialog("people")}>
              {people.map((p) => (
                <span key={p.agentId} title={`@${p.owner!.login} · ${ROLE_LABEL[p.role]}`}><Avatar url={p.owner!.avatarUrl} size={26} /></span>
              ))}
            </button>
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
      {dialog === "people" && <PeopleModal lobby={lobby} me={me} onClose={close} />}
    </div>
  );
}
