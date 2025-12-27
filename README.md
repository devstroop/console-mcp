# Console MCP Server

An MCP (Model Context Protocol) server for accessing macOS and iOS device logs directly from VS Code / Copilot.

## Features

- **Get Logs** - Fetch recent logs filtered by process or subsystem
- **Stream Logs** - Capture live logs for a specified duration
- **Search Logs** - Search through historical logs for specific strings
- **List Devices** - Show connected iOS devices
- **VPN Logs** - Quick shortcut to get WorxVPN-specific logs

## Installation

```bash
cd /Users/itsalfredakku/McpServers/console-mcp
npm install
npm run build
```

### For iOS Device Logs

Install libimobiledevice for direct iOS device log streaming:

```bash
brew install libimobiledevice
```

## Configuration

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "console": {
      "command": "node",
      "args": ["/Users/itsalfredakku/McpServers/console-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### `list_devices`
List connected iOS devices with their UDIDs.

### `get_logs`
Get recent logs from macOS.

| Parameter | Type | Description |
|-----------|------|-------------|
| `process` | string | Filter by process name (e.g., 'Safari') |
| `subsystem` | string | Filter by subsystem (e.g., 'com.apple.network') |
| `lastMinutes` | number | Minutes of logs to fetch (default: 5) |
| `maxLines` | number | Max lines to return (default: 200) |

### `stream_logs`
Stream live logs for a duration.

| Parameter | Type | Description |
|-----------|------|-------------|
| `process` | string | Filter by process name |
| `durationSeconds` | number | How long to stream (default: 10, max: 30) |

### `search_logs`
Search through recent logs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Text to search for (case-insensitive) |
| `lastMinutes` | number | Minutes to search (default: 30) |
| `maxLines` | number | Max matching lines (default: 100) |

### `get_vpn_logs`
Shortcut to get WorxVPN extension logs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `lastMinutes` | number | Minutes of logs (default: 5) |
| `maxLines` | number | Max lines (default: 300) |

## Usage Examples

```
// In Copilot chat:
"Get the last 5 minutes of Safari logs"
"Search logs for 'error' in the last hour"
"Stream logs for 15 seconds while I reproduce the bug"
"Show me WorxVPN logs"
```

## Notes

- macOS `log` command is used for local logs
- `idevicesyslog` from libimobiledevice is used for iOS device logs
- iOS device must be paired and trusted for log access

## License

MIT
