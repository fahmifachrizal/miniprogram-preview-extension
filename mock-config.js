const fs = require('fs');
const path = require('path');

// The project's API mocks, .mini-ide/mockConfig.json: {active, rules}. Shared by the API Mock view and
// the MCP server; the simulator watches the file and applies changes live (lyra-ui-server.js).

const mockFile = (projectPath) => path.join(projectPath, '.mini-ide', 'mockConfig.json');

function readConfig(projectPath) {
  try {
    const config = JSON.parse(fs.readFileSync(mockFile(projectPath), 'utf8'));
    if (config && Array.isArray(config.rules)) return { active: Boolean(config.active), rules: config.rules };
  } catch (e) { /* none yet */ }
  return { active: false, rules: [] };
}

// Writes the file and returns the text written
function writeConfig(projectPath, config) {
  const file = mockFile(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ active: Boolean(config.active), rules: config.rules || [] }, null, 2) + '\n';
  fs.writeFileSync(file, text);
  return text;
}

const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = { mockFile, readConfig, writeConfig, newUid };
