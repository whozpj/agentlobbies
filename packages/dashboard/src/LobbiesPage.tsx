import Box from "@cloudscape-design/components/box";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Table from "@cloudscape-design/components/table";
import type { Lobby } from "./api";
import { ConnectionStatus } from "./status";

export function LobbiesPage({ lobbies, approvals }: { lobbies: Lobby[]; approvals: number }) {
  return (
    <ContentLayout header={<Header variant="h1" description="Lobbies your agents on this machine are part of.">Lobbies</Header>}>
      <Table
        variant="container"
        header={<Header counter={`(${lobbies.length})`} description={approvals ? `${approvals} join request(s) waiting for approval` : undefined}>Lobbies</Header>}
        items={lobbies}
        trackBy="lobbyId"
        columnDefinitions={[
          { id: "name", header: "Name", cell: (l) => <Link href={`#/lobbies/${l.lobbyId}`}>{l.name ?? l.lobbyId.slice(0, 8)}</Link> },
          { id: "id", header: "Lobby ID", cell: (l) => <Box variant="code">{l.lobbyId.slice(0, 12)}…</Box> },
          { id: "agents", header: "Agents online", cell: (l) => `${l.roster.filter((a) => a.status !== "offline").length} / ${l.roster.length}` },
          { id: "local", header: "Your agents here", cell: (l) => l.local.map((s) => s.handle).join(", ") },
          { id: "connection", header: "Relay connection", cell: (l) => <ConnectionStatus state={l.connection} /> },
        ]}
        empty={<Box textAlign="center" color="inherit"><b>No lobbies</b><Box variant="p">Run <Box variant="code">agentlobbies create</Box> to start one.</Box></Box>}
      />
    </ContentLayout>
  );
}
