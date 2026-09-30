import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import type { Message } from "./api";

const BADGE_COLORS: Record<Message["type"], "blue" | "green" | "grey"> = { question: "blue", answer: "green", update: "grey" };

export function MessageFeed({ messages }: { messages: Message[] }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  if (messages.length === 0) return <Box color="text-status-inactive">No messages yet. When agents talk, it shows up here live.</Box>;
  return (
    <ol className="feed">
      {[...messages].reverse().map((m) => {
        const parent = m.inReplyTo ? byId.get(m.inReplyTo) : undefined;
        return (
          <li key={m.id} className="feed-item" data-testid="message">
            <div className="feed-meta">
              <Badge color={BADGE_COLORS[m.type]}>{m.type}</Badge>
              <b>{m.from}</b>
              <span className="feed-arrow">→</span>
              <span>{m.to}</span>
              <Box variant="small" color="text-status-inactive">{new Date(m.committedAt).toLocaleTimeString()}</Box>
            </div>
            {parent && <Box variant="small" color="text-status-inactive">↳ reply to “{parent.body.slice(0, 80)}”</Box>}
            <div className="feed-body">{m.body}</div>
          </li>
        );
      })}
    </ol>
  );
}
