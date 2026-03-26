# Graph LLM Query System

## Overview
The Graph LLM Query System is an intelligent, full-stack application designed to translate Natural Language questions into executable Graph queries (Cypher), visualize the database topology, and generate accurate, grounded natural-language answers derived strictly from the resulting data context.

Built on the foundation of **Neo4j**, **Google Gemini GenAI**, **React**, and **Node.js**, this system specializes in auditing and exploring complex enterprise supply chain and document workflows (Sales Orders, Delivery Documents, Billing, and Accounting).

## Architecture
The system consists of two primary layers: a TypeScript `frontend` single-page application and a TypeScript `backend` API. 

### 1. Backend (Node.js + Express)
The backend acts as the Orchestrator for the system processing pipeline:
- **LLM Translation Layer (`@google/generative-ai`)**: Intercepts natural language inputs, contextualizes them using a hard-coded generic Graph Schema, and utilizes Google Gemini to output purely read-only Cypher queries. It utilizes few-shot prompting techniques to teach the LLM about business-flow topologies (e.g., "delivered but not billed" requires checking the absence of `:BILLED_IN` relationships).
- **Execution Engine (`neo4j-driver`)**: Receives the LLM-generated Cypher, rigorously applies security assertions (denying any modifying commands like `CREATE`, `DELETE`, `MERGE`), and executes it against the remote Neo4j Graph Database.
- **Answer Synthesizer**: Pipes the JSON output from Neo4j back into the LLM context to construct a natural-language "Answer," ensuring responses are fully grounded in accurate data without hallucinating missing records.
- **Graph Expansion Engine**: Dedicated endpoint (`/graph/neighborhood`) resolving precise relational radii to fetch 2D coordinates and metadata required for interactive UI rendering.

### 2. Frontend (React + Vite)
A highly responsive, grid-based dashboard for interactive querying:
- **Natural Language Input & Memory**: A left-hand prompt area alongside conversation history logic mapping previous UI boundaries.
- **Interactive Force-Directed Graph (`react-force-graph-2d`)**: Dynamically measures container dimensions via `ResizeObserver` to plot node coordinates in real-time, displaying a web of elements categorized by node label colors and connection weight. Supports click-expansion (double-click node to query neighborhood) and right-click metadata inspection.
- **Cypher & Results Traceability**: Raw underlying Cypher logic and row-based JSON returns are visibly surfaced to the user to maintain complete system transparency.

## Domain Model (Neo4j Schema)
The system leverages a supply chain / ERP topology.
**Core Entities:**
- `SalesOrder`, `DeliveryDocument`, `BillingDocument`, `JournalEntryDocument`
- `Product`, `Customer`, `Plant`, `StorageLocation`, `Address`

**Key Business Relationship Paths:**
- `(:SalesOrder)-[:HAS_DELIVERY]->(:DeliveryDocument)`
- `(:DeliveryDocument)-[:BILLED_IN]->(:BillingDocument)`
- `(:BillingDocument)-[:HAS_JOURNAL_ENTRY]->(:JournalEntryDocument)`
- `(:Product)-[:AVAILABLE_IN_PLANT]->(:Plant)`

## Setup and Installation

### Prerequisites
- Node.js environment (v18+)
- Neo4j Instance (AuraDB or local Desktop)
- Gemini API Key

### Backend Configuration
1. Navigate to `backend/`:
   ```bash
   cd backend
   npm install
   ```
2. Create `.env` file referencing your Graph DB and API credentials:
   ```env
   NEO4J_URI=bolt://your-neo4j-uri
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=your_secure_password
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-2.5-flash # Optional, specify preferred model
   PORT=5000
   ```
3. Run Data Ingestion (initializes your Neo4j instance):
   ```bash
   npm run ingest
   ```
4. Start the backend development server:
   ```bash
   npm run dev
   ```

### Frontend Configuration
1. Navigate to `frontend/`:
   ```bash
   cd frontend
   npm install
   ```
2. Start the Vite server:
   ```bash
   npm run dev
   ```

## Development Workflow
The frontend makes iterative calls to the following key backend endpoints:
- `POST /query/nl-answer` - Solves Natural Language translation, execution, and synthesis asynchronously.
- `POST /query/cypher` - Permits exact manual Cypher statements without invoking LLM pipelines.
- `GET /graph/neighborhood` - Given a seed `NodeKey`, computes graph arrays `[Nodes]` and `[Edges]` limit bounded to 300 to render in standard React components.