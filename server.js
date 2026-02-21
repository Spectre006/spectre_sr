const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { XMLParser } = require("fast-xml-parser");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

const TABLE_NAME = process.env.DB_TABLE || "SR";
const COL_TICKETID = process.env.DB_COL_TICKETID || process.env.DB_COL_SRNUM || "TICKETID";
const COL_DESCRIPTION = process.env.DB_COL_DESCRIPTION || "DESCRIPTION";
const COL_STATUS = process.env.DB_COL_STATUS || "STATUS";
const SOAP_NAMESPACE = process.env.SOAP_NAMESPACE || "http://www.ibm.com/maximo";

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function sanitizeConnectionString(rawValue) {
  if (!rawValue) return rawValue;
  try {
    const parsed = new URL(rawValue);
    // If sslmode is present, pg may prioritize it over the ssl object.
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch (_error) {
    // Keep original when URL parsing fails (for unusual but valid DSN shapes).
    return rawValue;
  }
}

const tableIdent = quoteIdent(TABLE_NAME);
const ticketidIdent = quoteIdent(COL_TICKETID);
const descriptionIdent = quoteIdent(COL_DESCRIPTION);
const statusIdent = quoteIdent(COL_STATUS);

const sslEnabled = parseBoolean(process.env.DB_SSL, true);
const sslRejectUnauthorized = parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, false);
const sslCa = process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, "\n") : undefined;
const sslConfig = sslEnabled
  ? {
      rejectUnauthorized: sslRejectUnauthorized,
      ...(sslCa ? { ca: sslCa } : {})
    }
  : false;

const pool = new Pool({
  connectionString: sanitizeConnectionString(process.env.DATABASE_URL),
  ssl: sslConfig
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
});

