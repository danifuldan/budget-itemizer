export const extractPdfText = async (buffer: Buffer): Promise<string | null> => {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();

      // Collect all text items with their coordinates
      const textItems: { x: number; y: number; str: string }[] = [];
      for (const item of content.items as any[]) {
        if (!item.str || !item.transform) continue;
        textItems.push({
          x: item.transform[4] as number,
          y: item.transform[5] as number,
          str: item.str,
        });
      }

      // Sort by Y descending (top of page first)
      textItems.sort((a, b) => b.y - a.y);

      // Cluster text items into logical lines. Items within 10 Y-units
      // of each other belong to the same line. This handles receipts
      // (e.g. Costco) where wrapped item names span multiple PDF lines
      // that are only ~6 units apart, while separate items are 16+ apart.
      const LINE_CLUSTER_THRESHOLD = 14;
      const clusters: { y: number; items: { x: number; str: string }[] }[] = [];
      for (const item of textItems) {
        const lastCluster = clusters[clusters.length - 1];
        if (lastCluster && Math.abs(item.y - lastCluster.y) <= LINE_CLUSTER_THRESHOLD) {
          lastCluster.items.push({ x: item.x, str: item.str });
        } else {
          clusters.push({ y: item.y, items: [{ x: item.x, str: item.str }] });
        }
      }

      // Within each cluster, sort items left-to-right. Insert a newline
      // when there's a large horizontal gap (column break in multi-column
      // layouts like Target/Walmart order pages). We measure the gap as
      // the X distance between adjacent items — no character width estimate.
      const COLUMN_GAP_THRESHOLD = 80;
      const sortedLines: string[] = [];
      for (const cluster of clusters) {
        const sorted = cluster.items.sort((a, b) => a.x - b.x);
        let line = sorted[0]?.str ?? "";
        for (let j = 1; j < sorted.length; j++) {
          const gap = sorted[j].x - sorted[j - 1].x;
          if (gap > COLUMN_GAP_THRESHOLD) {
            sortedLines.push(line.trim());
            line = sorted[j].str;
          } else {
            line += " " + sorted[j].str;
          }
        }
        if (line.trim()) sortedLines.push(line.trim());
      }
      pageTexts.push(sortedLines.filter((l) => l.length > 0).join("\n"));
    }
    const fullText = pageTexts.join("\n\n");
    const hasPrices = /\$?\d+\.\d{2}/.test(fullText);
    if (fullText.trim().length > 200 && hasPrices) {
      console.log(`Extracted ${fullText.length} chars of text from PDF (${doc.numPages} page(s))`);
      return fullText;
    }
    console.log(`PDF text extraction not useful (${fullText.trim().length} chars, prices=${hasPrices})`);
    return null;
  } catch (err) {
    console.log(`PDF text extraction failed: ${err}`);
    return null;
  }
};
