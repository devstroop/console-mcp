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

// Device/Simulator types
interface Device {
  udid: string;
  name: string;
  model: string;
  connectionType?: string;
}

interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

// Get list of connected iOS devices
function getConnectedDevices(): Device[] {
  try {
    const output = execSync("xcrun devicectl list devices 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10000,
    });
    
    const devices: Device[] = [];
    const lines = output.split("\n").slice(2); // Skip header lines
    
    for (const line of lines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 4) {
        devices.push({
          name: parts[0],
          udid: parts[2],
          model: parts[4] || "Unknown",
          connectionType: parts[1] || "Unknown",
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

// Get list of iOS Simulators
function getSimulators(): Simulator[] {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
      timeout: 10000,
    });
    
    const data = JSON.parse(output);
    const simulators: Simulator[] = [];
    
    for (const [runtime, devices] of Object.entries(data.devices)) {
      const runtimeName = runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " ");
      for (const device of devices as Array<{ udid: string; name: string; state: string; isAvailable: boolean }>) {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtimeName,
          isAvailable: device.isAvailable,
        });
      }
    }
    
    return simulators;
  } catch {
    return [];
  }
}

// Find simulator by name or UDID
function findSimulator(identifier: string): Simulator | undefined {
  const simulators = getSimulators();
  return simulators.find(
    (s) => s.udid === identifier || s.name.toLowerCase() === identifier.toLowerCase()
  );
}

// Find device by name or UDID
function findDevice(identifier: string): Device | undefined {
  const devices = getConnectedDevices();
  return devices.find(
    (d) => d.udid === identifier || d.name.toLowerCase() === identifier.toLowerCase()
  );
}

// Get iOS device logs using idevicesyslog or devicectl
async function getDeviceLogs(
  udid: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    let lineCount = 0;
    
    // Check if idevicesyslog is available (preferred for real-time)
    let hasIdevicesyslog = false;
    try {
      execSync("which idevicesyslog", { encoding: "utf-8" });
      hasIdevicesyslog = true;
    } catch {
      hasIdevicesyslog = false;
    }
    
    if (hasIdevicesyslog) {
      // Use idevicesyslog for real device logs
      const args = ["-u", udid];
      if (process) {
        args.push("-m", process); // Match process name
      }
      
      const child = spawn("idevicesyslog", args);
      
      child.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (lineCount < maxLines && line.trim()) {
            output += line + "\n";
            lineCount++;
          }
        }
      });
      
      child.stderr.on("data", (data: Buffer) => {
        const errMsg = data.toString();
        if (!errMsg.includes("waiting")) {
          output += `[stderr] ${errMsg}`;
        }
      });
      
      // Collect for a short duration since idevicesyslog is real-time
      const collectDuration = Math.min(lastMinutes * 1000, 10000); // Max 10 seconds
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(output || `No logs captured from device ${udid}`);
      }, collectDuration);
      
      child.on("error", (err) => {
        resolve(`Error: ${err.message}\n\nMake sure the device is connected and trusted.`);
      });
    } else {
      // Fallback message - suggest installing libimobiledevice
      resolve(
        `⚠️ idevicesyslog not found.\n\n` +
        `To get iOS device logs, install libimobiledevice:\n` +
        `  brew install libimobiledevice\n\n` +
        `Then ensure your device is:\n` +
        `  1. Connected via USB\n` +
        `  2. Unlocked\n` +
        `  3. Trusted (tap "Trust" on device when prompted)`
      );
    }
  });
}

