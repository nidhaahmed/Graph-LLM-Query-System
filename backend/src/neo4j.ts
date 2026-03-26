import dotenv from "dotenv";
import neo4j from "neo4j-driver";

dotenv.config();

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USERNAME;
const password = process.env.NEO4J_PASSWORD;

if (!uri || !user || !password) {
  throw new Error(
    "Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD in .env",
  );
}

export const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
