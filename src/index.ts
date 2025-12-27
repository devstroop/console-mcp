#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";

// Store active log streams
const activeStreams: Map<string, ReturnType<typeof spawn>> = new Map();

// Get list of connected iOS devices
function getConnectedDevices(): Array<{ udid: string; name: string; model: string }> {
  try {
    const output = execSync("xcrun devicectl list devices 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10000,
    });
    
    const devices: Array<{ udid: string; name: string; model: string }> = [];
    const lines = output.split("\n").slice(2); // Skip header lines
    
    for (const line of lines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 4) {
        devices.push({
          name: parts[0],
          udid: parts[2],
          model: parts[4] || "Unknown",
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

// Get iOS device logs using devicectl
async function getDeviceLogs(
  udid: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    try {
      // Use log show with predicate for iOS device
      // Note: This requires the device to be paired and connected
      const args = [
        "devicectl",
        "device",
        "process",
        "getlog",
        "--device",
        udid,
      ];
      
      // Fallback: use simctl for simulators or idevicesyslog
      // For real devices, we'll use a different approach
      
      // Try using `log` command which can access device logs if device is connected
      const logArgs = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
      
      if (process) {
        logArgs.push("--predicate", `processImagePath CONTAINS "${process}"`);
      }
      
      const child = spawn("log", logArgs, {
        timeout: 30000,
      });
      
      let output = "";
      let lineCount = 0;
      
      child.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (lineCount < maxLines) {
            output += line + "\n";
            lineCount++;
          }
        }
      });
      
      child.stderr.on("data", (data: Buffer) => {
        output += `[stderr] ${data.toString()}`;
      });
      
      child.on("close", () => {
        resolve(output || "No logs found");
      });
      
      child.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        child.kill();
        resolve(output || "Timeout waiting for logs");
      }, 10000);
      
    } catch (err) {
      resolve(`Error: ${err}`);
    }
  });
}

// Get macOS system logs
async function getMacLogs(
  subsystem?: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    const args = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
    
    const predicates: string[] = [];
    if (subsystem) {
      predicates.push(`subsystem == "${subsystem}"`);
    }
    if (process) {
      predicates.push(`processImagePath CONTAINS "${process}"`);
    }
    
    if (predicates.length > 0) {
      args.push("--predicate", predicates.join(" AND "));
    }
    
    const child = spawn("log", args);
    let output = "";
    let lineCount = 0;
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += `[stderr] ${data.toString()}`;
    });
    
    child.on("close", () => {
      resolve(output || "No logs found");
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout");
    }, 15000);
  });
}

// Stream logs from iOS device using idevicesyslog (if available) or log stream
async function streamDeviceLogs(
  udid: string,
  process?: string,
  durationSeconds: number = 10
): Promise<string> {
  return new Promise((resolve) => {
    // Try idevicesyslog first (from libimobiledevice)
    let child: ReturnType<typeof spawn>;
    let output = "";
    
    try {
      // Check if idevicesyslog is available
      execSync("which idevicesyslog", { encoding: "utf-8" });
      
      const args = ["-u", udid];
      if (process) {
        args.push("-p", process);
      }
      
      child = spawn("idevicesyslog", args);
    } catch {
      // Fallback to xcrun devicectl or log stream
      const args = ["stream", "--style", "compact"];
      if (process) {
        args.push("--predicate", `processImagePath CONTAINS "${process}"`);
      }
      child = spawn("log", args);
    }
    
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    // Stop after duration
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output || "No logs captured during stream");
    }, durationSeconds * 1000);
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// Search logs
async function searchLogs(
  query: string,
  lastMinutes: number = 30,
  maxLines: number = 100
): Promise<string> {
  return new Promise((resolve) => {
    const args = ["show", "--last", `${lastMinutes}m`, "--style", "compact"];
    
    const child = spawn("log", args);
    let output = "";
    let lineCount = 0;
    const queryLower = query.toLowerCase();
    
    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.toLowerCase().includes(queryLower) && lineCount < maxLines) {
          output += line + "\n";
          lineCount++;
        }
      }
    });
    
    child.on("close", () => {
      resolve(output || `No logs matching "${query}" found`);
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout");
    }, 30000);
  });
}

// Create the MCP server
const server = new Server(
  {
    name: "console-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_devices",
        description: "List connected iOS devices",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_logs",
        description: "Get recent logs from macOS or connected iOS device. Use for debugging apps.",
        inputSchema: {
          type: "object",
          properties: {
            process: {
              type: "string",
              description: "Filter by process name (e.g., 'WorxVPNExtension', 'Safari')",
            },
            subsystem: {
              type: "string",
              description: "Filter by subsystem (e.g., 'com.worxvpn.ios')",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum number of log lines to return (default: 200)",
            },
          },
          required: [],
        },
      },
      {
        name: "stream_logs",
        description: "Stream live logs for a specified duration. Useful for capturing logs during an action.",
        inputSchema: {
          type: "object",
          properties: {
            process: {
              type: "string",
              description: "Filter by process name",
            },
            durationSeconds: {
              type: "number",
              description: "How long to stream logs (default: 10 seconds, max: 30)",
            },
          },
          required: [],
        },
      },
      {
        name: "search_logs",
        description: "Search through recent logs for a specific string or pattern",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text to search for in logs (case-insensitive)",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to search (default: 30)",
            },
            maxLines: {
              type: "number",
              description: "Maximum matching lines to return (default: 100)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_vpn_logs",
        description: "Get logs specifically for WorxVPN extension - filters for VPN-related processes",
        inputSchema: {
          type: "object",
          properties: {
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum number of log lines (default: 300)",
            },
          },
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case "list_devices": {
        const devices = getConnectedDevices();
        if (devices.length === 0) {
          return {
            content: [{ type: "text", text: "No iOS devices connected" }],
          };
        }
        const deviceList = devices
          .map((d) => `📱 ${d.name}\n   UDID: ${d.udid}\n   Model: ${d.model}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: deviceList }],
        };
      }
      
      case "get_logs": {
        const process = args?.process as string | undefined;
        const subsystem = args?.subsystem as string | undefined;
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 200;
        
        const logs = await getMacLogs(subsystem, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "stream_logs": {
        const process = args?.process as string | undefined;
        const duration = Math.min((args?.durationSeconds as number) || 10, 30);
        
        const logs = await streamDeviceLogs("", process, duration);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "search_logs": {
        const query = args?.query as string;
        const lastMinutes = (args?.lastMinutes as number) || 30;
        const maxLines = (args?.maxLines as number) || 100;
        
        if (!query) {
          return {
            content: [{ type: "text", text: "Error: query is required" }],
          };
        }
        
        const logs = await searchLogs(query, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      case "get_vpn_logs": {
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 300;
        
        // Get logs for VPN-related processes
        const logs = await getMacLogs(
          undefined,
          "WorxVPN",
          lastMinutes,
          maxLines
        );
        return {
          content: [{ type: "text", text: logs }],
        };
      }
      
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Console MCP server running");
}

main().catch(console.error);
