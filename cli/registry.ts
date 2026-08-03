import type { CommandHandler, CommandMap } from "./types.ts";

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  add(commands: CommandMap): this {
    for (const [name, handler] of Object.entries(commands)) {
      if (this.handlers.has(name))
        throw new Error(`duplicate CLI command: ${name}`);
      this.handlers.set(name, handler);
    }
    return this;
  }

  handler(name: string | undefined): CommandHandler | undefined {
    return name === undefined ? undefined : this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}
