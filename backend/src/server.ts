import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { driver } from "./neo4j";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "graph-llm-query-system",
    time: new Date().toISOString(),
  });
});

app.get("/neo4j/health", async (_req, res) => {
  const session = driver.session();
  try {
    const result = await session.run("RETURN 1 AS ok");
    res.json({ ok: true, value: result.records[0].get("ok") });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await session.close();
  }
});

function assertReadOnlyCypher(cypher: string) {
  const s = cypher.trim();

  // must start with a read query
  if (!/^(MATCH|WITH|RETURN)\b/i.test(s)) {
    throw new Error("Only read-only Cypher is allowed (MATCH/WITH/RETURN).");
  }

  // block write / procedure / admin keywords
  const forbidden = [
    "CREATE",
    "MERGE",
    "DELETE",
    "DETACH",
    "SET",
    "REMOVE",
    "DROP",
    "CALL",
    "LOAD CSV",
    "APOC",
    "INDEX",
    "CONSTRAINT",
    "SHOW",
    "GRANT",
    "REVOKE",
  ];

  const upper = s.toUpperCase();
  for (const kw of forbidden) {
    if (upper.includes(kw))
      throw new Error(`Forbidden keyword in Cypher: ${kw}`);
  }
}

function neo4jValueToJson(v: any): any {
  // Neo4j Integer support: {low, high} or neo4j.int
  if (v && typeof v === "object") {
    if (typeof v.toNumber === "function") return v.toNumber();
    if ("low" in v && "high" in v && typeof v.low === "number") return v.low; // good enough for your dataset sizes
    if (Array.isArray(v)) return v.map(neo4jValueToJson);
    if (v.properties) return neo4jValueToJson(v.properties);
  }
  return v;
}

type Row = Record<string, unknown>;

function cypherResultToRows(result: any): Row[] {
  return result.records.map((r: any) => {
    const obj: Record<string, unknown> = {};
    for (const key of r.keys) {
      const k = String(key);
      obj[k] = neo4jValueToJson(r.get(k));
    }
    return obj;
  });
}

app.post("/query/cypher", async (req, res) => {
  try {
    const cypher = String(req.body?.cypher ?? "");
    const params = (req.body?.params ?? {}) as Record<string, any>;

    if (!cypher)
      return res.status(400).json({ ok: false, error: "Missing cypher" });

    assertReadOnlyCypher(cypher);

    const result = await driver.executeQuery(cypher, params);

    const rows = cypherResultToRows(result);

    res.json({ ok: true, rows });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

function buildSchemaHint() {
  return {
    labels: [
      "SalesOrder",
      "DeliveryDocument",
      "BillingDocument",
      "JournalEntryDocument",
      "Product",
      "Customer",
      "Plant",
      "StorageLocation",
      "Address",
    ],
    relationships: [
      "(:SalesOrder)-[:HAS_DELIVERY]->(:DeliveryDocument)",
      "(:DeliveryDocument)-[:BILLED_IN]->(:BillingDocument)",
      "(:BillingDocument)-[:HAS_JOURNAL_ENTRY]->(:JournalEntryDocument)",
      "(:Product)-[:APPEARS_IN_BILLING]->(:BillingDocument)",
      "(:SalesOrder)-[:SOLD_TO]->(:Customer)",
      "(:BillingDocument)-[:SOLD_TO]->(:Customer)",
      "(:JournalEntryDocument)-[:CUSTOMER]->(:Customer)",
      "(:Customer)-[:HAS_ADDRESS]->(:Address)",
      "(:Plant)-[:HAS_ADDRESS]->(:Address)",
      "(:Product)-[:AVAILABLE_IN_PLANT]->(:Plant)",
      "(:Plant)-[:HAS_STORAGE_LOCATION]->(:StorageLocation)",
      "(:Product)-[:STORED_IN]->(:StorageLocation)",
    ],
    keyProperties: {
      SalesOrder: ["salesOrder"],
      DeliveryDocument: ["deliveryDocument"],
      BillingDocument: ["billingDocument"],
      JournalEntryDocument: ["accountingDocument"],
      Product: ["product", "description"],
      Customer: ["customer", "name"],
      Plant: ["plant", "plantName"],
      StorageLocation: ["plant", "storageLocation"],
      Address: ["addressId", "country", "region", "cityName", "postalCode", "streetName"],
    },
  };
}

function extractCypherFromModelText(text: string): string {
  // Expect pure JSON, but be resilient.
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed) as { cypher?: unknown };
    if (typeof obj.cypher === "string") return obj.cypher;
  } catch {
    // fall through
    console.log("Model did not return valid JSON {cypher: string}");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1]) as { cypher?: unknown };
      if (typeof obj.cypher === "string") return obj.cypher;
    } catch {
      // fall through
      console.log("Model did not return valid JSON {cypher: string}");
      console.log(fenced[1]);
    }
  }

  throw new Error("Model did not return valid JSON {cypher: string}");
}

