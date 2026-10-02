const fs = require('fs');
const path = require('path');

// Guidance for AI agents working on the project through the MCP server: a short built-in guide, plus the
// project's own .mini-ide/context.md (and .mini-ide/context/*.md), written by the user. Re-read on every
// request, so edits apply right away.

const contextFile = (projectPath) => path.join(projectPath, '.mini-ide', 'context.md');
const contextDir = (projectPath) => path.join(projectPath, '.mini-ide', 'context');

const BUILTIN_GUIDE = `# Miniprogram (via the Miniprogram Preview extension)

This is built for a miniprogram service provider's platform, not WeChat:
- APIs are \`my.*\` (not \`wx.*\`). Check an API with \`api_docs\` / \`api_search\` before using it; don't guess option names.
- Templates are \`.axml\` (a:if, a:for, onTap="handler"), styles \`.acss\`, scripts use \`App({})\`, \`Page({})\`, \`Component({})\`.
- Pages must be listed in app.json \`pages\`; the first is the start page. Tab pages are in \`tabBar.items\`.
- A page's query arrives in \`onLoad(query)\` as strings; the app's launch query in \`App.onLaunch(options).query\` and \`my.getLaunchOptionsSync()\`.

Working with the running simulator (tools prefixed \`simulator_\`):
- After editing files the simulator rebuilds and restarts by itself; check \`build_errors\` if something doesn't show up.
- \`simulator_current_page\` shows the route, query and data of the page on screen; \`simulator_view\` shows what it renders.
- To test a page with specific inputs, use \`simulator_launch\` (start page, page query, app query, scene) or \`simulator_open_page\`; save a case you'll reuse as a compile mode (\`compile_modes\`).
- To "tap", call the handler with \`simulator_trigger\` (with the dataset/detail the template would pass).
- \`simulator_logs\` and \`simulator_api_log\` show console output and every my.* call with its result.
- To test without a backend, add \`mock_rules\` (match a my.request by url, or a my.call by name) and pair them with a launch query.
`;

// The project's own context: context.md first, then context/*.md by name
function readProjectContext(projectPath) {
  const parts = [];
  const files = [];
  const add = (file) => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) { parts.push(text); files.push(path.relative(projectPath, file)); }
    } catch (e) { /* missing */ }
  };
  add(contextFile(projectPath));
  try {
    fs.readdirSync(contextDir(projectPath)).filter((f) => f.endsWith('.md')).sort().forEach((f) => add(path.join(contextDir(projectPath), f)));
  } catch (e) { /* no folder */ }
  return { text: parts.join('\n\n'), files };
}

// What the server tells every client up front
function instructions(projectPath) {
  const project = projectPath ? readProjectContext(projectPath) : { text: '', files: [] };
  if (!project.text) {
    return `${BUILTIN_GUIDE}\nThis project has no .mini-ide/context.md yet (the user can add one with "Miniprogram: Edit Agent Context").`;
  }
  return `${BUILTIN_GUIDE}\n# Project context (${project.files.join(', ')}) — follow these rules for this project\n\n${project.text}`;
}

// Starter file for "Miniprogram: Edit Agent Context", filled with what the extension can see
function template({ name, pages, tabPages, navigationFunctions }) {
  const list = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none yet)');
  return `# Agent context for ${name}

Rules and background for AI agents working on this mini program. The Miniprogram Preview extension
sends this file to agents through its MCP server (as instructions and the \`project_context\` tool).
Keep it short and specific; delete anything that doesn't apply.

## Conventions
- (e.g. Use Component2 lifecycles: didMount/didUpdate/didUnmount.)
- (e.g. User-facing text lives in i18n/; no hard-coded strings in .axml.)

## Navigation
Navigate with these functions rather than calling my.navigateTo directly:
${list(navigationFunctions)}

Tab pages (open with switchTab):
${list(tabPages)}

## Data and APIs
- (e.g. All network calls go through utils/api.js; never call my.request directly.)
- (e.g. Test users and IDs to use in page queries and mocks.)

## Pages
${list(pages)}

## Don'ts
- (e.g. Don't edit files under vendor/ or the generated dist/.)
`;
}

module.exports = { BUILTIN_GUIDE, contextFile, readProjectContext, instructions, template };
