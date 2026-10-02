import { isHosted, type MyAgent } from "./api";
import { InstallSteps, StatusDot } from "./ui";

export function AgentsPage({ agents }: { agents: MyAgent[] }) {
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
              {agents.map((a) => (
                <tr key={`${a.machineId ?? ""}/${a.seatKey}`}>
                  <td><b>{a.folder}</b></td>
                  <td>{a.client}</td>
                  <td>
                    <StatusDot status={a.online ? "active" : "offline"} /> {a.online ? "running" : "not running"}
                    {a.secure && <span className="tag secure">secure</span>}
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
    </div>
  );
}
