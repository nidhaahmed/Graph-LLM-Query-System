import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { glob } from "glob";
import { driver } from "../neo4j";

const DATA_ROOT = path.resolve(__dirname, "../../../Data_Folder");

const BATCH_SIZE = 500;

type AnyRow = Record<string, any>;

function getFolderName(filePath: string) {
  // .../Data_Folder/<folder>/part-xyz.jsonl
  return path.basename(path.dirname(filePath));
}

async function ingestSalesOrderHeaders(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (so:SalesOrder {salesOrder: row.salesOrder})
SET so.salesOrderType = row.salesOrderType,
    so.salesOrganization = row.salesOrganization,
    so.distributionChannel = row.distributionChannel,
    so.organizationDivision = row.organizationDivision,
    so.creationDate = row.creationDate,
    so.totalNetAmount = row.totalNetAmount,
    so.transactionCurrency = row.transactionCurrency
WITH so, row
FOREACH (_ IN CASE WHEN row.soldToParty IS NULL OR row.soldToParty = "" THEN [] ELSE [1] END |
  MERGE (c:Customer {customer: row.soldToParty})
  MERGE (so)-[:SOLD_TO]->(c)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestDeliveryItems(rows: AnyRow[]) {
  // Creates DeliveryDocument nodes and links SalesOrder -> DeliveryDocument
  const cypher = `
UNWIND $rows AS row
MERGE (d:DeliveryDocument {deliveryDocument: row.deliveryDocument})
SET d.shippingPoint = row.shippingPoint
WITH d, row
FOREACH (_ IN CASE WHEN row.referenceSdDocument IS NULL OR row.referenceSdDocument = "" THEN [] ELSE [1] END |
  MERGE (so:SalesOrder {salesOrder: row.referenceSdDocument})
  MERGE (so)-[:HAS_DELIVERY]->(d)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestBillingHeaders(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (b:BillingDocument {billingDocument: row.billingDocument})
SET b.billingDocumentType = row.billingDocumentType,
    b.billingDocumentDate = row.billingDocumentDate,
    b.transactionCurrency = row.transactionCurrency,
    b.totalNetAmount = row.totalNetAmount,
    b.billingDocumentIsCancelled = row.billingDocumentIsCancelled,
    b.companyCode = row.companyCode,
    b.fiscalYear = row.fiscalYear,
    b.accountingDocument = row.accountingDocument
WITH b, row
FOREACH (_ IN CASE WHEN row.soldToParty IS NULL OR row.soldToParty = "" THEN [] ELSE [1] END |
  MERGE (c:Customer {customer: row.soldToParty})
  MERGE (b)-[:SOLD_TO]->(c)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestBillingItems(rows: AnyRow[]) {
  // Links DeliveryDocument -> BillingDocument and Product -> BillingDocument
  const cypher = `
UNWIND $rows AS row
MERGE (b:BillingDocument {billingDocument: row.billingDocument})
WITH b, row

FOREACH (_ IN CASE WHEN row.referenceSdDocument IS NULL OR row.referenceSdDocument = "" THEN [] ELSE [1] END |
  MERGE (d:DeliveryDocument {deliveryDocument: row.referenceSdDocument})
  MERGE (d)-[:BILLED_IN]->(b)
)

FOREACH (_ IN CASE WHEN row.material IS NULL OR row.material = "" THEN [] ELSE [1] END |
  MERGE (p:Product {product: row.material})
  MERGE (p)-[:APPEARS_IN_BILLING]->(b)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestJournalAR(rows: AnyRow[]) {
  // Links BillingDocument -> JournalEntryDocument via referenceDocument=billingDocument
  const cypher = `
UNWIND $rows AS row
MERGE (j:JournalEntryDocument {accountingDocument: row.accountingDocument})
SET j.companyCode = row.companyCode,
    j.fiscalYear = row.fiscalYear,
    j.postingDate = row.postingDate,
    j.documentDate = row.documentDate,
    j.accountingDocumentType = row.accountingDocumentType
WITH j, row

FOREACH (_ IN CASE WHEN row.referenceDocument IS NULL OR row.referenceDocument = "" THEN [] ELSE [1] END |
  MERGE (b:BillingDocument {billingDocument: row.referenceDocument})
  MERGE (b)-[:HAS_JOURNAL_ENTRY]->(j)
)

FOREACH (_ IN CASE WHEN row.customer IS NULL OR row.customer = "" THEN [] ELSE [1] END |
  MERGE (c:Customer {customer: row.customer})
  MERGE (j)-[:CUSTOMER]->(c)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestBusinessPartners(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (c:Customer {customer: row.customer})
SET c.businessPartner = row.businessPartner,
    c.name = coalesce(row.businessPartnerFullName, row.businessPartnerName),
    c.isBlocked = row.businessPartnerIsBlocked,
    c.isArchived = row.isMarkedForArchiving
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestBusinessPartnerAddresses(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (a:Address {addressId: row.addressId})
SET a.country = row.country,
    a.region = row.region,
    a.cityName = row.cityName,
    a.postalCode = row.postalCode,
    a.streetName = row.streetName,
    a.timeZone = row.addressTimeZone
WITH a, row
MERGE (c:Customer {customer: row.businessPartner})
MERGE (c)-[:HAS_ADDRESS]->(a)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestProducts(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (p:Product {product: row.product})
SET p.productType = row.productType,
    p.productGroup = row.productGroup,
    p.baseUnit = row.baseUnit,
    p.grossWeight = row.grossWeight,
    p.netWeight = row.netWeight,
    p.weightUnit = row.weightUnit,
    p.isMarkedForDeletion = row.isMarkedForDeletion
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestProductDescriptions(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (p:Product {product: row.product})
SET p.description = row.productDescription
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestPlants(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (pl:Plant {plant: row.plant})
SET pl.plantName = row.plantName,
    pl.salesOrganization = row.salesOrganization,
    pl.distributionChannel = row.distributionChannel,
    pl.division = row.division,
    pl.language = row.language
WITH pl, row
FOREACH (_ IN CASE WHEN row.addressId IS NULL OR row.addressId = "" THEN [] ELSE [1] END |
  MERGE (a:Address {addressId: row.addressId})
  MERGE (pl)-[:HAS_ADDRESS]->(a)
)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestProductPlants(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (p:Product {product: row.product})
MERGE (pl:Plant {plant: row.plant})
MERGE (p)-[:AVAILABLE_IN_PLANT]->(pl)
`;
  await driver.executeQuery(cypher, { rows });
}

async function ingestProductStorageLocations(rows: AnyRow[]) {
  const cypher = `
UNWIND $rows AS row
MERGE (p:Product {product: row.product})
MERGE (pl:Plant {plant: row.plant})
MERGE (sl:StorageLocation {plant: row.plant, storageLocation: row.storageLocation})
MERGE (pl)-[:HAS_STORAGE_LOCATION]->(sl)
MERGE (p)-[:STORED_IN]->(sl)
`;
  await driver.executeQuery(cypher, { rows });
}



async function routeIngest(folder: string, rows: AnyRow[]) {
  switch (folder) {
    case "sales_order_headers":
      return ingestSalesOrderHeaders(rows);
    case "outbound_delivery_items":
      return ingestDeliveryItems(rows);
    case "billing_document_headers":
      return ingestBillingHeaders(rows);
    case "billing_document_items":
      return ingestBillingItems(rows);
    case "journal_entry_items_accounts_receivable":
      return ingestJournalAR(rows);
    // enrichment:
    case "business_partners":
      return ingestBusinessPartners(rows);
    case "business_partner_addresses":
      return ingestBusinessPartnerAddresses(rows);
    case "products":
      return ingestProducts(rows);
    case "product_descriptions":
      return ingestProductDescriptions(rows);
    case "plants":
      return ingestPlants(rows);
    case "product_plants":
      return ingestProductPlants(rows);
    case "product_storage_locations":
      return ingestProductStorageLocations(rows);
    default:
      // For Option A v0 we ignore other tables (we can add later)
      return;
  }
}

async function ingestFile(filePath: string) {
  const folder = getFolderName(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let batch: AnyRow[] = [];
  let count = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const row = JSON.parse(trimmed) as AnyRow;
    batch.push(row);
    count++;

    if (batch.length >= BATCH_SIZE) {
      await routeIngest(folder, batch);
      batch = [];
    }
  }

  if (batch.length) await routeIngest(folder, batch);

  console.log(
    `Ingested ${count} rows from ${folder} (${path.basename(filePath)})`,
  );
}

async function main() {
  console.log(`DATA_ROOT: ${DATA_ROOT}`);

  const files = await glob("**/part-*.jsonl", {
    cwd: DATA_ROOT,
    absolute: true,
    windowsPathsNoEscape: true,
  });

  // Only ingest the folders we use in Option A v0
  const allowed = new Set([
    "sales_order_headers",
    "outbound_delivery_items",
    "billing_document_headers",
    "billing_document_items",
    "journal_entry_items_accounts_receivable",
    // enrichment:
    "business_partners",
    "business_partner_addresses",
    "products",
    "product_descriptions",
    "plants",
    "product_plants",
    "product_storage_locations",
  ]);

  const filtered = files.filter((f) => allowed.has(getFolderName(f)));

  console.log(`Found ${filtered.length} jsonl shards to ingest`);

  try {
    for (const f of filtered) {
      await ingestFile(f);
    }
  } finally {
    await driver.close();
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
