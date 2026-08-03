import type { CommandHandler, CommandMap } from "./types.ts";
import { findVerb, type Verb } from "../core/verbs.ts";

export interface RegisteredCommand {
  readonly spelling: string;
  readonly metadata: Verb;
  readonly handler: CommandHandler;
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();

  add(commands: CommandMap): this {
    for (const [name, handler] of Object.entries(commands)) {
      if (this.commands.has(name))
        throw new Error(`duplicate CLI command: ${name}`);
      const metadata = findVerb(name);
      if (!metadata) throw new Error(`CLI command has no metadata: ${name}`);
      this.commands.set(name, { spelling: name, metadata, handler });
    }
    return this;
  }

  handler(name: string | undefined): CommandHandler | undefined {
    return name === undefined ? undefined : this.commands.get(name)?.handler;
  }

  command(name: string | undefined): RegisteredCommand | undefined {
    return name === undefined ? undefined : this.commands.get(name);
  }

  names(): string[] {
    return [...this.commands.keys()];
  }
}