// Get iOS Simulator logs
async function getSimulatorLogs(
  udid: string,
  process?: string,
  lastMinutes: number = 5,
  maxLines: number = 200
): Promise<string> {
  return new Promise((resolve) => {
    // Simulator logs are in ~/Library/Logs/CoreSimulator/{UDID}/system.log
    // But we can also use `xcrun simctl spawn` to run log command inside simulator
    
    // First, check if simulator is booted
    const simulator = findSimulator(udid);
    if (!simulator) {
      resolve(`Simulator with identifier "${udid}" not found`);
      return;
    }
    
    if (simulator.state !== "Booted") {
      resolve(
        `Simulator "${simulator.name}" is not running (state: ${simulator.state}).\n` +
        `Boot it first with: xcrun simctl boot "${simulator.udid}"`
      );
      return;
    }
    
    // Use log command with simulator predicate
    const args = [
      "show",
      "--last", `${lastMinutes}m`,
      "--style", "compact",
      "--predicate", `subsystem CONTAINS "com.apple" AND simulatorIdentifier == "${udid}"`
    ];
    
    // Alternative: Use xcrun simctl spawn to run log inside simulator
    const spawnArgs = [
      "simctl", "spawn", udid,
      "log", "show",
      "--last", `${lastMinutes}m`,
      "--style", "compact"
    ];
    
    if (process) {
      spawnArgs.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }
    
    const child = spawn("xcrun", spawnArgs);
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
      resolve(output || `No logs found for simulator ${simulator.name}`);
    });
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
    
    setTimeout(() => {
      child.kill();
      resolve(output || "Timeout waiting for simulator logs");
    }, 15000);
  });
}

