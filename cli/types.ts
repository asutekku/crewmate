export interface TerminalSink {
  log(message: string): void;
  error(message: string): void;
}

export interface Clock {
  now(): number;
}

export interface CliContext extends TerminalSink, Clock {
  readonly dbPath: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly binRoot: string;
  readonly projectKey: string;
  readonly isGit: boolean;
  readonly cwd: string;
  readonly sessionId: string;
  fail(): void;
}

export type CommandHandler = (args: readonly string[]) => void;
export type CommandMap = Readonly<Record<string, CommandHandler>>;
export type CommandFactory = (context: CliContext) => CommandMap;
