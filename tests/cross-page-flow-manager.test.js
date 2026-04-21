import { describe, expect, it } from "vitest";
import { CrossPageFlowManager } from "../src/core/textflow/cross-page-flow-manager.js";

describe("CrossPageFlowManager", () => {
  it("moves overflow lines into linked block", () => {
    const manager = new CrossPageFlowManager();
    manager.linkBlocks("a", "b");

    const blocks = new Map([
      [
        "a",
        {
          id: "a",
          text: "line1\nline2\nline3\nline4",
          height: 20,
          lineHeight: 10
        }
      ],
      [
        "b",
        {
          id: "b",
          text: "tail",
          height: 50,
          lineHeight: 10
        }
      ]
    ]);

    manager.relayoutChain(blocks, "a");

    expect(blocks.get("a").text).toBe("line1\nline2");
    expect(blocks.get("b").text.startsWith("line3\nline4")).toBe(true);
  });
});