// Stream simulator logs in real-time
async function streamSimulatorLogs(
  udid: string,
  process?: string,
  durationSeconds: number = 10
): Promise<string> {
  return new Promise((resolve) => {
    const simulator = findSimulator(udid);
    if (!simulator) {
      resolve(`Simulator with identifier "${udid}" not found`);
      return;
    }
    
    if (simulator.state !== "Booted") {
      resolve(
        `Simulator "${simulator.name}" is not running.\n` +
        `Boot it first with: xcrun simctl boot "${simulator.udid}"`
      );
      return;
    }
    
    const spawnArgs = [
      "simctl", "spawn", udid,
      "log", "stream",
      "--style", "compact"
    ];
    
    if (process) {
      spawnArgs.push("--predicate", `processImagePath CONTAINS "${process}"`);
    }
    
    const child = spawn("xcrun", spawnArgs);
    let output = "";
    
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    
    setTimeout(() => {
      child.kill("SIGTERM");
      resolve(output || `No logs captured from simulator ${simulator.name}`);
    }, durationSeconds * 1000);
    
    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
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
        description: "List connected iOS devices (physical devices connected via USB)",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "list_simulators",
        description: "List available iOS Simulators with their state (Booted/Shutdown)",
        inputSchema: {
          type: "object",
          properties: {
            onlyBooted: {
              type: "boolean",
              description: "Only show running simulators (default: false)",
            },
            runtime: {
              type: "string",
              description: "Filter by runtime (e.g., 'iOS 17', 'iOS 18')",
            },
          },
          required: [],
        },
      },
      {
        name: "get_logs",
        description: "Get recent logs from macOS system. Use for debugging macOS apps.",
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
        name: "get_device_logs",
        description: "Get logs from a connected iOS device. Requires libimobiledevice (brew install libimobiledevice)",
        inputSchema: {
          type: "object",
          properties: {
            device: {
              type: "string",
              description: "Device name or UDID (use list_devices to find)",
            },
            process: {
              type: "string",
              description: "Filter by process/app name",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to capture (default: 5, max: 10)",
            },
            maxLines: {
              type: "number",
              description: "Maximum log lines (default: 200)",
            },
          },
          required: ["device"],
        },
      },
      {
        name: "get_simulator_logs",
        description: "Get logs from an iOS Simulator. The simulator must be booted.",
        inputSchema: {
          type: "object",
          properties: {
            simulator: {
              type: "string",
              description: "Simulator name or UDID (use list_simulators to find)",
            },
            process: {
              type: "string",
              description: "Filter by process/app name",
            },
            lastMinutes: {
              type: "number",
              description: "How many minutes of logs to fetch (default: 5)",
            },
            maxLines: {
              type: "number",
              description: "Maximum log lines (default: 200)",
            },
          },
          required: ["simulator"],
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
        name: "stream_simulator_logs",
        description: "Stream live logs from an iOS Simulator for a duration",
        inputSchema: {
          type: "object",
          properties: {
            simulator: {
              type: "string",
              description: "Simulator name or UDID",
            },
            process: {
              type: "string",
              description: "Filter by process name",
            },
            durationSeconds: {
              type: "number",
              description: "How long to stream (default: 10, max: 30)",
            },
          },
          required: ["simulator"],
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
            content: [{ type: "text", text: "No iOS devices connected.\n\nMake sure your device is:\n1. Connected via USB\n2. Unlocked\n3. Trusted (tap 'Trust' when prompted)" }],
          };
        }
        const deviceList = devices
          .map((d) => `📱 ${d.name}\n   UDID: ${d.udid}\n   Model: ${d.model}\n   Connection: ${d.connectionType}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `Found ${devices.length} device(s):\n\n${deviceList}` }],
        };
      }
      
      case "list_simulators": {
        const onlyBooted = args?.onlyBooted as boolean | undefined;
        const runtimeFilter = args?.runtime as string | undefined;
        
        let simulators = getSimulators();
        
        if (simulators.length === 0) {
          return {
            content: [{ type: "text", text: "No simulators found. Make sure Xcode is installed." }],
          };
        }
        
        // Filter by booted state
        if (onlyBooted) {
          simulators = simulators.filter((s) => s.state === "Booted");
        }
        
        // Filter by runtime
        if (runtimeFilter) {
          simulators = simulators.filter((s) => 
            s.runtime.toLowerCase().includes(runtimeFilter.toLowerCase())
          );
        }
        
        if (simulators.length === 0) {
          return {
            content: [{ type: "text", text: "No simulators match the filter criteria." }],
          };
        }
        
        const simList = simulators
          .map((s) => {
            const status = s.state === "Booted" ? "🟢" : "⚪";
            return `${status} ${s.name} (${s.runtime})\n   UDID: ${s.udid}\n   State: ${s.state}`;
          })
          .join("\n\n");
        
        return {
          content: [{ type: "text", text: `Found ${simulators.length} simulator(s):\n\n${simList}` }],
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
      
      case "get_device_logs": {
        const deviceId = args?.device as string;
        const process = args?.process as string | undefined;
        const lastMinutes = Math.min((args?.lastMinutes as number) || 5, 10);
        const maxLines = (args?.maxLines as number) || 200;
        
        if (!deviceId) {
          return {
            content: [{ type: "text", text: "Error: device parameter is required. Use list_devices to find device name or UDID." }],
          };
        }
        
        const device = findDevice(deviceId);
        if (!device) {
          const devices = getConnectedDevices();
          if (devices.length === 0) {
            return {
              content: [{ type: "text", text: `Device "${deviceId}" not found. No devices are currently connected.` }],
            };
          }
          return {
            content: [{ 
              type: "text", 
              text: `Device "${deviceId}" not found.\n\nAvailable devices:\n${devices.map(d => `- ${d.name} (${d.udid})`).join("\n")}` 
            }],
          };
        }
        
        const logs = await getDeviceLogs(device.udid, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: `📱 Logs from ${device.name}:\n\n${logs}` }],
        };
      }
      
      case "get_simulator_logs": {
        const simulatorId = args?.simulator as string;
        const process = args?.process as string | undefined;
        const lastMinutes = (args?.lastMinutes as number) || 5;
        const maxLines = (args?.maxLines as number) || 200;
        
        if (!simulatorId) {
          return {
            content: [{ type: "text", text: "Error: simulator parameter is required. Use list_simulators to find simulator name or UDID." }],
          };
        }
        
        const simulator = findSimulator(simulatorId);
        if (!simulator) {
          const bootedSims = getSimulators().filter(s => s.state === "Booted");
          if (bootedSims.length === 0) {
            return {
              content: [{ type: "text", text: `Simulator "${simulatorId}" not found. No simulators are currently running.` }],
            };
          }
          return {
            content: [{ 
              type: "text", 
              text: `Simulator "${simulatorId}" not found.\n\nRunning simulators:\n${bootedSims.map(s => `- ${s.name} (${s.udid})`).join("\n")}` 
            }],
          };
        }
        
        const logs = await getSimulatorLogs(simulator.udid, process, lastMinutes, maxLines);
        return {
          content: [{ type: "text", text: `📱 Logs from ${simulator.name} (${simulator.runtime}):\n\n${logs}` }],
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
      
      case "stream_simulator_logs": {
        const simulatorId = args?.simulator as string;
        const process = args?.process as string | undefined;
        const duration = Math.min((args?.durationSeconds as number) || 10, 30);
        
        if (!simulatorId) {
          return {
            content: [{ type: "text", text: "Error: simulator parameter is required." }],
          };
        }
        
        const logs = await streamSimulatorLogs(simulatorId, process, duration);
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
