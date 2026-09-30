import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Just enough of github.com and api.github.com for sign-in tests. The device flow approves at once.
 * A client id "test-<login>" signs in as <login> (otherwise "tester"), so parallel tests never share
 * state. A token "gho_fake_<login>" belongs to <login>.
 */
export async function startFakeGitHub(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/login/device/code") {
        const clientId = new URLSearchParams(body).get("client_id") ?? "";
        const login = clientId.startsWith("test-") ? clientId.slice("test-".length) : "tester";
        return json(200, { device_code: `device-${login}`, user_code: "WDJB-MJHT", verification_uri: `${url}/login/device`, expires_in: 900, interval: 0 });
      }
      if (path === "/login/oauth/access_token") {
        const deviceCode = new URLSearchParams(body).get("device_code") ?? JSON.parse(body || "{}").device_code;
        return json(200, { access_token: `gho_fake_${String(deviceCode).replace(/^device-/, "")}`, token_type: "bearer", scope: "" });
      }
      if (path === "/user") {
        const login = (req.headers.authorization ?? "").match(/gho_fake_([\w-]+)/)?.[1];
        if (!login) return json(401, { message: "Bad credentials" });
        const id = [...login].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) % 1_000_000_000;
        return json(200, { id, login, avatar_url: `https://avatars.githubusercontent.com/u/${id}` });
      }
      json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, server };
}
