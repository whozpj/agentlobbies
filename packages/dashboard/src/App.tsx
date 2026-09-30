import { applyMode, Mode } from "@cloudscape-design/global-styles";
import AppLayout from "@cloudscape-design/components/app-layout";
import BreadcrumbGroup from "@cloudscape-design/components/breadcrumb-group";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import { useEffect, useState } from "react";
import { api, type JoinRequest, type Lobby } from "./api";
import { ApprovalsPage } from "./ApprovalsPage";
import { LobbiesPage } from "./LobbiesPage";
import { LobbyPage } from "./LobbyPage";

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const [dark, setDark] = useState(() => localStorage.getItem("agentlobbies-dark") === "1");
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [approvals, setApprovals] = useState<JoinRequest[]>([]);

  useEffect(() => {
    applyMode(dark ? Mode.Dark : Mode.Light);
    localStorage.setItem("agentlobbies-dark", dark ? "1" : "0");
  }, [dark]);

  useEffect(() => {
    const refresh = () => {
      api.lobbies().then(setLobbies).catch(() => {});
      api.approvals().then(setApprovals).catch(() => {});
    };
    refresh();
    return api.subscribe((activity) => {
      if (activity.type !== "message") refresh();
    });
  }, []);

  const lobbyId = route.match(/^\/lobbies\/([0-9a-f]{64})$/)?.[1];
  const lobby = lobbies.find((l) => l.lobbyId === lobbyId);
  const lobbyName = (l: Lobby) => l.name ?? l.lobbyId.slice(0, 8);

  const breadcrumbs = [{ text: "Agent Lobbies", href: "#/" }];
  if (lobby) breadcrumbs.push({ text: lobbyName(lobby), href: `#/lobbies/${lobby.lobbyId}` });
  if (route === "/approvals") breadcrumbs.push({ text: "Pending approvals", href: "#/approvals" });

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{ href: "#/", title: "Agent Lobbies" }}
          utilities={[
            { type: "button", text: dark ? "Light mode" : "Dark mode", onClick: () => setDark(!dark) },
            { type: "button", text: "Docs", href: "https://github.com/whozpj/agentlobbies#readme", external: true },
          ]}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        toolsHide
        breadcrumbs={<BreadcrumbGroup items={breadcrumbs} />}
        navigation={
          <SideNavigation
            activeHref={`#${route}`}
            header={{ text: "Agent Lobbies", href: "#/" }}
            items={[
              { type: "link", text: "Lobbies", href: "#/" },
              { type: "link", text: "Pending approvals", href: "#/approvals", info: approvals.length ? <span data-testid="approval-count">{approvals.length}</span> : undefined },
              { type: "divider" },
              ...lobbies.map((l) => ({ type: "link" as const, text: lobbyName(l), href: `#/lobbies/${l.lobbyId}` })),
            ]}
          />
        }
        content={
          lobby ? <LobbyPage lobby={lobby} />
            : route === "/approvals" ? <ApprovalsPage approvals={approvals} onDecided={() => api.approvals().then(setApprovals)} />
            : <LobbiesPage lobbies={lobbies} approvals={approvals.length} />
        }
      />
    </>
  );
}
