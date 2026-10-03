import "./index.css";
import { useEffect, useState } from "react";

type LogEntry = {
  time: string;
  type: "info" | "tool_call" | "tool_result" | "error";
  text: string;
};

type SessionStatus =
  | "ready"
  | "running"
  | "waiting_for_input"
  | "done"
  | "error"
  | "stopped";

export function App() {
  const sessionId = "";
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus | "">("");

  useEffect(() => {
    if (!sessionId) return;

    const es = new EventSource(
      `http://localhost:3001/api/session/${sessionId}/stream`,
      { withCredentials: true },
    );

    es.addEventListener("log", (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as LogEntry;
      setLogs((prev) => [...prev, data]);
    });

    es.addEventListener("status", (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { status: SessionStatus };
      setStatus(data.status);
    });

    return () => {
      es.close();
    };
  }, [sessionId]);

  return (
    <div className="container mx-auto p-8 text-center relative z-10">
      hello, ankit
    </div>
  );
}

export default App;
