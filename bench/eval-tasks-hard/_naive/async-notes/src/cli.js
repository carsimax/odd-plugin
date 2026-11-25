import { commands } from "./commands.js";

export async function run(app, argv) {
  const [name, ...args] = argv;
  const command = commands[name];
  if (!command) throw new Error(`Unknown command: ${name}`);
  return command(app, args);
}
