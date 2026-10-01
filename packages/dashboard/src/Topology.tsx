import { useEffect, useRef, useState } from "react";
import type { Agent, Message } from "./api";

const HEIGHT = 420;

/** Drawing width: half as wide on a phone, so nodes and labels keep a readable size. */
function drawingWidth(): number {
  return window.innerWidth < 600 ? 500 : 900;
}
const TYPE_COLORS: Record<Message["type"], string> = { question: "var(--question)", answer: "var(--answer)", update: "var(--update)" };

interface Point {
  x: number;
  y: number;
}

interface Pulse {
  key: string;
  from: Point;
  to: Point;
  color: string;
}

/** Everyone on an ellipse around the relay, starting on the left. */
function layout(agents: Agent[], hub: Point): Map<string, Point> {
  const positions = new Map<string, Point>();
  agents.forEach((agent, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / agents.length;
    positions.set(agent.handle, { x: hub.x + hub.x * 0.7 * Math.cos(angle), y: hub.y + 140 * Math.sin(angle) });
  });
  return positions;
}

function recipients(message: Message, agents: Agent[]): string[] {
  if (message.to === "all" || message.to.startsWith("#")) return agents.map((a) => a.handle).filter((h) => h !== message.from);
  return [message.to];
}

function Node({ agent, at, speaking, selected, onSelect }: { agent: Agent; at: Point; speaking: boolean; selected: boolean; onSelect: () => void }) {
  const person = agent.client === "cli";
  const sublabel = person ? "person" : [agent.owner && `@${agent.owner.login}`, agent.client].filter(Boolean).join(" · ");
  const classes = ["node", agent.status, person && "person", selected && "selected"].filter(Boolean).join(" ");
  return (
    <g transform={`translate(${at.x} ${at.y})`} className={classes} data-testid={`node-${agent.handle}`} role="button" aria-label={`Show messages for ${agent.handle}`} onClick={onSelect}>
      {speaking && <circle r={30} className="node-ring" />}
      <circle r={person ? 20 : 26} className="node-body" />
      {person && agent.owner
        ? <image href={agent.owner.avatarUrl} x={-18} y={-18} width={36} height={36} clipPath="url(#avatar-clip)" />
        : <text className="node-initials" textAnchor="middle" dy="0.35em">{agent.handle.slice(0, 2).toUpperCase()}</text>}
      {!person && <circle cx={19} cy={-19} r={5} className="node-status" />}
      <text className="node-label" textAnchor="middle" y={person ? 38 : 46}>{agent.handle}</text>
      <text className="node-sublabel" textAnchor="middle" y={person ? 53 : 61}>{sublabel}</text>
    </g>
  );
}

/** Everyone around the lobby's relay; each message travels sender → relay → recipients, colored by type. */
export function Topology({ agents, latest, selected, onSelect }: { agents: Agent[]; latest: Message | undefined; selected: string | null; onSelect: (handle: string) => void }) {
  const width = drawingWidth();
  const hub = { x: width / 2, y: HEIGHT / 2 };
  const positions = layout(agents, hub);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [speaking, setSpeaking] = useState<string | undefined>();
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!latest || latest.id === seen.current) return;
    seen.current = latest.id;
    const from = positions.get(latest.from);
    if (!from) return;
    const added: Pulse[] = [];
    for (const handle of recipients(latest, agents)) {
      const to = positions.get(handle);
      if (to) added.push({ key: `${latest.id}-${handle}`, from, to, color: TYPE_COLORS[latest.type] });
    }
    setPulses((current) => [...current, ...added]);
    setSpeaking(latest.from);
    const timer = setTimeout(() => {
      setPulses((current) => current.filter((p) => !added.includes(p)));
      setSpeaking(undefined);
    }, 1700);
    return () => clearTimeout(timer);
  }, [latest]);

  return (
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="topology" role="img" aria-label="Lobby topology">
      <defs>
        <clipPath id="avatar-clip"><circle r={18} /></clipPath>
      </defs>
      {agents.map((a) => {
        const p = positions.get(a.handle)!;
        return <line key={a.agentId} x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} className="spoke" />;
      })}
      {pulses.map((pulse) => (
        <g key={pulse.key}>
          <polyline points={`${pulse.from.x},${pulse.from.y} ${hub.x},${hub.y} ${pulse.to.x},${pulse.to.y}`} className="trail" style={{ stroke: pulse.color }} />
          <circle
            r={6}
            className="pulse"
            data-testid="pulse"
            style={{ fill: pulse.color, color: pulse.color, "--x1": `${pulse.from.x}px`, "--y1": `${pulse.from.y}px`, "--xc": `${hub.x}px`, "--yc": `${hub.y}px`, "--x2": `${pulse.to.x}px`, "--y2": `${pulse.to.y}px` } as React.CSSProperties}
          />
        </g>
      ))}
      <g transform={`translate(${hub.x} ${hub.y})`} className="hub">
        {pulses.length > 0 && <circle key={seen.current} r={34} className="hub-ring" />}
        <circle r={34} className="hub-body" />
        <path d="M-9 -9 0 -14 9 -9 9 1 0 6 -9 1Z M0 6v8" className="hub-glyph" />
        <text textAnchor="middle" y={56} className="node-sublabel">relay</text>
      </g>
      {agents.map((agent) => (
        <Node key={agent.agentId} agent={agent} at={positions.get(agent.handle)!} speaking={speaking === agent.handle}
          selected={selected === agent.handle} onSelect={() => onSelect(agent.handle)} />
      ))}
    </svg>
  );
}
