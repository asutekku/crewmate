const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const UNSAFE_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Sanitizes untrusted terminal text without altering the canonical stored value. */
export function sanitizeTerminalText(
  value: unknown,
  multiline = false,
): string {
  const stripped = String(value)
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(UNSAFE_CONTROLS, "");
  return multiline
    ? stripped.replace(/\r\n?/g, "\n")
    : stripped.replace(/[\r\n]+/g, " ");
}

/** Visible width policy: Unicode code points after terminal-control stripping. */
export function visibleCodePointLength(value: string): number {
  return [...sanitizeTerminalText(value)].length;
}

export class TerminalReport {
  private readonly output: string[] = [];

  blank(): this {
    this.output.push("");
    return this;
  }

  line(value: string): this {
    this.output.push(value);
    return this;
  }

  section(title: string): this {
    if (this.output.length > 0 && this.output.at(-1) !== "") this.blank();
    return this.line(title);
  }

  field(label: string, value: unknown, labelWidth = 8): this {
    const safeLabel = sanitizeTerminalText(label);
    const safeValue = sanitizeTerminalText(value);
    return this.line(`  ${safeLabel.padEnd(labelWidth)} ${safeValue}`);
  }

  lines(): readonly string[] {
    return this.output;
  }

  emit(write: (line: string) => void): void {
    for (const line of this.output) write(line);
  }
}
