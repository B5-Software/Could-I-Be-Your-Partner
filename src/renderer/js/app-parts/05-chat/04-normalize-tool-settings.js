  async function normalizeToolSettings() {
    if (!agent.settings) return;
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    if (typeof agent.settings.autoOptimizeToolSelection !== 'boolean') {
      agent.settings.autoOptimizeToolSelection = false;
    }
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    let changed = false;

    TOOL_DEFINITIONS.forEach(tool => {
      if (agent.settings.tools[tool.name] === undefined) {
        agent.settings.tools[tool.name] = true;
        changed = true;
      }
    });

    Object.keys(agent.settings.tools).forEach(name => {
      if (!toolNames.has(name)) {
        delete agent.settings.tools[name];
        changed = true;
      }
    });

    if (changed) {
      await window.api.setSettings(agent.settings);
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    }
  }
