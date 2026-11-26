// Models and agents (models.rs, agents.rs): list_models (`pi --list-models` of the host), list_agents (agent
// definitions of the user and of the project above cwd) and agent_prompt_file (an agent's system prompt as a file on
// the host, for pi_open's appendPrompt) – task B5.
import { argOptString, argString, CommandError, type CommandRegistry } from "../commands.js";
import { agentPromptFile, isAgentPath, listAgents } from "../host/agents.js";
import { listModels } from "../host/models.js";

export function registerModelCommands(registry: CommandRegistry) {
  registry.register("list_models", {
    host: true,
    run: (ctx) => listModels(ctx.exec, ctx.host),
  });
  registry.register("list_agents", {
    host: true,
    run: (ctx, args) => listAgents(ctx.exec, ctx.host, argOptString(args, "cwd", "~") || "~"),
  });
  registry.register("agent_prompt_file", {
    host: true,
    run: (ctx, args) => {
      const path = argString(args, "path");
      if (!isAgentPath(path)) throw new CommandError(400, "not an agent file");
      return agentPromptFile(ctx.exec, ctx.host, path);
    },
  });
}