app.use(express.json());
app.use(express.text({ type: ["text/xml", "application/soap+xml"] }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeRecord(input) {
  return {
    ticketid: String(input?.ticketid || input?.srnum || "").trim(),
    description: String(input?.description || "").trim(),
    status: String(input?.status || "").trim()
  };
}

function validateRecord(record) {
  const errors = [];

  if (!record.ticketid) errors.push("TICKETID is required.");
  if (record.ticketid.length > 10) errors.push("TICKETID max length is 10.");
  if (record.description.length > 100) errors.push("DESCRIPTION max length is 100.");
  if (record.status.length > 10) errors.push("STATUS max length is 10.");

  return errors;
}

async function fetchAllSR() {
  const query = `
    SELECT
      ${ticketidIdent} AS ticketid,
      ${descriptionIdent} AS description,
      ${statusIdent} AS status
    FROM ${tableIdent}
    ORDER BY ${ticketidIdent} ASC
  `;
  const result = await pool.query(query);
  return result.rows;
}

async function fetchSingleSR(ticketid) {
  const query = `
    SELECT
      ${ticketidIdent} AS ticketid,
      ${descriptionIdent} AS description,
      ${statusIdent} AS status
    FROM ${tableIdent}
    WHERE ${ticketidIdent} = $1
  `;
  const result = await pool.query(query, [ticketid]);
  return result.rows[0] || null;
}

async function upsertSR(record) {
  const query = `
    INSERT INTO ${tableIdent} (${ticketidIdent}, ${descriptionIdent}, ${statusIdent})
    VALUES ($1, $2, $3)
    ON CONFLICT (${ticketidIdent})
    DO UPDATE SET
      ${descriptionIdent} = EXCLUDED.${descriptionIdent},
      ${statusIdent} = EXCLUDED.${statusIdent}
    RETURNING
      ${ticketidIdent} AS ticketid,
      ${descriptionIdent} AS description,
      ${statusIdent} AS status
  `;

  const result = await pool.query(query, [record.ticketid, record.description, record.status]);
  return result.rows[0];
}

function stripPrefix(tagName) {
  return String(tagName).includes(":") ? String(tagName).split(":")[1] : String(tagName);
}

function getNodeByName(obj, targetName) {
  if (!obj || typeof obj !== "object") return null;
  const key = Object.keys(obj).find(
    (k) => stripPrefix(k).toLowerCase() === String(targetName).toLowerCase()
  );
  return key ? obj[key] : null;
}

function getSoapOperation(soapXml) {
  const parsed = xmlParser.parse(soapXml);
  const envelope = getNodeByName(parsed, "Envelope");
  const body = getNodeByName(envelope, "Body");
  if (!body || typeof body !== "object") return null;

  const operationKey = Object.keys(body).find((k) => !k.startsWith("@_"));
  if (!operationKey) {
    return {
      operationName: "",
      payload: {},
      body
    };
  }

  return {
    operationName: stripPrefix(operationKey),
    payload: body[operationKey],
    body
  };
}

function readField(payload, fieldName) {
  const target = String(fieldName).toLowerCase();

  function readFieldRecursive(node, depth = 0) {
    if (node === null || node === undefined || depth > 8) return "";

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = readFieldRecursive(item, depth + 1);
        if (found) return found;
      }
      return "";
    }

    if (typeof node !== "object") return "";

    const directKey = Object.keys(node).find((k) => stripPrefix(k).toLowerCase() === target);
    if (directKey) {
      const value = node[directKey];
      if (value === null || value === undefined) return "";
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value).trim();
      }
      if (typeof value === "object") {
        const textKey = Object.keys(value).find((k) => k.toLowerCase() === "#text");
        if (textKey) return String(value[textKey] ?? "").trim();
      }
    }

    for (const key of Object.keys(node)) {
      if (key.startsWith("@_")) continue;
      const found = readFieldRecursive(node[key], depth + 1);
      if (found) return found;
    }

    return "";
  }

  return readFieldRecursive(payload);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function soapEnvelope(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sr="${SOAP_NAMESPACE}">
  <soapenv:Body>
    ${innerXml}
  </soapenv:Body>
</soapenv:Envelope>`;
}

function soapFault(message, faultCode = "soapenv:Client") {
  return soapEnvelope(`
<soapenv:Fault>
  <faultcode>${escapeXml(faultCode)}</faultcode>
  <faultstring>${escapeXml(message)}</faultstring>
</soapenv:Fault>`);
}

function buildGetSRResponse(records) {
  const rows = records
    .map(
      (record) => `
<sr:SR>
  <sr:TICKETID>${escapeXml(record.ticketid)}</sr:TICKETID>
  <sr:DESCRIPTION>${escapeXml(record.description)}</sr:DESCRIPTION>
  <sr:STATUS>${escapeXml(record.status)}</sr:STATUS>
</sr:SR>`
    )
    .join("");

  return soapEnvelope(`
<sr:GetSRResponse>
  <sr:SRList>${rows}</sr:SRList>
</sr:GetSRResponse>`);
}

function buildPostSRResponse(record) {
  return soapEnvelope(`
<sr:PostSRResponse>
  <sr:Result>SUCCESS</sr:Result>
  <sr:TICKETID>${escapeXml(record.ticketid)}</sr:TICKETID>
</sr:PostSRResponse>`);
}

function normalizedObjectKeys(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .filter((k) => !k.startsWith("@_"))
    .map((k) => stripPrefix(k).toLowerCase());
}

function containsSRFields(obj) {
  const keys = normalizedObjectKeys(obj);
  return keys.includes("ticketid") || keys.includes("srnum") || keys.includes("description") || keys.includes("status");
}

function findSRPayload(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  if (containsSRFields(obj)) return obj;

  for (const key of Object.keys(obj)) {
    if (key.startsWith("@_")) continue;
    const value = obj[key];
    if (value && typeof value === "object") {
      const found = findSRPayload(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function inferSoapOperation(operation, soapActionHeader) {
  const known = new Set(["getsr", "getsrrequest", "postsr", "postsrrequest"]);
  const directOp = String(operation.operationName || "").toLowerCase();
  const likelyPayload = findSRPayload(operation.payload) || findSRPayload(operation.body) || operation.payload;
  if (known.has(directOp)) {
    return { op: directOp, payload: likelyPayload };
  }

  if (directOp.includes("post") && directOp.includes("sr")) {
    return { op: "postsrrequest", payload: likelyPayload };
  }
  if (directOp.includes("get") && directOp.includes("sr")) {
    return { op: "getsrrequest", payload: likelyPayload };
  }

  const body = operation.body || {};
  const bodyKeys = normalizedObjectKeys(body);
  const hasDirectFields = bodyKeys.some(
    (k) => k === "ticketid" || k === "srnum" || k === "description" || k === "status"
  );
  if (hasDirectFields) {
    const isPostLike = bodyKeys.includes("description") || bodyKeys.includes("status");
    return { op: isPostLike ? "postsrrequest" : "getsrrequest", payload: body };
  }

  const soapAction = String(soapActionHeader || "").replace(/"/g, "").toLowerCase();
  if (soapAction.includes("postsr")) return { op: "postsrrequest", payload: likelyPayload };
  if (soapAction.includes("getsr")) return { op: "getsrrequest", payload: likelyPayload };

  if (containsSRFields(likelyPayload)) {
    const payloadKeys = normalizedObjectKeys(likelyPayload);
    const isPostLike = payloadKeys.includes("description") || payloadKeys.includes("status");
    return { op: isPostLike ? "postsrrequest" : "getsrrequest", payload: likelyPayload };
  }

  return { op: directOp, payload: likelyPayload };
}

function sendSoapFault(res, message, statusCode = 200, faultCode = "soapenv:Client") {
  return res.status(statusCode).type("text/xml").send(soapFault(message, faultCode));
}

function buildWsdl(serviceUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions
  name="SRService"
  targetNamespace="${SOAP_NAMESPACE}"
  xmlns:tns="${SOAP_NAMESPACE}"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns="http://schemas.xmlsoap.org/wsdl/">

  <types>
    <xsd:schema targetNamespace="${SOAP_NAMESPACE}">
      <xsd:complexType name="SRType">
        <xsd:sequence>
          <xsd:element name="TICKETID" type="xsd:string"/>
          <xsd:element name="DESCRIPTION" type="xsd:string"/>
          <xsd:element name="STATUS" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>

  <message name="GetSRRequest">
    <part name="TICKETID" type="xsd:string"/>
  </message>
  <message name="GetSRResponse">
    <part name="result" type="xsd:string"/>
  </message>
  <message name="PostSRRequest">
    <part name="TICKETID" type="xsd:string"/>
    <part name="DESCRIPTION" type="xsd:string"/>
    <part name="STATUS" type="xsd:string"/>
  </message>
  <message name="PostSRResponse">
    <part name="result" type="xsd:string"/>
  </message>

  <portType name="SRServicePortType">
    <operation name="GetSR">
      <input message="tns:GetSRRequest"/>
      <output message="tns:GetSRResponse"/>
    </operation>
    <operation name="PostSR">
      <input message="tns:PostSRRequest"/>
      <output message="tns:PostSRResponse"/>
    </operation>
  </portType>

  <binding name="SRServiceBinding" type="tns:SRServicePortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetSR">
      <soap:operation soapAction="GetSR"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
    <operation name="PostSR">
      <soap:operation soapAction="PostSR"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>

  <service name="SRService">
    <port name="SRServicePort" binding="tns:SRServiceBinding">
      <soap:address location="${serviceUrl}"/>
    </port>
  </service>
</definitions>`;
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      hint: error.hint || null
    });
  }
});

