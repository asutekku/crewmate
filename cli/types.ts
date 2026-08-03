export interface CliContext {
  readonly dbPath: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly binRoot: string;
  readonly projectKey: string;
  readonly isGit: boolean;
  readonly cwd: string;
  readonly sessionId: string;
  now(): number;
  log(message: string): void;
  error(message: string): void;
  fail(): void;
}

export type CommandHandler = (args: string[]) => void;
export type CommandMap = Readonly<Record<string, CommandHandler>>;
export type CommandFactory = (context: CliContext) => CommandMap;
