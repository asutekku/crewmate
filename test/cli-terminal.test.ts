import { describe, expect, test } from "bun:test";

import {
  sanitizeTerminalText,
  TerminalReport,
  visibleCodePointLength,
} from "../cli/terminal.ts";

describe("terminal output boundary", () => {
  test("strips ANSI, OSC, and controls and flattens single-line values", () => {
    const hostile =
      "\u001b[31mred\u001b[0m\nnext\u0000 \u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007";
    expect(sanitizeTerminalText(hostile)).toBe("red next link");
  });

  test.each([
    `quote'\"`,
    "$(touch owned); rm -rf nope",
    "../../outside",
    "👩🏽‍💻 café e\u0301",
  ])("preserves harmless text without interpreting it: %s", (value) => {
    expect(sanitizeTerminalText(value)).toBe(value);
  });

  test("names its Unicode code-point measurement policy accurately", () => {
    expect(visibleCodePointLength("\u001b[31mé\u001b[0m")).toBe(1);
    expect(visibleCodePointLength("👩🏽‍💻")).toBe(4);
  });

  test("emits structural blank lines without embedded newline prefixes", () => {
    expect(
      new TerminalReport()
        .line("header")
        .section("budget")
        .field("target", 100)
        .lines(),
    ).toEqual(["header", "", "budget", "  target   100"]);
  });
});
