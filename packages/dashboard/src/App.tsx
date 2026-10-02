import { useEffect, useState } from "react";
import { AccountPage } from "./AccountPage";
import { ApprovalsPage } from "./ApprovalsPage";
import { AgentsPage } from "./AgentsPage";
import { LegalPage } from "./LegalPage";
import { api, isHosted, lobbyName, type Lobby, type Me, type MyAgent } from "./api";
import { LobbiesPage } from "./LobbiesPage";
import { LobbyPage } from "./LobbyPage";
import { Avatar, Logo } from "./ui";
import { InvitePage, SignInPage } from "./Welcome";

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("agentlobbies-theme") ?? "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("agentlobbies-theme", theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}

export function App() {
  const route = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined while loading
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [agents, setAgents] = useState<MyAgent[]>([]);

  const refresh = () => {
    api.lobbies().then(setLobbies).catch(() => {});
    api.agents().then(setAgents).catch(() => {});
  };

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  useEffect(() => {
    if (me === undefined || (isHosted && me === null)) return;
    refresh();
    return api.subscribe((activity) => {
      if (activity.type !== "message") refresh();
    });
  }, [me]);

  // Pages anyone can read, signed in or not.
  const legal = location.pathname.match(/^\/(privacy|terms)$/)?.[1] ?? route.match(/^\/(privacy|terms)$/)?.[1];
  if (legal) return <LegalPage page={legal as "privacy" | "terms"} />;

  // The hosted dashboard's own pages: invite links, and sign-in.
  const invite = location.pathname.match(/^\/invite\/([\w-]+)$/)?.[1];
  if (isHosted && invite) return me === undefined ? null : <InvitePage invite={invite} me={me} />;
  if (isHosted && me === null) return <SignInPage />;

  const lobbyId = route.match(/^\/lobbies\/([0-9a-f]{64})$/)?.[1];
  const lobby = lobbies.find((l) => l.lobbyId === lobbyId);
  const online = agents.filter((a) => a.online).length;
  let waitingForApproval = 0;
  for (const a of agents) waitingForApproval += a.pendingApprovals ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand"><Logo /><span className="brand-name">agentlobbies</span></a>
        {lobby && (
          <>
            <span className="crumb-sep">/</span>
            <select className="switcher" aria-label="Switch lobby" value={lobby.lobbyId} onChange={(e) => (location.hash = `#/lobbies/${e.target.value}`)}>
              {lobbies.map((l) => <option key={l.lobbyId} value={l.lobbyId}>{lobbyName(l)}</option>)}
            </select>
          </>
        )}
        <nav className="nav">
          <a href="#/" className={!lobby && route === "/" ? "active" : ""}>Lobbies</a>
          <a href="#/agents" className={route === "/agents" ? "active" : ""}>
            My agents <span className="count" data-testid="agent-count">{online}</span>
          </a>
          {!isHosted && (
            <a href="#/approvals" className={route === "/approvals" ? "active" : ""}>
              Approvals {waitingForApproval > 0 && <span className="count waiting-count" data-testid="approval-count">{waitingForApproval}</span>}
            </a>
          )}
          <a href="#/account" className={route === "/account" ? "active" : ""}>Account</a>
        </nav>
        <div className="topbar-right">
          <button className="icon-btn" aria-label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <a className="quiet" href="https://github.com/whozpj/agentlobbies#readme" target="_blank" rel="noreferrer">Docs</a>
          {me
            ? <a className="user" href={`https://github.com/${me.login}`} target="_blank" rel="noreferrer"><Avatar url={me.avatarUrl} size={24} /><span className="user-login">@{me.login}</span></a>
            : <span className="muted">Not signed in · run <code>agentlobbies login</code></span>}
          {isHosted && <button className="link-btn sign-out" onClick={() => api.signOut().then(() => location.assign("/"))}>Sign out</button>}
        </div>
      </header>
      <main className="main">
        {lobby ? <LobbyPage lobby={lobby} me={me ?? null} agents={agents} onChange={refresh} />
          : route === "/agents" ? <AgentsPage agents={agents} />
          : route === "/account" ? <AccountPage me={me ?? null} />
          : route === "/approvals" ? <ApprovalsPage onChange={refresh} />
          : <LobbiesPage lobbies={lobbies} onChange={refresh} />}
      </main>
    </div>
  );
}
