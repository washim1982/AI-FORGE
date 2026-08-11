/**
 * Regenerates every Forge raster icon from the branding SVGs.
 *
 *   npm run icons
 *
 * Runs under Electron because Chromium is the only renderer already available
 * here that resolves SVG gradients and filters correctly. The two SVGs under
 * assets/branding are the single source of truth; nothing else is hand-edited.
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
const branding = path.join(workspace, "assets", "branding");
const markSvg = path.join(branding, "forge-mark.svg");
const lineSvg = path.join(branding, "forge-mark-line.svg");

// Windows shows the app icon at every one of these; 256 is the Explorer tile.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Below this, an entry is stored as an uncompressed DIB. NSIS and older Windows
// shells do not reliably read PNG-compressed entries at small sizes.
const ICO_PNG_THRESHOLD = 128;

const OUTPUTS = [
  { file: "build/icon.png", size: 512 },
  { file: "build/code_150x150.png", size: 150 },
  { file: "build/code_70x70.png", size: 70 },
  { file: "extensions/forge-agent/media/forge.png", size: 128 },
  { file: "src/client/assets/forge-mark.png", size: 256 },
  { file: "assets/branding/forge-mark.png", size: 512 },
];

let win;

/**
 * Rewrites the root <svg> only. Resizing document-wide would also rewrite the
 * background rect and the filter regions, which silently breaks the render.
 */
function sized(svg, size) {
  return svg.replace(/<svg\b[^>]*>/, (tag) => tag
    .replace(/\s(?:width|height)="[^"]*"/g, "")
    .replace(/<svg/, `<svg width="${size}" height="${size}" style="width:${size}px;height:${size}px"`));
}

async function renderSvg(svgText, size) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    svg{display:block}
  </style></head><body>${sized(svgText, size)}</body></html>`;

  win.setContentSize(size, size);
  await win.loadURL(`data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const { width, height } = image.getSize();
  if (width !== size || height !== size) {
    throw new Error(`Rendered ${width}x${height} but expected ${size}x${size}.`);
  }
  return image;
}

/**
 * Builds an uncompressed 32bpp icon image: BITMAPINFOHEADER, bottom-up BGRA
 * rows, then the 1bpp AND mask that the format still requires.
 */
function dibEntry(image, size) {
  const bgraTopDown = image.toBitmap();
  const rowBytes = size * 4;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR image plus AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const xor = Buffer.alloc(rowBytes * size);
  for (let row = 0; row < size; row += 1) {
    bgraTopDown.copy(xor, (size - 1 - row) * rowBytes, row * rowBytes, (row + 1) * rowBytes);
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // fully opaque; alpha lives in the XOR data

  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bit depth
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { zoomFactor: 1 },
  });

  const mark = await fs.readFile(markSvg, "utf8");

  for (const { file, size } of OUTPUTS) {
    const target = path.join(workspace, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const image = await renderSvg(mark, size);
    await fs.writeFile(target, image.toPNG());
    console.log(`  ${file} (${size}x${size})`);
  }

  const entries = [];
  for (const size of ICO_SIZES) {
    const image = await renderSvg(mark, size);
    entries.push({
      size,
      data: size >= ICO_PNG_THRESHOLD ? image.toPNG() : dibEntry(image, size),
    });
  }
  const icoPath = path.join(workspace, "build", "icon.ico");
  await fs.writeFile(icoPath, buildIco(entries));
  console.log(`  build/icon.ico (${ICO_SIZES.join(", ")})`);

  // The activity-bar icon stays vector so the workbench can tint it.
  const sidebarTarget = path.join(workspace, "extensions", "forge-agent", "media", "forge.svg");
  await fs.copyFile(lineSvg, sidebarTarget);
  console.log("  extensions/forge-agent/media/forge.svg (vector, currentColor)");

  console.log("Forge icons regenerated from assets/branding.");
  app.quit();
}).catch((error) => {
  console.error("Icon generation failed:", error);
  app.exit(1);
});