app.get("/api/sr", async (req, res) => {
  try {
    const ticketid = String(req.query.ticketid || req.query.srnum || "").trim();
    if (ticketid) {
      const row = await fetchSingleSR(ticketid);
      if (!row) return res.status(404).json({ error: "SR not found" });
      return res.json([row]);
    }

    const rows = await fetchAllSR();
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/sr", async (req, res) => {
  try {
    const record = normalizeRecord(req.body);
    const errors = validateRecord(record);
    if (errors.length) return res.status(400).json({ errors });

    const saved = await upsertSR(record);
    return res.status(201).json(saved);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/soap/sr", (req, res) => {
  if (req.query.wsdl === undefined) {
    return res.status(400).send("Append ?wsdl to fetch the service definition.");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const serviceUrl = `${protocol}://${req.get("host")}/soap/sr`;
  const wsdl = buildWsdl(serviceUrl);

  res.type("text/xml").send(wsdl);
});

app.post("/soap/sr", async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("xml")) {
      return res.status(415).send("SOAP endpoint expects XML.");
    }

    const operation = getSoapOperation(req.body);
    if (!operation) {
      return sendSoapFault(res, "Invalid SOAP envelope.");
    }

    const resolved = inferSoapOperation(operation, req.headers.soapaction);
    const op = resolved.op;
    const payload = resolved.payload;

    if (op === "getsr" || op === "getsrrequest") {
      const ticketid = readField(payload, "TICKETID") || readField(payload, "SRNUM");
      const rows = ticketid ? [await fetchSingleSR(ticketid)].filter(Boolean) : await fetchAllSR();
      return res.type("text/xml").send(buildGetSRResponse(rows));
    }

    if (op === "postsr" || op === "postsrrequest") {
      const record = normalizeRecord({
        ticketid: readField(payload, "TICKETID") || readField(payload, "SRNUM"),
        description: readField(payload, "DESCRIPTION"),
        status: readField(payload, "STATUS")
      });
      const errors = validateRecord(record);
      if (errors.length) {
        return sendSoapFault(res, errors.join(" "));
      }

      const saved = await upsertSR(record);
      return res.type("text/xml").send(buildPostSRResponse(saved));
    }

    return sendSoapFault(res, `Unsupported operation: ${operation.operationName || "unknown"}`);
  } catch (error) {
    return sendSoapFault(res, error.message, 500, "soapenv:Server");
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`SR app listening on http://localhost:${port}`);
});
