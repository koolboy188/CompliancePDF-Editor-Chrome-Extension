import { describe, expect, it } from "vitest";
import { ReflowEngine } from "../src/core/reflow/reflow-engine.js";

describe("ReflowEngine", () => {
  it("wraps long text into multiple lines", () => {
    const engine = new ReflowEngine();
    const block = {
      id: "b-1",
      width: 120,
      text: "This is a long sentence that should wrap into multiple lines."
    };

    const result = engine.reflowBlock(block, {
      fontFamily: "Arial",
      fontSize: 14,
      lineSpacing: 1.4
    });

    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.height).toBeGreaterThan(14);
  });

  it("applies edit mutation before reflow", () => {
    const engine = new ReflowEngine();
    const block = { id: "b-2", width: 250, text: "Hello world" };

    const result = engine.applyEdit(
      block,
      (text) => `${text} from FlexiPDF`,
      { fontFamily: "Arial", fontSize: 12, lineSpacing: 1.2 }
    );

    expect(result.text).toContain("FlexiPDF");
  });
});
