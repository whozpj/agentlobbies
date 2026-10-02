import { useEffect, useState } from "react";
import { api, type PendingMessage } from "./api";

function Pending({ message, onDone }: { message: PendingMessage; onDone: () => void }) {
  const [body, setBody] = useState(message.body);
  const [error, setError] = useState("");
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <article className="approval" data-testid="approval">
      <div className="msg-meta">
        <span className={`type ${message.type}`}>{message.type}</span>
        <b>{message.agent}</b>
        <span className="muted">→ {message.to} · in {message.lobbyName ?? message.lobbyId.slice(0, 8)}</span>
        <time className="muted">{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(12, body.split("\n").length + 1)} aria-label="Message text" />
      <div className="actions">
        <button className="btn primary" onClick={() => act(() => api.approve(message.id, body))}>{body === message.body ? "Send" : "Send edited"}</button>
        <button className="btn" onClick={() => act(() => api.discard(message.id))}>Discard</button>
      </div>
      {error && <p className="error">{error}</p>}
    </article>
  );
}

/** Messages from agents in secure mode, waiting for you to send, edit, or discard them. */
export function ApprovalsPage({ onChange }: { onChange: () => void }) {
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const load = () => {
    api.approvals().then(setPending).catch(() => setPending([]));
    onChange();
  };
  useEffect(load, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Agents in secure mode wait for you before anything they write leaves this machine. Edit a message before sending if you like.</p>
        </div>
      </div>
      {pending.length === 0
        ? <div className="empty"><b>Nothing waiting</b><p className="muted">Turn on secure mode for an agent from its Edit dialog in a lobby.</p></div>
        : <div className="approvals">{pending.map((m) => <Pending key={m.id} message={m} onDone={load} />)}</div>}
    </div>
  );
}
