import { success, type Result } from "./result.ts";

export const MAX_CLI_LIMIT = 10_000;

export type ArgumentFailureKind =
  "missing" | "invalid" | "duplicate" | "unknown" | "conflict" | "trailing";

export interface ArgumentFailure {
  readonly kind: ArgumentFailureKind;
  readonly message: string;
}

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export interface ArgumentSchema {
  readonly valueFlags?: readonly string[];
  readonly booleanFlags?: readonly string[];
  readonly maxPositionals?: number;
}

export type ArgumentResult<T> =
  | Result<T>
  | {
      readonly ok: false;
      readonly error: string;
      readonly kind: ArgumentFailureKind;
    };

const argumentFailure = (
  kind: ArgumentFailureKind,
  message: string,
): ArgumentResult<never> => ({
  ok: false,
  kind,
  error: message,
});

/** Non-mutating, single-pass flag parser with duplicate and unknown detection. */
export function parseArguments(
  argv: readonly string[],
  schema: ArgumentSchema,
): ArgumentResult<ParsedArguments> {
  const valueFlags = new Set(schema.valueFlags ?? []);
  const booleanFlags = new Set(schema.booleanFlags ?? []);
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!valueFlags.has(token) && !booleanFlags.has(token))
      return argumentFailure("unknown", `unknown flag ${token}`);
    if (flags.has(token))
      return argumentFailure("duplicate", `duplicate flag ${token}`);
    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      return argumentFailure("missing", `${token} requires a value`);
    flags.set(token, value);
    index += 1;
  }
  if (
    schema.maxPositionals !== undefined &&
    positionals.length > schema.maxPositionals
  )
    return argumentFailure(
      "trailing",
      `unexpected trailing argument ${positionals[schema.maxPositionals]}`,
    );
  return success({ positionals, flags });
}

export function stringFlag(
  args: ParsedArguments,
  flag: string,
): string | undefined {
  const value = args.flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(args: ParsedArguments, flag: string): boolean {
  return args.flags.get(flag) === true;
}

export function parseSafeInteger(
  raw: string | undefined,
  label: string,
  range: { readonly min: number; readonly max: number },
): ArgumentResult<number | undefined> {
  if (raw === undefined) return success(undefined);
  if (!/^\d+$/.test(raw))
    return argumentFailure("invalid", `${label} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max)
    return argumentFailure(
      "invalid",
      `${label} must be between ${range.min} and ${range.max}`,
    );
  return success(value);
}

export function requireSafeInteger(
  raw: string | undefined,
  label: string,
  range: { readonly min: number; readonly max: number },
): ArgumentResult<number> {
  if (raw === undefined)
    return argumentFailure("missing", `${label} is required`);
  const parsed = parseSafeInteger(raw, label, range);
  if (!parsed.ok) return parsed;
  return parsed.value === undefined
    ? argumentFailure("missing", `${label} is required`)
    : success(parsed.value);
}

export function parseEnum<const T extends string>(
  raw: string | undefined,
  label: string,
  values: readonly T[],
): ArgumentResult<T | undefined> {
  if (raw === undefined) return success(undefined);
  const value = values.find((candidate) => candidate === raw);
  return value === undefined
    ? argumentFailure(
        "invalid",
        `${label} must be one of: ${values.join(", ")}`,
      )
    : success(value);
}

export interface SubjectSelector {
  readonly agent?: string;
  readonly session?: string;
}

export function parseSubjectSelector(
  args: ParsedArguments,
): ArgumentResult<SubjectSelector> {
  const agent = stringFlag(args, "--agent");
  const session = stringFlag(args, "--session");
  if (agent && session)
    return argumentFailure(
      "conflict",
      "--agent and --session cannot be used together",
    );
  return success({
    ...(agent ? { agent } : {}),
    ...(session ? { session } : {}),
  });
}
