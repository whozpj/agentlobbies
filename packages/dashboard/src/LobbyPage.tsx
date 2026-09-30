import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useEffect, useState } from "react";
import { api, type Lobby, type Message } from "./api";
import { MessageFeed } from "./MessageFeed";
import { AgentStatus, ConnectionStatus } from "./status";
import { Topology } from "./Topology";

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="awsui-value-large">{value}</Box>
    </div>
  );
}

export function LobbyPage({ lobby }: { lobby: Lobby }) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    setMessages([]);
    api.messages(lobby.lobbyId).then(setMessages).catch(() => {});
    return api.subscribe((activity) => {
      if (activity.type !== "message" || activity.lobbyId !== lobby.lobbyId) return;
      setMessages((current) => (current.some((m) => m.id === activity.message.id) ? current : [...current, activity.message]));
    });
  }, [lobby.lobbyId]);

  const online = lobby.roster.filter((a) => a.status !== "offline").length;
  const answered = new Set(messages.map((m) => m.inReplyTo));
  const openQuestions = messages.filter((m) => m.type === "question" && !answered.has(m.id)).length;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description={<Box variant="code">{lobby.lobbyId}</Box>}>
          {lobby.name ?? lobby.lobbyId.slice(0, 8)}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Overview</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            <Metric label="Agents online" value={`${online} / ${lobby.roster.length}`} />
            <Metric label="Messages" value={messages.length} />
            <Metric label="Open questions" value={openQuestions} />
            <div>
              <Box variant="awsui-key-label">Relay connection</Box>
              <ConnectionStatus state={lobby.connection} />
            </div>
          </ColumnLayout>
        </Container>

        <Container header={<Header variant="h2" description="Messages animate between agents as they're sent.">Live topology</Header>}>
          <Topology agents={lobby.roster} latest={messages.at(-1)} />
        </Container>

        <ColumnLayout columns={2}>
          <Container header={<Header variant="h2" counter={`(${messages.length})`}>Message flow</Header>} fitHeight>
            <MessageFeed messages={messages} />
          </Container>
          <Table
            variant="container"
            header={<Header variant="h2" counter={`(${lobby.roster.length})`}>Agents</Header>}
            items={lobby.roster}
            trackBy="agentId"
            columnDefinitions={[
              { id: "handle", header: "Agent", cell: (a) => <b>{a.handle}</b> },
              {
                id: "owner",
                header: "Owner",
                cell: (a) => a.owner ? (
                  <span className="owner" data-testid={`owner-${a.handle}`}>
                    <img src={a.owner.avatarUrl} alt="" className="owner-avatar" />@{a.owner.login}
                  </span>
                ) : "-",
              },
              { id: "client", header: "Client", cell: (a) => a.client },
              { id: "status", header: "Status", cell: (a) => <AgentStatus status={a.status} /> },
              { id: "owns", header: "Owns", cell: (a) => (a.owns.length ? <SpaceBetween direction="horizontal" size="xxs">{a.owns.map((o) => <Badge key={o}>{o}</Badge>)}</SpaceBetween> : "-") },
              { id: "working", header: "Working on", cell: (a) => a.workingOn || "-" },
            ]}
          />
        </ColumnLayout>
      </SpaceBetween>
    </ContentLayout>
  );
}
