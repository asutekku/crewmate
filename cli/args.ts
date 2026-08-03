/** Removes `--flag <value>` from an argument list. */
export function takeFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  const value = args[index + 1] ?? "";
  args.splice(index, 2);
  return value;
}
