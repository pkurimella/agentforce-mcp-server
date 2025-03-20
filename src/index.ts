import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";


const args = process.argv.slice(2); // Skip `node` and script name

if (args.length < 4) {
  console.error("Usage: Provide the following <sfOrgDomain> <clientId> <clientSecret> <agentId>");
  process.exit(1);
}

const [SF_ORG_DOMAIN, CLIENT_ID, CLIENT_SECRET, AGENT_ID] = args;

// Environment variables for API authentication
const SF_API_HOST = "https://api.salesforce.com";
// const SF_ORG_DOMAIN = process.env.SF_ORG_DOMAIN;
// const CLIENT_ID = process.env.CLIENT_ID;
// const CLIENT_SECRET = process.env.CLIENT_SECRET;
// const AGENT_ID = process.env.AGENT_ID;

// Global session ID storage
let sessionId: string | null = null;

// MCP Server Setup
const server = new McpServer({
  name: "agentforce-connector",
  version: "1.0.0",
});

// Function to authenticate and get an access token
async function getAccessToken() {
    if (!SF_ORG_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
      throw new Error("Missing required environment variables: SF_ORG_DOMAIN, CLIENT_ID, CLIENT_SECRET");
    }
  
    const url = `${SF_ORG_DOMAIN}/services/oauth2/token`;
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  
    const data = new URLSearchParams();
    data.append("grant_type", "client_credentials");
    data.append("client_id", CLIENT_ID);
    data.append("client_secret", CLIENT_SECRET);
  
    try {
      const response = await axios.post(url, data.toString(), { headers });
      
      if (!response.data.access_token) {
        throw new Error("Failed to obtain access token: No token received");
      }
  
      return response.data.access_token;
    } catch (error: unknown) {
        handleApiError(error, "Authentication failed");
      }
  }

  function handleApiError(error: unknown, contextMessage: string): never {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.error_description || 
                      error.response?.data?.message || 
                      error.message || 
                      "Unknown Axios error";
      throw new Error(`${contextMessage}: ${message}`);
    } else if (error instanceof Error) {
      throw new Error(`${contextMessage}: ${error.message}`);
    } else {
      throw new Error(`${contextMessage}: An unknown error occurred`);
    }
  }

// Tool to start a session with Agentforce
server.tool(
  "start-session",
  {},
  async () => {
    const token = await getAccessToken();
    const url = `${SF_API_HOST}/einstein/ai-agent/v1/agents/${AGENT_ID}/sessions`;
    
    const body = {
      externalSessionKey: new Date().toISOString(),
      instanceConfig: { endpoint: SF_ORG_DOMAIN },
      tz: "America/Los_Angeles",
      featureSupport: "Streaming",
      streamingCapabilities: { chunkTypes: ["Text"] },
      bypassUser: true,
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    try {
      const response = await axios.post(url, body, { headers });
      sessionId = response.data.sessionId;
      return {
        content: [{ type: "text", text: `Session started with ID: ${sessionId}` }],
      };
    } catch (error) {
        handleApiError(error, "Failed to start session");
    }
  }
);

// Tool to send a message to the Agentforce session
server.tool(
  "send-message",
  { message: z.string() },
  async ({ message }) => {
    if (!sessionId) {
      throw new Error("No active session. Start a session first.");
    }

    const token = await getAccessToken();
    const url = `${SF_API_HOST}/einstein/ai-agent/v1/sessions/${sessionId}/messages`;

    const body = {
      message: {
        sequenceId: Date.now(),
        type: "Text",
        text: message,
      },
      variables: [],
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    try {
      const response = await axios.post(url, body, { headers });
      return {
        content: [{ type: "text", text: response.data.messages[0]?.message || "No response from agent." }],
      };
    } catch (error) {
        handleApiError(error, "Failed to send message");
      
    }
  }
);

// Tool to end the session
server.tool(
  "end-session",
  {},
  async () => {
    if (!sessionId) {
      return { content: [{ type: "text", text: "No active session to end." }] };
    }

    const token = await getAccessToken();
    const url = `${SF_API_HOST}/einstein/ai-agent/v1/sessions/${sessionId}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      "x-session-end-reason": "UserRequest",
    };

    try {
      await axios.delete(url, { headers });
      sessionId = null;
      return { content: [{ type: "text", text: "Session ended successfully." }] };
    } catch (error) {
        handleApiError(error, "Failed to end session");
    }
  }
);

// Server Transport (Choose either Stdio or SSE)
// const transport = new SSEServerTransport("/messages");
// await server.connect(transport);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Agentforce MCP Server running on stdio");
  }
  
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });