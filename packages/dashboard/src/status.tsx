import StatusIndicator, { type StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";

const AGENT_STATUS: Record<string, StatusIndicatorProps.Type> = { active: "success", busy: "in-progress", idle: "pending", offline: "stopped" };
const CONNECTION_STATUS: Record<string, StatusIndicatorProps.Type> = { live: "success", replaying: "loading", connecting: "loading", handshaking: "loading", backoff: "warning" };

export function AgentStatus({ status }: { status: string }) {
  return <StatusIndicator type={AGENT_STATUS[status] ?? "stopped"}>{status}</StatusIndicator>;
}

export function ConnectionStatus({ state }: { state: string }) {
  return <StatusIndicator type={CONNECTION_STATUS[state] ?? "error"}>{state}</StatusIndicator>;
}
