// weather-mcp-v2/server-http.js
//
// Same weather tool as server.js, but exposed over HTTP instead of stdio.
// This is the "web-based" MCP pattern: the server runs standalone,
// independent of any one client, and listens on a port.
//
// Run:   node server-http.js
// Then a host connects to: http://localhost:3000/mcp

import express from "express";
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

app.post("/mcp", async (req, res) => {
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Weather MCP server listening at http://localhost:${PORT}/mcp`);
});
