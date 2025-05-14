const express = require('express');
const setupMCPServer = require('./netlify/mcp-server/index');

const app = express();
app.use('/mcp', setupMCPServer());

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
}); 