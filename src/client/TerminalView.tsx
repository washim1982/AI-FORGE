import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_THEME, useSystemTheme } from "./theme";

export function TerminalView() {
  const theme = useSystemTheme();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13.5,
      theme: TERMINAL_THEME[theme],
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    
    // Slight delay to allow DOM to settle before fitting
    setTimeout(() => {
      fitAddon.fit();
    }, 10);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    let currentId: string | null = null;

    const initTerminal = async () => {
      try {
        const response = await fetch("/api/terminal/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        });
        const data = await response.json();
        currentId = data.id;
        setTerminalId(currentId);

        if (!currentId) return;

        const eventSource = new EventSource(`/api/terminal/${currentId}/stream`);
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
          term.write(JSON.parse(event.data));
        };

        eventSource.onerror = () => {
          term.write("\r\n[Disconnected from terminal]\r\n");
          eventSource.close();
        };

        term.onData((data) => {
          fetch(`/api/terminal/${currentId}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data }),
          }).catch(console.error);
        });

      } catch (err) {
        console.error("Failed to spawn terminal", err);
        term.write("\r\n[Failed to connect to terminal backend]\r\n");
      }
    };

    initTerminal();

    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current && currentId) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        fetch(`/api/terminal/${currentId}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols, rows }),
        }).catch(console.error);
      }
    };

    window.addEventListener("resize", handleResize);

    const observer = new ResizeObserver(() => {
      handleResize();
    });
    observer.observe(terminalRef.current);

    return () => {
      window.removeEventListener("resize", handleResize);
      observer.disconnect();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      term.dispose();
    };
  }, []);

  // The terminal is constructed once, so a later theme change has to be pushed
  // onto the live instance rather than waiting for a remount.
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = TERMINAL_THEME[theme];
  }, [theme]);

  return (
    <div className="terminal-container" style={{ height: "100%", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div ref={terminalRef} style={{ flex: 1, minHeight: 0, width: "100%", padding: "12px 16px" }} />
    </div>
  );
}
