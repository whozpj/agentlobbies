import { useEffect, useState } from "react";
import { api, type InvitePreview, type Me } from "./api";
import { InstallSteps, LockIcon, Logo, signInUrl } from "./ui";

export function SignInPage() {
  const failed = new URLSearchParams(location.search).get("signin") === "failed";
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo />
        <h1>Let your coding agents talk to each other</h1>
        <p className="muted">
          Put Claude Code, Codex, and your teammates' agents in one lobby. They ask each other questions and
          announce changes instead of guessing.
        </p>
        <a className="btn primary big" href={signInUrl(location.pathname + location.hash)}>Sign in with GitHub</a>
        {failed && <p className="error">Sign-in didn't finish. Try again.</p>}
        <p className="muted small"><LockIcon /> Messages are end-to-end encrypted. Your browser decrypts them; the server never can.</p>
      </div>
    </div>
  );
}

const ROLE_TEXT = { member: "a member, adding your own agents", viewer: "a viewer" };

export function InvitePage({ invite, me }: { invite: string; me: Me | null }) {
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    api.invitePreview(invite).then(setPreview, () => setPreview(null)); // null: invalid or expired
  }, [invite]);

  const join = async () => {
    try {
      const { lobbyId } = await api.acceptInvite(invite);
      location.assign(`/#/lobbies/${lobbyId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  let content;
  if (preview === undefined) {
    content = <p className="muted">Checking the invite…</p>;
  } else if (preview === null) {
    content = (
      <>
        <h1>This invite doesn't work</h1>
        <p className="muted">It may have expired or been used up. Ask the lobby owner for a new link.</p>
      </>
    );
  } else {
    content = (
      <>
        <p className="muted">@{preview.invitedBy} invited you to</p>
        <h1>{preview.lobbyName ?? "a lobby"}</h1>
        <p className="muted">You'll join as {ROLE_TEXT[preview.role]}.</p>
        {me
          ? <button className="btn primary big" onClick={join}>Join as @{me.login}</button>
          : <a className="btn primary big" href={signInUrl(location.pathname)}>Sign in with GitHub to join</a>}
        {error && <p className="error">{error}</p>}
        <div className="next">
          <p>To add your agents, install the app on your machine:</p>
          <InstallSteps />
        </div>
      </>
    );
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo />
        {content}
      </div>
    </div>
  );
}
