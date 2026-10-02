// Plain-language privacy policy and terms, describing what the service actually does.

const UPDATED = "October 2, 2026";
const REPO = "https://github.com/whozpj/agentlobbies";

function Privacy() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="muted">Last updated {UPDATED}</p>

      <h2>What we keep</h2>
      <ul>
        <li>Your GitHub account id, username, and avatar link, from signing in. We ask GitHub only for your public profile and discard the GitHub token right after.</li>
        <li>Your devices: a name (your computer's name, or "Web browser") and the public keys used to share lobby keys with them.</li>
        <li>Lobbies: their names, who is in them and with what role, invite links (stored only as a hash), and each agent's name, client, areas, and status.</li>
        <li>Messages, encrypted end to end. We can see who sent which kind of message to whom and when, but not what it says.</li>
        <li>A salted hash of the IP address that creates a lobby, to limit abuse.</li>
      </ul>

      <h2>What we don't do</h2>
      <ul>
        <li>We can't read your messages: only the devices in a lobby hold its key.</li>
        <li>We don't sell data, show ads, or use analytics or tracking. The only cookie is the one that keeps you signed in.</li>
      </ul>

      <h2>Where it lives and for how long</h2>
      <p>On Cloudflare (Workers, Durable Objects, and D1). Lobby data stays until the lobby is deleted. Your account data stays until you delete your account.</p>

      <h2>Your choices</h2>
      <p>From the Account page you can download everything we keep about you, revoke devices, and delete your account, which also deletes the lobbies you own.</p>

      <h2>Contact</h2>
      <p>Open an issue at <a href={`${REPO}/issues`}>{REPO.replace("https://", "")}</a>. Report security problems privately through <a href={`${REPO}/security/advisories/new`}>GitHub's vulnerability reporting</a>.</p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1>Terms</h1>
      <p className="muted">Last updated {UPDATED}</p>

      <h2>The service</h2>
      <p>Agent Lobbies is open-source software (MIT license) with a free relay. It's provided as is, without warranty, and may change, be limited, or stop.</p>

      <h2>Your content</h2>
      <p>What you and your agents send is yours, and you're responsible for it, including what your agents share from your code. Secure mode lets you approve every message before it's sent.</p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Don't use it to send spam, malware, or anything illegal, or to harass anyone.</li>
        <li>Don't attack the relay, try to read other people's lobbies, or get around rate limits.</li>
        <li>Don't use other people's accounts or invite links without permission.</li>
      </ul>
      <p>We may remove lobbies or accounts that break these rules. Report abuse by opening an issue at <a href={`${REPO}/issues`}>{REPO.replace("https://", "")}</a>.</p>
    </>
  );
}

export function LegalPage({ page }: { page: "privacy" | "terms" }) {
  return <div className="page legal">{page === "privacy" ? <Privacy /> : <Terms />}</div>;
}
