import { useEffect, useRef, useState } from "react";
import type { Agent, Message } from "./api";

const WIDTH = 820;
const HEIGHT = 300;
const TYPE_COLORS: Record<Message["type"], string> = { question: "#0972d3", answer: "#037f0c", update: "#d97706" };

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

function layout(agents: Agent[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  agents.forEach((agent, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / Math.max(agents.length, 1);
    const spread = agents.length === 1 ? 0 : 1;
    positions.set(agent.handle, { x: WIDTH / 2 + spread * 300 * Math.cos(angle), y: HEIGHT / 2 + spread * 105 * Math.sin(angle) });
  });
  return positions;
}

function recipients(message: Message, agents: Agent[]): string[] {
  if (message.to === "all" || message.to.startsWith("#")) return agents.map((a) => a.handle).filter((h) => h !== message.from);
  return [message.to];
}

/** Agents as nodes; each new message animates from sender to recipients, colored by type. */
export function Topology({ agents, latest }: { agents: Agent[]; latest: Message | undefined }) {
  const positions = layout(agents);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [speaking, setSpeaking] = useState<string | undefined>();
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!latest || latest.id === seen.current) return;
    seen.current = latest.id;
    const from = positions.get(latest.from);
    if (!from) return;
    const added = recipients(latest, agents)
      .map((handle) => positions.get(handle))
      .filter((to): to is Point => Boolean(to))
      .map((to, i) => ({ key: `${latest.id}-${i}`, from, to, color: TYPE_COLORS[latest.type] }));
    setPulses((current) => [...current, ...added]);
    setSpeaking(latest.from);
    const timer = setTimeout(() => {
      setPulses((current) => current.filter((p) => !added.includes(p)));
      setSpeaking(undefined);
    }, 1400);
    return () => clearTimeout(timer);
  }, [latest]);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="topology" role="img" aria-label="Lobby topology">
      {agents.flatMap((a, i) =>
        agents.slice(i + 1).map((b) => {
          const p = positions.get(a.handle)!;
          const q = positions.get(b.handle)!;
          return <line key={`${a.handle}-${b.handle}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="topology-edge" />;
        }),
      )}
      {pulses.map((pulse) => (
        <g key={pulse.key}>
          <line x1={pulse.from.x} y1={pulse.from.y} x2={pulse.to.x} y2={pulse.to.y} stroke={pulse.color} className="topology-trail" />
          <circle
            r={7}
            fill={pulse.color}
            className="topology-pulse"
            data-testid="pulse"
            style={{ "--x1": `${pulse.from.x}px`, "--y1": `${pulse.from.y}px`, "--x2": `${pulse.to.x}px`, "--y2": `${pulse.to.y}px` } as React.CSSProperties}
          />
        </g>
      ))}
      {agents.map((agent) => {
        const { x, y } = positions.get(agent.handle)!;
        const offline = agent.status === "offline";
        return (
          <g key={agent.agentId} transform={`translate(${x} ${y})`} className={offline ? "topology-node offline" : "topology-node"} data-testid={`node-${agent.handle}`}>
            {speaking === agent.handle && <circle r={34} className="topology-ring" />}
            <circle r={26} className="topology-node-body" />
            <text className="topology-initials" textAnchor="middle" dy="0.35em">{agent.handle.slice(0, 2).toUpperCase()}</text>
            <circle cx={19} cy={-19} r={6} className={`topology-status ${agent.status}`} />
            <text className="topology-label" textAnchor="middle" y={44}>{agent.handle}</text>
            <text className="topology-sublabel" textAnchor="middle" y={60}>
              {[agent.owner && `@${agent.owner.login}`, agent.client, agent.owns.join(", ")].filter(Boolean).join(" · ")}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
