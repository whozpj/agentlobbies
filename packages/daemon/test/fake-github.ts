import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Just enough of github.com and api.github.com for sign-in tests. The device flow approves at once.
 * A client id "test-<login>" signs in as <login> (otherwise "tester"). A token "gho_fake_<login>"
 * belongs to <login>. Either may end in ".<tag>": the login stays the same, but the tag makes a
 * different user, so parallel tests never share one.
 */
export async function startFakeGitHub(): Promise<{ url: string; server: Server }> {
  // Who is "signed in to GitHub" in the browser, for the web flow; tests set it with /test/act-as?user=.
  let browserUser = "tester";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const requestUrl = new URL(req.url ?? "/", "http://x");
      const path = requestUrl.pathname;
      if (path === "/test/act-as") {
        browserUser = requestUrl.searchParams.get("user") ?? "tester";
        return json(200, {});
      }
      if (path === "/login/oauth/authorize") {
        const back = new URL(requestUrl.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", `code-${browserUser}`);
        back.searchParams.set("state", requestUrl.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (path === "/login/device/code") {
        const clientId = new URLSearchParams(body).get("client_id") ?? "";
        const login = clientId.startsWith("test-") ? clientId.slice("test-".length) : "tester";
        return json(200, { device_code: `device-${login}`, user_code: "WDJB-MJHT", verification_uri: `${url}/login/device`, expires_in: 900, interval: 0 });
      }
      if (path === "/login/oauth/access_token") {
        const form = new URLSearchParams(body);
        const parsed = body.startsWith("{") ? JSON.parse(body) : {};
        // The device flow sends a device code; the web flow sends "code-<login>".
        const code = String(form.get("device_code") ?? parsed.device_code ?? parsed.code ?? "");
        return json(200, { access_token: `gho_fake_${code.replace(/^(device|code)-/, "")}`, token_type: "bearer", scope: "" });
      }
      if (path === "/user") {
        const user = (req.headers.authorization ?? "").match(/gho_fake_([\w.-]+)/)?.[1];
        if (!user) return json(401, { message: "Bad credentials" });
        const login = user.split(".")[0];
        const id = [...user].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) % 1_000_000_000;
        return json(200, { id, login, avatar_url: `https://avatars.githubusercontent.com/u/${id}` });
      }
      json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, server };
}
