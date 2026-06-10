# MCP Research Agent

A ProAgentStore research worker created and operated through MCP.

## Endpoints

- `GET /` - status and capabilities
- `POST /research` - research a topic from Wikipedia discovery or supplied URLs
- `POST /chat` - chat-compatible research endpoint

## Example

```bash
curl https://mcp-research-agent-232347.proagentstore.online/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"Model Context Protocol"}'
```
