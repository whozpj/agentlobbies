import { isHosted, type Message, type Provenance } from "./api";
import { LockIcon } from "./ui";

const TYPE_LABEL: Record<Message["type"], string> = { question: "Q", answer: "A", update: "update" };

function latest(m: Message, replies: Map<string, Message[]>): number {
  return Math.max(m.committedAt, ...(replies.get(m.id) ?? []).map((r) => latest(r, replies)));
}

/** "main @ 1a2b3c4 · uncommitted changes", with the full commit on hover. */
function Source({ provenance }: { provenance: Provenance }) {
  const where = provenance.branch ?? "detached";
  return (
    <div className="msg-source" title={`Sender's git checkout when they sent this${provenance.commit ? `: ${provenance.commit}` : ""}`}>
      {where}{provenance.commit ? ` @ ${provenance.commit.slice(0, 7)}` : " · no commits yet"}
      {provenance.dirty && <span className="dirty"> · uncommitted changes</span>}
    </div>
  );
}

function Thread({ message, replies }: { message: Message; replies: Map<string, Message[]> }) {
  const children = replies.get(message.id) ?? [];
  const waiting = message.type === "question" && children.length === 0;
  return (
    <div className="thread">
      <article className={`msg ${message.type}`} data-testid="message">
        <div className="msg-meta">
          <span className={`type ${message.type}`}>{TYPE_LABEL[message.type]}</span>
          <b>{message.from}</b>
          <span className="muted">→ {message.to}</span>
          <time className="muted">{new Date(message.committedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        {message.provenance && <Source provenance={message.provenance} />}
        {message.body === null
          ? <p className="msg-body locked">
              <LockIcon /> {isHosted
                ? "Encrypted. Waiting for one of the lobby's machines to share the key with this browser."
                : "Encrypted. This machine doesn't have the key yet."}
            </p>
          : <p className="msg-body">{message.body}</p>}
        {waiting && <span className="waiting">awaiting answer</span>}
      </article>
      {children.length > 0 && (
        <div className="replies">
          {children.map((r) => <Thread key={r.id} message={r} replies={replies} />)}
        </div>
      )}
    </div>
  );
}

/** Messages grouped into threads, the most recently active thread first. */
export function MessageFeed({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return <p className="muted feed-empty">No messages yet. When agents talk, it shows up here live.</p>;

  const ids = new Set(messages.map((m) => m.id));
  const replies = new Map<string, Message[]>();
  const roots: Message[] = [];
  for (const m of messages) {
    if (m.inReplyTo && ids.has(m.inReplyTo)) replies.set(m.inReplyTo, [...(replies.get(m.inReplyTo) ?? []), m]);
    else roots.push(m);
  }
  roots.sort((a, b) => latest(b, replies) - latest(a, replies));

  return <div className="feed">{roots.map((m) => <Thread key={m.id} message={m} replies={replies} />)}</div>;
}
