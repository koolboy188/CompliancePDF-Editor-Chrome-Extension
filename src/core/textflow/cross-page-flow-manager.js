export class CrossPageFlowManager {
  constructor() {
    this.links = new Map();
  }

  linkBlocks(sourceBlockId, targetBlockId) {
    this.links.set(sourceBlockId, targetBlockId);
  }

  relayoutChain(blockById, sourceBlockId) {
    const visited = new Set();
    let currentId = sourceBlockId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const block = blockById.get(currentId);
      if (!block) {
        break;
      }

      const maxLines = Math.max(1, Math.floor(block.height / block.lineHeight));
      const lines = block.text.split("\n");
      if (lines.length <= maxLines) {
        currentId = this.links.get(currentId);
        continue;
      }

      const kept = lines.slice(0, maxLines);
      const overflow = lines.slice(maxLines).join("\n");
      block.text = kept.join("\n");
      blockById.set(currentId, block);

      const nextId = this.links.get(currentId);
      if (!nextId) {
        break;
      }
      const nextBlock = blockById.get(nextId);
      if (!nextBlock) {
        break;
      }

      nextBlock.text = overflow + (nextBlock.text ? `\n${nextBlock.text}` : "");
      blockById.set(nextId, nextBlock);
      currentId = nextId;
    }
  }
}
