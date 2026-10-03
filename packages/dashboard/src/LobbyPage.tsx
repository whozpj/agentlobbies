import { useEffect, useState } from "react";
import { api, isHosted, lobbyName, type Agent, type Lobby, type Me, type Message, type MyAgent } from "./api";
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

/** What an agent is doing, in words: agents report working and waiting through their hooks. */
export const STATUS_LABEL: Record<string, string> = { active: "working", busy: "busy", idle: "waiting for messages", offline: "offline" };

/** A list to pick one running agent from. */
function AgentPicker({ agents, selected, onSelect }: { agents: MyAgent[]; selected: string; onSelect: (key: string) => void }) {
  return (
    <div className="picker" role="radiogroup" aria-label="Agent">
      {agents.map((a) => (
        <button key={agentKey(a)} type="button" role="radio" aria-checked={selected === agentKey(a)}
          className={selected === agentKey(a) ? "picker-row selected" : "picker-row"} onClick={() => onSelect(agentKey(a))}>
          <StatusDot status="active" />
          <span className="picker-text">
            <b>{a.folder}</b>
            <span className="muted">{a.client}{a.machine ? ` · ${a.machine}` : ""}</span>
          </span>
          {a.cwd && <code className="muted picker-path">{a.cwd}</code>}
        </button>
      ))}
    </div>
  );
}

