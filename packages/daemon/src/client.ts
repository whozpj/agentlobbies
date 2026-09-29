// What MCP servers and the CLI need to talk to the daemon, without loading node:sqlite (G40).
export { defaultHome, relayUrl, socketPath } from "./paths";
export { DaemonError, RpcClient } from "./rpc";
