# Graph-LLM Query System 🛡️📊

An intelligent graph-based system designed to unify fragmented enterprise data (Sales, Deliveries, Billing, Accounting) into an actionable context graph with an LLM-powered natural language interface.

## 🚀 Key Features & Achievements
Developed in response to the **Forward Deployed Engineer** challenge, achieving the following:

- **Automated Graph Ingestion**: High-performance ingestion of JSONL shards into **Neo4j**, modeling complex business topologies (Orders → Deliveries → Invoices → Journal Entries).
- **Conversational AI Interface**: AI-driven query engine using **Google Gemini Pro** to translate Natural Language into precise, read-only **Cypher** queries.
- **Interactive Visualization**: Real-time 2D Force-Directed Graph using `react-force-graph-2d` with support for node neighbor expansion, metadata inspection, and dynamic scaling.
- **Strict Guardrails**: Implemented dual-layer security—AI system prompts restrict domain scope, while backend logic enforces read-only Cypher assertions to prevent data mutation.
- **Bonus Extras Included**: 
    - 🔄 **Conversation Memory**: Historical context tracking for iterative questioning.
    - ⚡ **Streaming UI**: Animated response generation for a premium experience.
    - 🧐 **Root-Cause Analysis**: Advanced predicates to identify "Broken Flows" (e.g., delivered but never billed).

---

## 🏗️ Architecture

### **Tech Stack**
- **Frontend**: React (Vite), TypeScript, vanilla CSS (layout-optimized).
- **Backend**: Node.js, Express, TypeScript.
- **Database**: Neo4j (Graph Database) - chosen for native relationship-first indexing.
- **AI**: Google Gemini API (Gen AI) - utilized for Cypher generation and natural language answer grounding.

### **Query Flow**
1. **NL Input**: User asks a question (e.g., "Show me orders with no delivery").
2. **Translation**: LLM generates Cypher based on the injected **Graph Schema**.
3. **Validation**: Backend scripts verify Cypher for forbidden keywords (`DELETE`, `CREATE`, etc.).
4. **Execution**: Neo4j runs the query and returns raw JSON rows.
5. **Synthesis**: LLM constructs a natural language answer grounded **only** in the returned rows to prevent hallucinations.
6. **Visualization**: Frontend renders the neighborhood topology of the result set.

---

## 🛠️ Setup & Deployment

### **Deployment Links**
- **Frontend (Vercel)**: [https://graph-llm-query-system-lime.vercel.app/](https://graph-llm-query-system-lime.vercel.app/)
- **Backend (Render)**: [https://graph-llm-query-system-y5xo.onrender.com](https://graph-llm-query-system-y5xo.onrender.com)

### **Local Setup**
1. **Clone & Install**:
   ```bash
   git clone https://github.com/nidhaahmed/Graph-LLM-Query-System.git
   cd backend && npm install
   cd ../frontend && npm install
   ```
2. **Environment**:
   Set `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, and `GEMINI_API_KEY` in `backend/.env`.
3. **Ingest Data**:
   ```bash
   cd backend && npm run ingest
   ```
4. **Run**:
   ```bash
   # Both directories
   npm run dev
   ```

---

## 🛡️ Guardrails & Security
To ensure reliability and safety:
- **Scope Restriction**: The system prompt explicitly instructs the LLM to reject queries about general knowledge, creative writing, or anything outside the Supply Chain domain.
- **Syntax Enforcement**: The backend utilizes a `assertReadOnlyCypher` utility that scans for and blocks `MERGE`, `SET`, `REMOVE`, and other mutation keywords.
- **Data Grounding**: Answers are provided strictly based on query results; if no data matches, the system returns a standard "No matching records found" response instead of guessing.