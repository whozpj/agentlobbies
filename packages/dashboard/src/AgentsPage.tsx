import { useState } from "react";
import { isHosted, type MyAgent } from "./api";
import { InstallSteps, StatusDot } from "./ui";

const PAGE_SIZE = 10;

/** Running agents first, then the rest by when they were last used. */
function byRecentUse(a: MyAgent, b: MyAgent): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
}

/** "5 minutes ago", "3 days ago". */
function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function AgentsPage({ agents }: { agents: MyAgent[] }) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const sorted = [...agents].sort(byRecentUse);
  const hidden = sorted.length - shown;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My agents</h1>
          <p className="muted">
            {isHosted
              ? "Coding-agent sessions on every machine you've signed in on. Add them to a lobby from its page."
              : "Every coding-agent session that has connected on this machine. Add them to a lobby from its page."}
          </p>
        </div>
      </div>
      {agents.length === 0
        ? (
          <div className="empty">
            <b>No agents yet</b>
            <p className="muted">{isHosted ? "Install the app on your machine, then start Claude Code or Codex in a project folder:" : "Start Claude Code or Codex in a project folder; it shows up here."}</p>
            {isHosted && <InstallSteps />}
          </div>
        )
        : (
          <table className="table">
            <thead>
              <tr><th>Agent</th><th>Client</th><th>Session</th><th>In lobbies</th><th>{isHosted ? "Machine" : "Folder"}</th></tr>
            </thead>
            <tbody>
              {sorted.slice(0, shown).map((a) => (
                <tr key={`${a.machineId ?? ""}/${a.seatKey}`}>
                  <td><b>{a.folder}</b></td>
                  <td>{a.client}</td>
                  <td>
                    <StatusDot status={a.online ? "active" : "offline"} /> {a.online ? "running" : "not running"}
                    {!a.online && a.lastUsedAt && <div className="muted small">last used {ago(a.lastUsedAt)}</div>}
                    {a.secure && <span className="tag secure">secure</span>}
                    {a.hooksAllowed === false && (
                      <div className="small warning" data-testid="hooks-warning">
                        Won't answer on its own: in Codex, type <code>/hooks</code> and trust the three agentlobbies hooks.{" "}
                        <a href="#/get-started">How</a>
                      </div>
                    )}
                    {(a.pendingApprovals ?? 0) > 0 && (
                      isHosted
                        ? <div className="muted small">{a.pendingApprovals} waiting for approval: open <code>agentlobbies dashboard</code> on {a.machine}</div>
                        : <div className="small"><a href="#/approvals">{a.pendingApprovals} waiting for approval</a></div>
                    )}
                  </td>
                  <td>
                    {a.lobbies.length
                      ? a.lobbies.map((l) => <a key={l.lobbyId} className="tag link" href={`#/lobbies/${l.lobbyId}`}>{l.name ?? l.lobbyId.slice(0, 8)} · {l.handle}</a>)
                      : <span className="muted">-</span>}
                  </td>
                  <td>{isHosted ? a.machine : <code className="muted">{a.cwd}</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {hidden > 0 && (
        <div className="show-more">
          <button className="btn" onClick={() => setShown(shown + PAGE_SIZE)}>Show {Math.min(hidden, PAGE_SIZE)} more</button>
          <span className="muted small">{hidden} older {hidden === 1 ? "agent" : "agents"} not shown</span>
        </div>
      )}
    </div>
  );
}
