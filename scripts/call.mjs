// Usage: KUBECONFIG=... node scripts/call.mjs <tool> '<json args>'
// Calls a tool on the built server through a real MCP stdio client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs] = process.argv.slice(2);
let args = {};
if (rawArgs) {
  args = JSON.parse(rawArgs);
}
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
});
const client = new Client({ name: "call-script", version: "0" });
await client.connect(transport);
const result = await client.callTool({ name: tool, arguments: args });
for (const part of result.content) {
  console.log(part.text);
}
await client.close();
