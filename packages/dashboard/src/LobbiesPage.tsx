import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import { api, type Lobby } from "./api";
import { ConnectionStatus } from "./status";

const ROLE_LABEL: Record<string, string> = { host: "Owner", member: "Member", observer: "Viewer" };

function PromptModal(props: { title: string; label: string; placeholder: string; action: string; onSubmit: (value: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const submit = () => props.onSubmit(value.trim()).then(props.onClose, (e: Error) => setError(e.message));
  return (
    <Modal
      visible
      onDismiss={props.onClose}
      header={props.title}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button onClick={props.onClose}>Cancel</Button><Button variant="primary" disabled={!value.trim()} onClick={submit}>{props.action}</Button></SpaceBetween></Box>}
    >
      <FormField label={props.label} errorText={error}>
        <Input value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.detail.value)} onKeyDown={(e) => e.detail.key === "Enter" && value.trim() && submit()} autoFocus />
      </FormField>
    </Modal>
  );
}

export function LobbiesPage({ lobbies, onChange }: { lobbies: Lobby[]; onChange: () => void }) {
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);
  const goTo = (lobbyId: string) => { onChange(); location.hash = `#/lobbies/${lobbyId}`; };

  return (
    <ContentLayout header={<Header variant="h1" description="Lobbies you own or were invited to.">Lobbies</Header>}>
      <Table
        variant="container"
        header={
          <Header
            counter={`(${lobbies.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => setDialog("join")}>Join with invite</Button>
                <Button variant="primary" onClick={() => setDialog("create")}>Create lobby</Button>
              </SpaceBetween>
            }
          >
            Lobbies
          </Header>
        }
        items={lobbies}
        trackBy="lobbyId"
        columnDefinitions={[
          { id: "name", header: "Name", cell: (l) => <Link href={`#/lobbies/${l.lobbyId}`}>{l.name ?? l.lobbyId.slice(0, 8)}</Link> },
          { id: "role", header: "Your role", cell: (l) => ROLE_LABEL[l.myRole ?? ""] ?? "-" },
          { id: "agents", header: "Agents online", cell: (l) => { const agents = l.roster.filter((a) => a.client !== "cli"); return `${agents.filter((a) => a.status !== "offline").length} / ${agents.length}`; } },
          { id: "people", header: "People", cell: (l) => l.roster.filter((a) => a.client === "cli").length },
          { id: "connection", header: "Relay connection", cell: (l) => <ConnectionStatus state={l.connection} /> },
        ]}
        empty={<Box textAlign="center" color="inherit"><b>No lobbies yet</b><Box variant="p">Create one, or join with an invite link.</Box></Box>}
      />
      {dialog === "create" && (
        <PromptModal title="Create lobby" label="Name" placeholder="food-app" action="Create" onClose={() => setDialog(null)}
          onSubmit={(name) => api.createLobby(name).then((r) => goTo(r.lobbyId))} />
      )}
      {dialog === "join" && (
        <PromptModal title="Join with invite" label="Invite link" placeholder="https://…/invite/…" action="Join" onClose={() => setDialog(null)}
          onSubmit={(link) => api.acceptInvite(link).then((r) => goTo(r.lobbyId))} />
      )}
    </ContentLayout>
  );
}
