// weather-mcp-v2/server-http.js
//
// Same weather tool as server.js, but exposed over HTTP instead of stdio.
// This is the "web-based" MCP pattern: the server runs standalone,
// independent of any one client, and listens on a port.
//
// Run:   node server-http.js
// Then a host connects to: http://localhost:3000/mcp

import express from "express";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Same tool declaration as the stdio version ---
const TOOLS = [
  {
    name: "get_weather",
    description:
      "Get the current weather for a city or location name. Returns " +
      "temperature, windspeed, and conditions.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name, e.g. 'Austin' or 'Austin, TX'",
        },
      },
      required: ["location"],
    },
  },
];

// --- Same Open-Meteo logic, unchanged ---
async function geocode(location) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    location
  )}&count=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error(`No location found for "${location}"`);
  }
  const { latitude, longitude, name, country } = data.results[0];
  return { latitude, longitude, name, country };
}

async function getForecast(latitude, longitude) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast fetch failed: ${res.status}`);
  const data = await res.json();
  return data.current_weather;
}

async function getWeather(location) {
  const place = await geocode(location);
  const weather = await getForecast(place.latitude, place.longitude);
  return {
    location: `${place.name}, ${place.country}`,
    temperature_C: weather.temperature,
    windspeed_kmh: weather.windspeed,
    observed_at: weather.time,
  };
}

// --- Build a fresh MCP Server + handlers (same as stdio version) ---
function createMcpServer() {
  const server = new Server(
    { name: "weather-mcp-http", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "get_weather") {
        const result = await getWeather(args.location);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --- THIS is the part that's different from the stdio version ---
// Instead of connecting to stdin/stdout, we stand up an HTTP server
// and hand each request to a StreamableHTTPServerTransport.
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // OAuth token requests are form-encoded

// --- OAuth 2.0 Client Credentials Grant ---
// Appian (and most enterprise clients) support this as one of two auth
// methods for MCP connected systems. The flow:
//   1. Client POSTs client_id + client_secret to /oauth/token
//   2. We verify them and hand back a short-lived access_token
//   3. Client sends that access_token as "Authorization: Bearer <token>"
//      on every call to /mcp
//   4. We check the token is one we issued and hasn't expired

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const TOKEN_TTL_SECONDS = 3600; // 1 hour

// In-memory token store: token string -> expiry timestamp (ms).
// Fine for a single-instance demo server; a real multi-instance deployment
// would use a shared store (Redis, DB) instead.
const issuedTokens = new Map();

function generateToken() {
  // 32 random bytes, hex-encoded -> a long, unguessable opaque token.
  return crypto.randomBytes(32).toString("hex");
}

// Clients can send credentials two ways per the OAuth spec:
//   - HTTP Basic Auth header: Authorization: Basic base64(client_id:client_secret)
//   - Or as fields in the POST body: client_id=...&client_secret=...
// Support both, since different platforms (Appian included) vary here.
function extractClientCredentials(req) {
  const authHeader = req.get("authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [id, secret] = decoded.split(":");
    return { clientId: id, clientSecret: secret };
  }
  return {
    clientId: req.body?.client_id,
    clientSecret: req.body?.client_secret,
  };
}

app.post("/oauth/token", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .json({ error: "server_error", error_description: "OAuth credentials not configured" });
  }

  const grantType = req.body?.grant_type;
  if (grantType !== "client_credentials") {
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only client_credentials is supported",
    });
  }

  const { clientId, clientSecret } = extractClientCredentials(req);
  if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
    return res.status(401).json({
      error: "invalid_client",
      error_description: "Client ID or secret is incorrect",
    });
  }

  const token = generateToken();
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
  issuedTokens.set(token, expiresAt);

  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
  });
});

function checkAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || !issuedTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid access token" });
  }

  const expiresAt = issuedTokens.get(token);
  if (Date.now() > expiresAt) {
    issuedTokens.delete(token); // clean up expired token
    return res.status(401).json({ error: "Unauthorized: access token expired" });
  }

  next();
}

app.post("/mcp", checkAuth, async (req, res) => {
  // Stateless mode: a fresh server + transport per request.
  // (A production version would keep sessions alive across requests.)
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Render (and most hosts) assign the port via env var — never hardcode it.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Weather MCP server listening on port ${PORT}`);
});
