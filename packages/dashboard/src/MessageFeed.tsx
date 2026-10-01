import type { Message } from "./api";

const TYPE_LABEL: Record<Message["type"], string> = { question: "Q", answer: "A", update: "update" };

function latest(m: Message, replies: Map<string, Message[]>): number {
  return Math.max(m.committedAt, ...(replies.get(m.id) ?? []).map((r) => latest(r, replies)));
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
        <p className="msg-body">{message.body}</p>
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
