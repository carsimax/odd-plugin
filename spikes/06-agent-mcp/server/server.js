// minimal MCP stdio server (newline-delimited JSON-RPC), one tool: ping
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oddsrv', version: '0.0.1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'ping', description: 'Returns ODD-MCP-PONG', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: 'ODD-MCP-PONG' }] } })
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no' } })
})
