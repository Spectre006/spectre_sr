# Spectre SR App

Single-page web app + backend service to read/write SR data from Supabase Postgres.

## What this includes

- SPA UI to view and save SR records.
- REST API:
  - `GET /api/sr`
  - `GET /api/sr?ticketid=<value>`
  - `POST /api/sr`
- SOAP endpoint (Maximo integration target):
  - `POST /soap/sr`
  - `GET /soap/sr?wsdl`

## SR schema

Table: `SR`

- `TICKETID` (ALN 10)
- `DESCRIPTION` (ALN 100)
- `STATUS` (ALN 10)

SQL file: `/Users/prashantsharma/Documents/GitHub/spectre_sr/sql/create_sr_table.sql`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Put your Supabase Postgres URL in `DATABASE_URL`.
   Use the Supabase pooler connection string (recommended for local/dev and IPv4 networks), for example:

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Do not include square brackets around password.

Set SOAP namespace (Maximo-friendly default):

```bash
SOAP_NAMESPACE=http://www.ibm.com/maximo
```

4. Start app:

```bash
npm start
```

5. Open:

`http://localhost:3000`

## REST examples

Create or update SR:

```bash
curl -X POST http://localhost:3000/api/sr \
  -H "Content-Type: application/json" \
  -d '{
    "ticketid":"SR10001",
    "description":"Pump vibration inspection",
    "status":"NEW"
  }'
```

Get all SR:

```bash
curl http://localhost:3000/api/sr
```

## SOAP examples

WSDL:

```bash
curl http://localhost:3000/soap/sr?wsdl
```

### PostSR

```bash
curl -X POST http://localhost:3000/soap/sr \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sr="http://www.ibm.com/maximo">
  <soapenv:Body>
    <sr:PostSRRequest>
      <sr:TICKETID>SR10002</sr:TICKETID>
      <sr:DESCRIPTION>Valve replacement follow-up</sr:DESCRIPTION>
      <sr:STATUS>WAPPR</sr:STATUS>
    </sr:PostSRRequest>
  </soapenv:Body>
</soapenv:Envelope>'
```

### GetSR (all)

```bash
curl -X POST http://localhost:3000/soap/sr \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sr="http://www.ibm.com/maximo">
  <soapenv:Body>
    <sr:GetSRRequest />
  </soapenv:Body>
</soapenv:Envelope>'
```

### GetSR (single TICKETID)

```bash
curl -X POST http://localhost:3000/soap/sr \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sr="http://www.ibm.com/maximo">
  <soapenv:Body>
    <sr:GetSRRequest>
      <sr:TICKETID>SR10002</sr:TICKETID>
    </sr:GetSRRequest>
  </soapenv:Body>
</soapenv:Envelope>'
```

## Notes for Maximo

- SOAP operations accepted by this service:
  - `GetSR` / `GetSRRequest`
  - `PostSR` / `PostSRRequest`
- Service returns SOAP Fault XML on validation or parsing errors.
- `POST /api/sr` and `PostSR` perform upsert behavior keyed by `TICKETID`.
- Backward compatibility: SOAP requests may still send `SRNUM`; service maps it to `TICKETID`.

## Troubleshooting

- Error: `getaddrinfo ENOTFOUND db.<project-ref>.supabase.co`
  - Cause: direct `db.` host often resolves only IPv6.
  - Fix: switch `DATABASE_URL` to Supabase pooler host (`*.pooler.supabase.com`) from your Supabase dashboard.

- Error: `self-signed certificate in certificate chain`
  - Cause: TLS chain is being validated against local trust store (common on corporate networks).
  - Fix in `.env`:
    - `DB_SSL=true`
    - `DB_SSL_REJECT_UNAUTHORIZED=false`
  - If you need strict validation, set `DB_SSL_REJECT_UNAUTHORIZED=true` and provide `DB_SSL_CA` (PEM).
