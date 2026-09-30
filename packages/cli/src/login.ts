// The GitHub OAuth app's client id is public by design; device flow needs no secret.
const CLIENT_ID = process.env.AGENTLOBBIES_GITHUB_CLIENT_ID ?? "Ov23liFoL6Ih3Aj5vPwc";
const GITHUB = process.env.AGENTLOBBIES_GITHUB_URL ?? "https://github.com";

async function post<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${GITHUB}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json() as Promise<T>;
}

/** GitHub's device flow (as in `gh auth login`): returns a GitHub token once the user approves. */
export async function githubDeviceLogin(show: (userCode: string, url: string) => void): Promise<string> {
  const start = await post<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }>(
    "/login/device/code", { client_id: CLIENT_ID, scope: "" },
  );
  show(start.user_code, start.verification_uri);

  let interval = start.interval;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const poll = await post<{ access_token?: string; error?: string }>("/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: start.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (poll.access_token) return poll.access_token;
    if (poll.error === "slow_down") interval += 5;
    else if (poll.error !== "authorization_pending") throw new Error(`GitHub sign-in failed: ${poll.error}`);
  }
  throw new Error("The GitHub sign-in code expired. Run `agentlobbies login` again.");
}