function AddAgentModal({ lobby, agents, onClose }: { lobby: Lobby; agents: MyAgent[]; onClose: () => void }) {
  // Only agents whose sessions are running right now, and that aren't in this lobby yet.
  const available = agents.filter((a) => a.online && !a.lobbies.some((l) => l.lobbyId === lobby.lobbyId));
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
      <div className="field">
        <span>Agent</span>
        {available.length
          ? <AgentPicker agents={available} selected={key} onSelect={setKey} />
          : <div className="muted">
              <p>No running agents to add. Start Claude Code or Codex in a project folder{isHosted ? " on a machine with the app installed:" : "; it shows up here."}</p>
              {isHosted && <InstallSteps />}
            </div>}
      </div>
      <label className="field">
        <span>Owns <i className="muted">optional</i></span>
        <input value={owns} placeholder="api, auth" onChange={(e) => setOwns(e.target.value)} />
        <small className="muted">Areas it answers for, separated by commas, so others can ask it by area (owner:api).</small>
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

function PeopleModal({ lobby, me, onClose }: { lobby: Lobby; me: Me | null; onClose: () => void }) {
  const [error, setError] = useState("");
  const isOwner = lobby.myRole === "host";
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
        {lobby.people.map((p) => {
          const login = p.login;
          const self = login === me?.login;
          return (
            <li key={login}>
              <Avatar url={p.avatarUrl} size={28} />
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

/** Deleting is for everyone and can't be undone; an old lobby without an owner can only be dropped from this machine. */
function DeleteLobbyModal({ lobby, onClose }: { lobby: Lobby; onClose: () => void }) {
  const [error, setError] = useState("");
  const isOwner = lobby.myRole === "host";
  const confirm = async () => {
    try {
      if (isOwner) await api.deleteLobby(lobby.lobbyId);
      else await api.forgetLobby(lobby.lobbyId);
      location.hash = "#/";
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={isOwner ? `Delete ${lobbyName(lobby)}?` : `Remove ${lobbyName(lobby)} from this machine?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger solid" onClick={confirm}>{isOwner ? "Delete lobby" : "Remove"}</button></>}>
      {isOwner
        ? <p>This removes the lobby for everyone in it and erases its messages and keys. It can't be undone.</p>
        : <p>This lobby is from before lobbies had owners, so no one can delete it. Removing it clears it from this machine.</p>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

/** One of your own agents, as your machine knows it: secure mode is kept there. */
function localCopy(agent: Agent, myAgents: MyAgent[]): MyAgent | undefined {
  return myAgents.find((a) => a.lobbies.some((l) => l.agentId === agent.agentId));
}

function EditAgentModal({ lobby, agent, myAgents, onClose }: { lobby: Lobby; agent: Agent; myAgents: MyAgent[]; onClose: () => void }) {
  const mine = localCopy(agent, myAgents);
  const [handle, setHandle] = useState(agent.handle);
  const [owns, setOwns] = useState(agent.owns.join(", "));
  const [secure, setSecure] = useState(mine?.secure ?? false);
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await api.updateAgent(lobby.lobbyId, agent.agentId, { handle, owns: owns.split(",") });
      if (mine && secure !== (mine.secure ?? false)) await api.setSecure(mine, secure);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Edit ${agent.handle}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <label className="field">
        <span>Name</span>
        <input value={handle} onChange={(e) => setHandle(e.target.value)} autoFocus />
        <small className="muted">What other agents call it, e.g. web-ui.</small>
      </label>
      <label className="field">
        <span>Owns</span>
        <input value={owns} placeholder="api, frontend" onChange={(e) => setOwns(e.target.value)} />
        <small className="muted">Areas it answers for, separated by commas. Others can ask it by area (owner:frontend).</small>
      </label>
      {mine && (
        <label className="toggle">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          <span>
            <b>Secure mode</b>
            <small className="muted">
              Every message it writes waits for your approval{isHosted ? " on its machine (agentlobbies dashboard)" : " under Approvals"},
              and messages from other agents don't wake it: it reads them when you next talk to it.
            </small>
          </span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

interface AgentCardProps {
  agent: Agent;
  secure: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
}

function AgentCard({ agent, secure, selected, onSelect, onEdit, onRemove }: AgentCardProps) {
  return (
    <article className={selected ? "agent-card selected" : "agent-card"} onClick={onSelect}>
      <header>
        <StatusDot status={agent.status} />
        <b className="handle">{agent.handle}</b>
        {onEdit && (
          <button className="icon-btn small" aria-label={`Edit ${agent.handle}`} title="Edit name and areas" onClick={(e) => { e.stopPropagation(); onEdit(); }}>✎</button>
        )}
        {onRemove && (
          <button className="icon-btn small" aria-label={`Remove ${agent.handle}`} title="Remove from lobby" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
        )}
      </header>
      <div className="owner-line muted">
        {agent.owner && <span className="owner" data-testid={`owner-${agent.handle}`}><Avatar url={agent.owner.avatarUrl} size={16} />@{agent.owner.login}</span>}
        <span>{agent.client}</span>
      </div>
      {(agent.owns.length > 0 || secure) && (
        <div className="tags">
          {secure && <span className="tag secure" title="Its messages wait for approval"><LockIcon /> secure</span>}
          {agent.owns.map((o) => <span key={o} className="tag">{o}</span>)}
        </div>
      )}
      <p className="working muted">{agent.status !== "offline" && agent.workingOn ? agent.workingOn : STATUS_LABEL[agent.status]}</p>
    </article>
  );
}

export function LobbyPage({ lobby, me, agents: myAgents, onChange }: { lobby: Lobby; me: Me | null; agents: MyAgent[]; onChange: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [dialog, setDialog] = useState<"invite" | "add" | "people" | "delete" | null>(null);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const isOwner = lobby.myRole === "host";
  const canAdd = lobby.myRole === "host" || lobby.myRole === "member";
  const people = lobby.people;
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

  // Messages this browser can't read yet: the key arrives once a member's machine is online to share it.
  useEffect(() => {
    if (!isHosted || !messages.some((m) => m.body === null)) return;
    const timer = setInterval(() => {
      api.messages(lobby.lobbyId).then(setMessages).catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [lobby.lobbyId, messages]);

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
                <span key={p.login} title={`@${p.login} · ${ROLE_LABEL[p.role]}`}><Avatar url={p.avatarUrl} size={26} /></span>
              ))}
            </button>
            {isOwner && <button className="btn" onClick={() => setDialog("invite")}>Invite people</button>}
            {canAdd && <button className="btn primary" onClick={() => setDialog("add")}>Add agent</button>}
            {isOwner && <button className="btn danger" onClick={() => setDialog("delete")}>Delete lobby</button>}
            {!lobby.myRole && !isHosted && <button className="btn danger" onClick={() => setDialog("delete")}>Remove from this machine</button>}
          </div>
        </div>

        <div className="canvas">
          <Topology agents={lobby.roster} latest={messages.at(-1)} selected={selected} onSelect={toggle} />
        </div>

        <div className="dock">
          {agents.map((a) => {
            const mayChange = isOwner || a.owner?.login === me?.login;
            return (
              <AgentCard key={a.agentId} agent={a} secure={localCopy(a, myAgents)?.secure ?? false} selected={selected === a.handle} onSelect={() => toggle(a.handle)}
                onEdit={mayChange ? () => setEditing(a) : undefined}
                onRemove={mayChange ? () => api.removeAgent(lobby.lobbyId, a.agentId).then(onChange) : undefined} />
            );
          })}
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
      {dialog === "delete" && <DeleteLobbyModal lobby={lobby} onClose={close} />}
      {editing && <EditAgentModal lobby={lobby} agent={editing} myAgents={myAgents} onClose={() => { setEditing(null); onChange(); }} />}
    </div>
  );
}
