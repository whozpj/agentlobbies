import { useEffect, useState } from "react";
import { AgentsPage } from "./AgentsPage";
import { api, lobbyName, type Lobby, type Me, type MyAgent } from "./api";
import { LobbiesPage } from "./LobbiesPage";
import { LobbyPage } from "./LobbyPage";
import { Avatar, Logo } from "./ui";

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
  const [me, setMe] = useState<Me | null>(null);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [agents, setAgents] = useState<MyAgent[]>([]);

  const refresh = () => {
    api.lobbies().then(setLobbies).catch(() => {});
    api.agents().then(setAgents).catch(() => {});
  };

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    refresh();
    return api.subscribe((activity) => {
      if (activity.type !== "message") refresh();
    });
  }, []);

  const lobbyId = route.match(/^\/lobbies\/([0-9a-f]{64})$/)?.[1];
  const lobby = lobbies.find((l) => l.lobbyId === lobbyId);
  const online = agents.filter((a) => a.online).length;

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
          <a href="#/" className={!lobby && route !== "/agents" ? "active" : ""}>Lobbies</a>
          <a href="#/agents" className={route === "/agents" ? "active" : ""}>
            My agents <span className="count" data-testid="agent-count">{online}</span>
          </a>
        </nav>
        <div className="topbar-right">
          <button className="icon-btn" aria-label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <a className="quiet" href="https://github.com/whozpj/agentlobbies#readme" target="_blank" rel="noreferrer">Docs</a>
          {me
            ? <a className="user" href={`https://github.com/${me.login}`} target="_blank" rel="noreferrer"><Avatar url={me.avatarUrl} size={24} /><span className="user-login">@{me.login}</span></a>
            : <span className="muted">Not signed in · run <code>agentlobbies login</code></span>}
        </div>
      </header>
      <main className="main">
        {lobby ? <LobbyPage lobby={lobby} me={me} agents={agents} onChange={refresh} />
          : route === "/agents" ? <AgentsPage agents={agents} />
          : <LobbiesPage lobbies={lobbies} onChange={refresh} />}
      </main>
    </div>
  );
}
