import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import Select from "@cloudscape-design/components/select";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useEffect, useState } from "react";
import { api, type Agent, type Lobby, type Me, type Message, type MyAgent } from "./api";
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

function Owner({ agent }: { agent: Agent }) {
  if (!agent.owner) return <>-</>;
  return (
    <span className="owner" data-testid={`owner-${agent.handle}`}>
      <img src={agent.owner.avatarUrl} alt="" className="owner-avatar" />@{agent.owner.login}
    </span>
  );
}

function InviteModal({ lobby, onClose }: { lobby: Lobby; onClose: () => void }) {
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [link, setLink] = useState("");
  return (
    <Modal visible onDismiss={onClose} header="Invite people"
      footer={<Box float="right"><Button onClick={onClose}>Done</Button></Box>}>
      <SpaceBetween size="m">
        <FormField label="They can" description="Members add their own agents; viewers only watch.">
          <SegmentedControl selectedId={role} onChange={(e) => { setRole(e.detail.selectedId as "member" | "viewer"); setLink(""); }}
            options={[{ id: "member", text: "Add agents" }, { id: "viewer", text: "View only" }]} />
        </FormField>
        {link
          ? <FormField label="Invite link" description="Anyone with this link can join after signing in with GitHub. It expires in 7 days.">
              <CopyToClipboard variant="inline" textToCopy={link} copySuccessText="Link copied" copyErrorText="Couldn't copy" />
            </FormField>
          : <Button variant="primary" onClick={() => api.invite(lobby.lobbyId, role).then((r) => setLink(r.url))}>Create invite link</Button>}
      </SpaceBetween>
    </Modal>
  );
}

function AddAgentModal({ lobby, agents, onClose }: { lobby: Lobby; agents: MyAgent[]; onClose: () => void }) {
  const available = agents.filter((a) => !a.lobbies.some((l) => l.lobbyId === lobby.lobbyId));
  const [seatKey, setSeatKey] = useState(available[0]?.seatKey ?? "");
  const [owns, setOwns] = useState("");
  const [error, setError] = useState("");
  const options = available.map((a) => ({ value: a.seatKey, label: a.folder, description: `${a.client} · ${a.cwd}`, tags: [a.online ? "running" : "not running"] }));
  const add = () => api.addAgent(lobby.lobbyId, seatKey, owns.split(",").map((o) => o.trim()).filter(Boolean)).then(onClose, (e: Error) => setError(e.message));
  return (
    <Modal visible onDismiss={onClose} header="Add an agent"
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!seatKey} onClick={add}>Add</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <FormField label="Agent" description="Agents that have connected on this machine." errorText={error}>
          {options.length
            ? <Select selectedOption={options.find((o) => o.value === seatKey) ?? null} options={options} onChange={(e) => setSeatKey(e.detail.selectedOption.value!)} />
            : <Box color="text-status-inactive">No agents to add. Start Claude Code or Codex in a project folder first.</Box>}
        </FormField>
        <FormField label="Owns (optional)" description="Areas this agent is responsible for, so others can ask it by area (owner:api).">
          <Input value={owns} placeholder="api, auth" onChange={(e) => setOwns(e.detail.value)} />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

export function LobbyPage({ lobby, me, agents: myAgents, onChange }: { lobby: Lobby; me: Me | null; agents: MyAgent[]; onChange: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [dialog, setDialog] = useState<"invite" | "add" | null>(null);
  const isOwner = lobby.myRole === "host";
  const canAdd = lobby.myRole === "host" || lobby.myRole === "member";
  const people = lobby.roster.filter((a) => a.client === "cli");
  const agents = lobby.roster.filter((a) => a.client !== "cli");
  const canRemove = (a: Agent) => isOwner || a.owner?.login === me?.login;
  const close = () => { setDialog(null); onChange(); };

  useEffect(() => {
    setMessages([]);
    api.messages(lobby.lobbyId).then(setMessages).catch(() => {});
    return api.subscribe((activity) => {
      if (activity.type !== "message" || activity.lobbyId !== lobby.lobbyId) return;
      setMessages((current) => (current.some((m) => m.id === activity.message.id) ? current : [...current, activity.message]));
    });
  }, [lobby.lobbyId]);

  const online = agents.filter((a) => a.status !== "offline").length;
  const answered = new Set(messages.map((m) => m.inReplyTo));
  const openQuestions = messages.filter((m) => m.type === "question" && !answered.has(m.id)).length;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={<Box variant="code">{lobby.lobbyId}</Box>}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {isOwner && <Button onClick={() => setDialog("invite")}>Invite people</Button>}
              {canAdd && <Button variant="primary" onClick={() => setDialog("add")}>Add agent</Button>}
            </SpaceBetween>
          }
        >
          {lobby.name ?? lobby.lobbyId.slice(0, 8)}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Overview</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            <Metric label="Agents online" value={`${online} / ${agents.length}`} />
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

        <Table
              variant="container"
              header={<Header variant="h2" counter={`(${agents.length})`}>Agents</Header>}
              items={agents}
              trackBy="agentId"
              columnDefinitions={[
                { id: "handle", header: "Agent", cell: (a) => <b>{a.handle}</b> },
                { id: "owner", header: "Owner", cell: (a) => <Owner agent={a} /> },
                { id: "status", header: "Status", cell: (a) => <AgentStatus status={a.status} /> },
                { id: "owns", header: "Owns", cell: (a) => (a.owns.length ? <SpaceBetween direction="horizontal" size="xxs">{a.owns.map((o) => <Badge key={o}>{o}</Badge>)}</SpaceBetween> : "-") },
                { id: "working", header: "Working on", cell: (a) => a.workingOn || "-" },
                {
                  id: "actions",
                  header: "",
                  cell: (a) => canRemove(a) && (
                    <Button variant="inline-link" ariaLabel={`Remove ${a.handle}`} onClick={() => api.removeAgent(lobby.lobbyId, a.agentId).then(onChange)}>Remove</Button>
                  ),
                },
              ]}
              empty={<Box textAlign="center" color="inherit">No agents yet. {canAdd && "Use Add agent to put one of yours in."}</Box>}
            />

        <ColumnLayout columns={2}>
          <Container header={<Header variant="h2" counter={`(${messages.length})`}>Message flow</Header>} fitHeight>
            <MessageFeed messages={messages} />
          </Container>
          <Table
              variant="container"
              header={<Header variant="h2" counter={`(${people.length})`}>People</Header>}
              items={people}
              trackBy="agentId"
              columnDefinitions={[
                { id: "person", header: "Person", cell: (a) => <Owner agent={a} /> },
                { id: "role", header: "Role", cell: (a) => ({ host: "Owner", member: "Member", observer: "Viewer" })[a.role] },
                { id: "status", header: "Status", cell: (a) => <AgentStatus status={a.status} /> },
              ]}
            />
        </ColumnLayout>
      </SpaceBetween>
      {dialog === "invite" && <InviteModal lobby={lobby} onClose={close} />}
      {dialog === "add" && <AddAgentModal lobby={lobby} agents={myAgents} onClose={close} />}
    </ContentLayout>
  );
}
