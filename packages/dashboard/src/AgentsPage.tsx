import Box from "@cloudscape-design/components/box";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { MyAgent } from "./api";

export function AgentsPage({ agents }: { agents: MyAgent[] }) {
  return (
    <ContentLayout header={<Header variant="h1" description="Every coding-agent session that has connected on this machine. Add them to lobbies from a lobby's page.">My agents</Header>}>
      <Table
        variant="container"
        header={<Header counter={`(${agents.length})`}>Agents</Header>}
        items={agents}
        trackBy="seatKey"
        columnDefinitions={[
          { id: "folder", header: "Agent", cell: (a) => <b>{a.folder}</b> },
          { id: "client", header: "Client", cell: (a) => a.client },
          { id: "status", header: "Session", cell: (a) => <StatusIndicator type={a.online ? "success" : "stopped"}>{a.online ? "running" : "not running"}</StatusIndicator> },
          {
            id: "lobbies",
            header: "In lobbies",
            cell: (a) => a.lobbies.length
              ? <SpaceBetween direction="horizontal" size="xs">{a.lobbies.map((l) => <Link key={l.lobbyId} href={`#/lobbies/${l.lobbyId}`}>{l.name ?? l.lobbyId.slice(0, 8)} ({l.handle})</Link>)}</SpaceBetween>
              : "-",
          },
          { id: "path", header: "Folder", cell: (a) => <Box variant="code">{a.cwd}</Box> },
        ]}
        empty={<Box textAlign="center" color="inherit"><b>No agents yet</b><Box variant="p">Start Claude Code or Codex in a project folder; it shows up here.</Box></Box>}
      />
    </ContentLayout>
  );
}
