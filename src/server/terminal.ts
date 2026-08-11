import os from "node:os";
import pty from "node-pty";
import { workspaceRoot } from "./workspace.js";

const terminals = new Map<string, pty.IPty>();

export function createTerminal(cols = 80, rows = 24): { id: string; pty: pty.IPty } {
  const shell = os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
  const id = crypto.randomUUID();
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: workspaceRoot(),
    env: process.env as Record<string, string>,
  });
  terminals.set(id, ptyProcess);

  ptyProcess.onExit(() => {
    terminals.delete(id);
  });

  return { id, pty: ptyProcess };
}

export function getTerminal(id: string): pty.IPty | undefined {
  return terminals.get(id);
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
}

export function destroyTerminal(id: string) {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.kill();
    terminals.delete(id);
  }
}