type GeminiModelInfo = {
  name: string;
  supportedGenerationMethods?: string[];
  displayName?: string;
};

let cachedGeminiModels: { atMs: number; models: GeminiModelInfo[] } | null = null;

async function listGeminiModels(apiKey: string): Promise<GeminiModelInfo[]> {
  const now = Date.now();
  if (cachedGeminiModels && now - cachedGeminiModels.atMs < 10 * 60 * 1000) {
    return cachedGeminiModels.models;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ListModels failed: HTTP ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as { models?: GeminiModelInfo[] };
  const models = (data.models ?? []).filter((m) => typeof m?.name === "string");
  cachedGeminiModels = { atMs: now, models };
  return models;
}

function pickModelForGenerateContent(models: GeminiModelInfo[]): string {
  const usable = models.filter((m) =>
    (m.supportedGenerationMethods ?? []).includes("generateContent"),
  );
  if (!usable.length) {
    throw new Error("No models available that support generateContent for this API key.");
  }

  // Prefer "flash" models for speed/cost, otherwise first usable.
  const flash = usable.find((m) => m.name.includes("flash"));
  return (flash ?? usable[0]).name.replace(/^models\//, "");
}

app.get("/gemini/models", async (_req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY in .env" });

    const models = await listGeminiModels(apiKey);
    const simplified = models.map((m) => ({
      name: m.name?.replace(/^models\//, ""),
      displayName: m.displayName ?? null,
      methods: m.supportedGenerationMethods ?? [],
    }));
    res.json({ ok: true, models: simplified });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/query/nl", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "Missing question" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY in .env" });
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const schema = buildSchemaHint();

    const prompt = [
      "You are a Cypher generator for Neo4j.",
      'Return ONLY valid JSON with shape: {"cypher":"..."}. No markdown.',
      "",
      "Hard rules:",
      "- Generate READ-ONLY Cypher only (MATCH/WITH/RETURN/OPTIONAL MATCH/WHERE/ORDER BY/LIMIT).",
      "- Never use CREATE, MERGE, DELETE, SET, REMOVE, CALL, APOC, LOAD CSV, DROP, INDEX, CONSTRAINT, SHOW, GRANT, REVOKE.",
      "- Use only labels/relationships/properties from schema below.",
      "- Always include LIMIT 50 unless user asks for a smaller limit.",
      "",
      "Business-flow semantics (IMPORTANT):",
      "- Use relationship topology for process-state questions.",
      "- 'delivered but not billed' => SalesOrder -[:HAS_DELIVERY]-> DeliveryDocument AND DeliveryDocument has NO outgoing :BILLED_IN edge.",
      "- 'billed without delivery' => BillingDocument with NO incoming :BILLED_IN edge from DeliveryDocument.",
      "- Do not require status columns if topology already determines state.",
      "",
      "Schema:",
      JSON.stringify(schema),
      "",
      "Few-shot examples:",
      "Q: Identify sales orders delivered but not billed.",
      'A: {"cypher":"MATCH (so:SalesOrder)-[:HAS_DELIVERY]->(d:DeliveryDocument) WHERE NOT (d)-[:BILLED_IN]->(:BillingDocument) RETURN so.salesOrder AS salesOrder, collect(DISTINCT d.deliveryDocument)[0..5] AS deliveries LIMIT 50"}',
      "",
      "Q: Identify billing documents without delivery.",
      'A: {"cypher":"MATCH (b:BillingDocument) WHERE NOT (:DeliveryDocument)-[:BILLED_IN]->(b) RETURN b.billingDocument AS billingDocument LIMIT 50"}',
      "",
      "Q: Trace full flow for billing document 90504259.",
      'A: {"cypher":"MATCH (b:BillingDocument {billingDocument:\'90504259\'}) OPTIONAL MATCH (d:DeliveryDocument)-[:BILLED_IN]->(b) OPTIONAL MATCH (so:SalesOrder)-[:HAS_DELIVERY]->(d) OPTIONAL MATCH (b)-[:HAS_JOURNAL_ENTRY]->(j:JournalEntryDocument) RETURN b.billingDocument AS billingDocument, d.deliveryDocument AS deliveryDocument, so.salesOrder AS salesOrder, j.accountingDocument AS journalEntry LIMIT 50"}',
      "",
      "User question:",
      question,
    ].join("\n");

    const requestedModel = (process.env.GEMINI_MODEL ?? "").trim();
    const chosenModel =
      requestedModel ||
      pickModelForGenerateContent(await listGeminiModels(apiKey));

    const model = genAI.getGenerativeModel({
      model: chosenModel,
      generationConfig: { responseMimeType: "application/json" },
    });

    const resp = await model.generateContent(prompt);
    const text = resp.response.text();
    const cypher = extractCypherFromModelText(text);

    assertReadOnlyCypher(cypher);

    const result = await driver.executeQuery(cypher, {});
    const rows = cypherResultToRows(result);

    res.json({ ok: true, model: chosenModel, cypher, rows });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/query/nl-answer", async (req, res) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    if (!question)
      return res.status(400).json({ ok: false, error: "Missing question" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey)
      return res
        .status(500)
        .json({ ok: false, error: "Missing GEMINI_API_KEY in .env" });

    const genAI = new GoogleGenerativeAI(apiKey);

    // 1) Generate Cypher (reuse your existing logic)
    const schema = buildSchemaHint();

    const cypherPrompt = [
      "You are a Cypher generator for Neo4j.",
      'Return ONLY valid JSON: {"cypher":"..."}. No markdown.',
      "Rules:",
      "- Only read-only Cypher (MATCH/WITH/RETURN).",
      "- MUST include LIMIT 50 unless user asks for smaller.",
      "- Use only the schema below.",
      "",
      "Schema:",
      JSON.stringify(schema),
      "",
      "User question:",
      question,
    ].join("\n");

    const modelName = (process.env.GEMINI_MODEL ?? "gemini-2.5-flash").trim();
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json" },
    });

    const cypherResp = await model.generateContent(cypherPrompt);
    const cypherText = cypherResp.response.text();
    const cypher = extractCypherFromModelText(cypherText);

    assertReadOnlyCypher(cypher);

    // 2) Execute Cypher
    const result = await driver.executeQuery(cypher, {});
    const rows = cypherResultToRows(result);

    // 3) Grounded natural-language answer (VERY IMPORTANT: only use rows)
    const answerPrompt = [
      "You are given the final query result rows from Neo4j.",
      "Your job: answer the user's question USING ONLY these rows.",
      "",
      "Rules:",
      "- Do NOT say you are missing information if rows are non-empty.",
      "- If rows are non-empty: explicitly list the key identifiers from rows.",
      "- If rows are empty: reply exactly 'No matching records found in current dataset for this query.'",
      "- Do not invent IDs not in rows.",
      "- Keep it short (1-5 lines).",
      "",
      "User question:",
      question,
      "",
      "Rows JSON (authoritative):",
      JSON.stringify(rows),
      "",
      "Now write the answer.",
    ].join("\n");

    const answerModel = genAI.getGenerativeModel({ model: modelName });
    const answerResp = await answerModel.generateContent(answerPrompt);
    const answer = answerResp.response.text().trim();

    res.json({ ok: true, model: modelName, cypher, rows, answer });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/graph/neighborhood", async (req, res) => {
  try {
    const key = String(req.query.key ?? "").trim(); // e.g., "90504259" or "740506"
    const limit = Math.min(Number(req.query.limit ?? 100), 300);

    if (!key) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing key query param" });
    }

    // Finds a seed node by known id fields, then returns 1-hop neighborhood
    const cypher = `
MATCH (seed)
WHERE seed.salesOrder = $key
   OR seed.deliveryDocument = $key
   OR seed.billingDocument = $key
   OR seed.accountingDocument = $key
   OR seed.product = $key
   OR seed.customer = $key
   OR seed.plant = $key
OPTIONAL MATCH (seed)-[r]-(n)
WITH seed, collect(DISTINCT n)[0..$limit] AS neighbors, collect(DISTINCT r)[0..$limit] AS rels
WITH [seed] + neighbors AS nodes, rels
UNWIND nodes AS node
WITH collect(DISTINCT node) AS uniqNodes, rels
UNWIND rels AS rel
WITH uniqNodes, collect(DISTINCT {
  id: elementId(rel),
  type: type(rel),
  source: elementId(startNode(rel)),
  target: elementId(endNode(rel))
}) AS edges
RETURN
  [n IN uniqNodes | {
    id: elementId(n),
    labels: labels(n),
    props: properties(n)
  }] AS nodes,
  edges
`;

    const result = await driver.executeQuery(cypher, { key, limit });
    const row = result.records[0];
    if (!row) return res.json({ ok: true, nodes: [], edges: [] });

    const nodes = row.get("nodes");
    const edges = row.get("edges");
    return res.json({ ok: true, nodes, edges });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

const PORT = Number(process.env.PORT ?? 5000);
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
