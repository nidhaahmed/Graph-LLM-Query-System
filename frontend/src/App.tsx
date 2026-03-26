import { useEffect, useMemo, useState, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";

type Health = { ok: boolean; service: string; time: string };
type Row = Record<string, unknown>;
type GNode = {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
  x?: number;
  y?: number;
};
type GEdge = { id: string; type: string; source: string; target: string };
type ChatItem = {
  id: string;
  question: string;
  answer: string;
  cypher: string;
  at: string;
};

const panel: React.CSSProperties = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 12,
  padding: 14,
  overflow: "hidden",
  minWidth: 0,
};

function getNodeKey(node: GNode): string {
  const p = node.props;
  const keys = [
    "salesOrder",
    "deliveryDocument",
    "billingDocument",
    "accountingDocument",
    "product",
    "customer",
    "plant",
  ] as const;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return node.id;
}

function getNodeLabel(node: GNode): string {
  return getNodeKey(node);
}

function nodeColor(labels: string[]): string {
  const label = labels[0] ?? "";
  const map: Record<string, string> = {
    SalesOrder: "#3b82f6",
    DeliveryDocument: "#f59e0b",
    BillingDocument: "#10b981",
    JournalEntryDocument: "#a78bfa",
    Product: "#22d3ee",
    Customer: "#f472b6",
    Plant: "#84cc16",
    StorageLocation: "#94a3b8",
    Address: "#eab308",
  };
  return map[label] ?? "#cbd5e1";
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [question, setQuestion] = useState(
    "Which products are associated with the highest number of billing documents?",
  );
  const [generatedCypher, setGeneratedCypher] = useState<string>("");
  const [streamingAnswer, setStreamingAnswer] = useState<string>("");
  const [finalAnswer, setFinalAnswer] = useState<string>("");
  const [cypher, setCypher] = useState(
    "MATCH (p:Product)-[:APPEARS_IN_BILLING]->(b:BillingDocument)\nRETURN p.product AS product, count(DISTINCT b) AS billingDocs\nORDER BY billingDocs DESC\nLIMIT 10",
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<ChatItem[]>([]);

  const [graphKey, setGraphKey] = useState("");
  const [graphData, setGraphData] = useState<{ nodes: GNode[]; edges: GEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [graphErr, setGraphErr] = useState("");
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [lastClick, setLastClick] = useState<{ id: string; at: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [graphConfig, setGraphConfig] = useState({ width: 0, height: 460 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setGraphConfig({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fetch("http://localhost:5000/health")
      .then((r) => r.json())
      .then((d: Health) => setHealth(d))
      .catch((e: unknown) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!finalAnswer) return;
    setStreamingAnswer("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 2;
      setStreamingAnswer(finalAnswer.slice(0, i));
      if (i >= finalAnswer.length) window.clearInterval(id);
    }, 12);
    return () => window.clearInterval(id);
  }, [finalAnswer]);

  const prettyRows = useMemo(() => JSON.stringify(rows, null, 2), [rows]);

  async function fetchNeighborhood(key: string, mergeMode: boolean) {
    if (!key) return;
    setGraphErr("");
    const res = await fetch(
      `http://localhost:5000/graph/neighborhood?key=${encodeURIComponent(key)}&limit=120`,
    );
    const data = (await res.json()) as {
      ok: boolean;
      nodes?: GNode[];
      edges?: GEdge[];
      error?: string;
    };
    if (!data.ok) throw new Error(data.error ?? "Failed to load graph");

    const newNodes = data.nodes ?? [];
    const newEdges = data.edges ?? [];
    if (!mergeMode) {
      setGraphData({ nodes: newNodes, edges: newEdges });
      return;
    }

    setGraphData((prev) => {
      const nodeMap = new Map(prev.nodes.map((n) => [n.id, n]));
      for (const n of newNodes) nodeMap.set(n.id, n);
      const edgeMap = new Map(prev.edges.map((e) => [e.id, e]));
      for (const e of newEdges) edgeMap.set(e.id, e);
      return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
    });
  }

  async function loadNeighborhood() {
    try {
      await fetchNeighborhood(graphKey.trim(), false);
    } catch (e) {
      setGraphErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function runCypher() {
    setRunning(true);
    setErr("");
    setFinalAnswer("");
    setStreamingAnswer("");
    setGeneratedCypher("");
    try {
      const res = await fetch("http://localhost:5000/query/cypher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cypher, params: {} }),
      });
      const data = (await res.json()) as { ok: boolean; rows?: Row[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? "Query failed");
      const outRows = data.rows ?? [];
      setRows(outRows);
      if (outRows.length > 0) {
        const first = outRows[0];
        const firstKey = Object.values(first).find((v) => typeof v === "string");
        if (typeof firstKey === "string") {
          setGraphKey(firstKey);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function askNl() {
    setRunning(true);
    setErr("");
    setFinalAnswer("");
    setStreamingAnswer("");
    try {
      const res = await fetch("http://localhost:5000/query/nl-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        cypher?: string;
        rows?: Row[];
        answer?: string;
        error?: string;
      };
      if (!data.ok) throw new Error(data.error ?? "NL query failed");
      const nextCypher = String(data.cypher ?? "");
      const nextRows = data.rows ?? [];
      const answer = String(data.answer ?? "");

      setGeneratedCypher(nextCypher);
      setCypher(nextCypher);
      setRows(nextRows);
      setFinalAnswer(answer);
      setHistory((prev) => [
        {
          id: `${Date.now()}`,
          question,
          answer,
          cypher: nextCypher,
          at: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);

      const first = nextRows[0];
      if (first) {
        const firstKey = Object.values(first).find((v) => typeof v === "string");
        if (typeof firstKey === "string") {
          setGraphKey(firstKey);
          await fetchNeighborhood(firstKey, false);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        background: "#0b1020",
        color: "#e5e7eb",
        minHeight: "100vh",
        padding: 16,
      }}
    >
      <div
        style={{
          ...panel,
          marginBottom: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>Graph LLM Query System</div>
        <div style={{ display: "flex", gap: 14, color: "#9ca3af", fontSize: 13 }}>
          <span>Backend: {health?.ok ? "OK" : "..."}</span>
          <span>{health?.service ?? "service"}</span>
          <span>{health?.time ? new Date(health.time).toLocaleString() : ""}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "34fr 66fr", gap: 12 }}>
        <div style={{ display: "grid", gap: 12, alignContent: "start", minWidth: 0 }}>
          <div style={panel}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Ask in natural language</div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={4}
              style={{ width: "100%", borderRadius: 8, padding: 10, border: "1px solid #374151" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={askNl} disabled={running}>
                {running ? "Running..." : "Ask"}
              </button>
              <button onClick={() => setHistory([])}>Clear Memory</button>
            </div>
            {err && <div style={{ color: "#f87171", marginTop: 8 }}>{err}</div>}
          </div>

          <div style={panel}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Streaming answer</div>
            <div style={{ whiteSpace: "pre-wrap", minHeight: 70, color: "#d1d5db" }}>
              {streamingAnswer || "Ask a question to get an answer."}
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Generated Cypher</div>
            <pre
              style={{
                margin: 0,
                maxHeight: 140,
                overflow: "auto",
                background: "#0f172a",
                padding: 8,
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              {generatedCypher || "No generated Cypher yet."}
            </pre>
          </div>

          <div style={panel}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Conversation memory</div>
            <div style={{ maxHeight: 180, overflow: "auto", display: "grid", gap: 8 }}>
              {history.length === 0 && <div style={{ color: "#94a3b8" }}>No messages yet.</div>}
              {history.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    setQuestion(h.question);
                    setGeneratedCypher(h.cypher);
                    setFinalAnswer(h.answer);
                  }}
                  style={{
                    textAlign: "left",
                    background: "#0f172a",
                    color: "#e5e7eb",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    padding: 8,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{h.at}</div>
                  <div style={{ fontWeight: 600 }}>{h.question}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, alignContent: "start", minWidth: 0 }}>
          <div style={panel}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                value={graphKey}
                onChange={(e) => setGraphKey(e.target.value)}
                placeholder="Node key (salesOrder / billingDocument / product / ...)"
                style={{ flex: 1, borderRadius: 8, padding: 10, border: "1px solid #374151" }}
              />
              <button onClick={loadNeighborhood}>Load</button>
            </div>
            {graphErr && <div style={{ color: "#f87171", marginBottom: 8 }}>{graphErr}</div>}
            <div ref={containerRef} style={{ height: 460, borderRadius: 10, overflow: "hidden", background: "#020617" }}>
              <ForceGraph2D<GNode, GEdge>
                width={graphConfig.width}
                height={graphConfig.height}
                graphData={{ nodes: graphData.nodes, links: graphData.edges }}
                nodeLabel={(n) => {
                  const node = n as GNode;
                  return `${node.labels.join(", ")}: ${getNodeLabel(node)}`;
                }}
                linkLabel={(l) => l.type}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={1}
                onNodeClick={async (n) => {
                  setSelectedNode(n);
                  const now = Date.now();
                  if (lastClick && lastClick.id === n.id && now - lastClick.at < 350) {
                    const key = getNodeKey(n);
                    setGraphKey(key);
                    try {
                      await fetchNeighborhood(key, true);
                    } catch (e) {
                      setGraphErr(e instanceof Error ? e.message : String(e));
                    }
                  }
                  setLastClick({ id: n.id, at: now });
                }}
                onNodeRightClick={(n) => setGraphKey(getNodeKey(n))}
                nodeCanvasObject={(n: GNode, ctx, globalScale) => {
                  const node = n;
                  const label = getNodeLabel(node);
                  const fontSize = 11 / globalScale;
                  ctx.font = `${fontSize}px Sans-Serif`;
                  ctx.fillStyle = nodeColor(node.labels);
                  ctx.beginPath();
                  ctx.arc((n.x ?? 0) as number, (n.y ?? 0) as number, 4.5, 0, 2 * Math.PI, false);
                  ctx.fill();
                  ctx.fillStyle = "#e5e7eb";
                  ctx.fillText(label, (n.x ?? 0) + 6, (n.y ?? 0) + 4);
                }}
              />
            </div>
            <div style={{ marginTop: 8, color: "#9ca3af", fontSize: 12 }}>
              Tip: Double-click a node to expand its neighborhood, click a node to inspect metadata.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <div style={panel}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Selected node metadata</div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 220,
                  overflow: "auto",
                  background: "#0f172a",
                  padding: 8,
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                {selectedNode
                  ? JSON.stringify(
                      {
                        id: selectedNode.id,
                        labels: selectedNode.labels,
                        props: selectedNode.props,
                      },
                      null,
                      2,
                    )
                  : "No node selected."}
              </pre>
            </div>

            <div style={panel}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Result rows</div>
              <pre
                style={{
                  margin: 0,
                  maxHeight: 220,
                  overflow: "auto",
                  background: "#0f172a",
                  padding: 8,
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                {rows.length ? prettyRows : "No rows yet."}
              </pre>
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Manual Cypher (read-only)</div>
            <textarea
              value={cypher}
              onChange={(e) => setCypher(e.target.value)}
              rows={5}
              style={{
                width: "100%",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #374151",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            />
            <div style={{ marginTop: 8 }}>
              <button onClick={runCypher} disabled={running}>
                {running ? "Running..." : "Run Cypher"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
