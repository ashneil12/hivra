import { spawnSync } from "node:child_process";
import path from "node:path";

// Use real ESM/native packages in an isolated Node process, not Jest mocks.
// These cover library compatibility; they do not claim browser-worker or live
// Next image-optimizer acceptance.
function runModule(source: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: path.resolve(__dirname, ".."),
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Native dependency check failed: ${result.error?.message ?? result.stderr}`);
  }
  expect(result.stdout.trim()).toBe("PASS");
}

describe("upgraded native dependency compatibility", () => {
  it("extracts a known page with the real PDF.js engine", () => {
    runModule(`
      import assert from 'node:assert/strict';
      import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
      const text = 'Hivra dependency fixture';
      const stream = 'BT /F1 12 Tf 20 100 Td (' + text + ') Tj ET';
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length ' + stream.length + ' >>\\nstream\\n' + stream + '\\nendstream',
      ];
      let pdf = '%PDF-1.4\\n';
      const offsets = [0];
      for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += (index + 1) + ' 0 obj\\n' + object + '\\nendobj\\n';
      }
      const xref = Buffer.byteLength(pdf);
      pdf += 'xref\\n0 6\\n0000000000 65535 f \\n';
      for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \\n';
      pdf += 'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF';
      const task = getDocument({ data: new Uint8Array(Buffer.from(pdf)), useSystemFonts: true, verbosity: 0 });
      try {
        const doc = await task.promise;
        assert.equal(doc.numPages, 1);
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        assert.equal(content.items.map(item => item.str ?? '').join(''), text);
      } finally { await task.destroy(); }
      console.log('PASS');
    `);
  });

  it("decodes, resizes, and encodes an owned image using sharp and libvips", () => {
    runModule(`
      import assert from 'node:assert/strict';
      import sharp from 'sharp';
      const input = await sharp({ create: { width: 8, height: 8, channels: 3,
        background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
      const output = await sharp(input).resize(4, 4).webp().toBuffer();
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 4);
      assert.equal(metadata.height, 4);
      assert.equal(metadata.format, 'webp');
      console.log('PASS');
    `);
  });
});
