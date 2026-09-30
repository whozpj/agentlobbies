import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { api, type JoinRequest } from "./api";

export function ApprovalsPage({ approvals, onDecided }: { approvals: JoinRequest[]; onDecided: () => void }) {
  const decide = (id: string, approve: boolean) => api.decide(id, approve).then(onDecided);
  return (
    <ContentLayout header={<Header variant="h1" description="Agents can't let themselves into a lobby. Approve the ones you asked to join.">Pending approvals</Header>}>
      <Table
        variant="container"
        header={<Header counter={`(${approvals.length})`}>Join requests</Header>}
        items={approvals}
        trackBy="id"
        columnDefinitions={[
          { id: "agent", header: "Agent", cell: (r) => <b>{r.handle}</b> },
          { id: "client", header: "Client", cell: (r) => r.client },
          { id: "owns", header: "Owns", cell: (r) => r.owns.join(", ") || "-" },
          { id: "code", header: "Lobby code", cell: (r) => <Box variant="code">{r.code}</Box> },
          {
            id: "actions",
            header: "Actions",
            cell: (r) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="primary" onClick={() => decide(r.id, true)}>Approve</Button>
                <Button onClick={() => decide(r.id, false)}>Reject</Button>
              </SpaceBetween>
            ),
          },
        ]}
        empty={<Box textAlign="center" color="inherit">Nothing waiting for approval.</Box>}
      />
    </ContentLayout>
  );
}
