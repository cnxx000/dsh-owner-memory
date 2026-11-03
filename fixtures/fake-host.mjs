export function createFakeHost(options = {}) {
  const registeredTools = [];
  const variables = new Map();
  const renderHooks = [];
  const host = {
    registeredTools,
    variables,
    agentFs: options.agentFs,
    tools: {
      registerTool(tool) {
        registeredTools.push(tool);
      },
    },
    render(finalPromptText) {
      return renderHooks.map((hook) => hook(finalPromptText));
    },
  };
  if (options.systemPrompt !== false) {
    host.systemPrompt = {
      variable(name, provider) {
        variables.set(name, provider);
      },
      afterRender(hook) {
        renderHooks.push(hook);
      },
    };
  }
  return host;
}
