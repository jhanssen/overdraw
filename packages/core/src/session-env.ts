// Publishes the session identity (WAYLAND_DISPLAY, DISPLAY,
// XDG_CURRENT_DESKTOP, XDG_SESSION_TYPE) into the systemd user manager and
// D-Bus activation environment, so user-bus services activated later
// (xdg-desktop-portal + backends, notification daemons) bind to this
// compositor's displays instead of whatever session started them first.
// Values are passed as explicit VAR=VALUE assignments -- never read from
// process.env, where WAYLAND_DISPLAY may point at a host compositor.
// The caller gates on the kms backend: a nested overdraw publishing its
// sockets would steal the host session's services.

import { spawn } from "node:child_process";

export function sessionEnvAssignments(
  waylandDisplay: string,
  x11Display: string | null,
): string[] {
  const vars = [
    `WAYLAND_DISPLAY=${waylandDisplay}`,
    `XDG_CURRENT_DESKTOP=${process.env.XDG_CURRENT_DESKTOP ?? "overdraw"}`,
    "XDG_SESSION_TYPE=wayland",
  ];
  if (x11Display !== null) vars.push(`DISPLAY=${x11Display}`);
  return vars;
}

export const SESSION_ENV_NAMES = [
  "WAYLAND_DISPLAY", "DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE",
] as const;

// Fire-and-forget: detached + unref so the helper survives an immediately
// following process.exit (the shutdown path clears the env and exits without
// waiting).
function run(cmd: string, args: string[], onError: (msg: string) => void): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => onError(`${cmd}: ${e.message}`));
    child.unref();
  } catch (e) {
    onError(`${cmd}: ${(e as Error).message}`);
  }
}

export function publishSessionEnv(
  waylandDisplay: string,
  x11Display: string | null,
  warn: (msg: string) => void,
): void {
  const assigns = sessionEnvAssignments(waylandDisplay, x11Display);
  // --systemd imports into the systemd user manager as well, covering both
  // consumers in one call; systemctl set-environment is the fallback when
  // the dbus tool is absent.
  run("dbus-update-activation-environment", ["--systemd", ...assigns], (m) => {
    warn(`session env: ${m}; falling back to systemctl`);
    run("systemctl", ["--user", "set-environment", ...assigns],
      (m2) => warn(`session env: ${m2}`));
  });
}

// D-Bus activation env entries cannot be removed, only overwritten, so the
// systemd side is the one that gets cleaned; stale dbus entries are then
// overwritten by the next session's publish.
export function clearSessionEnv(warn: (msg: string) => void): void {
  run("systemctl", ["--user", "unset-environment", ...SESSION_ENV_NAMES],
    (m) => warn(`session env: ${m}`));
}
