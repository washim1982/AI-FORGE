/**
 * Regenerates every Forge raster icon from the branding sources.
 *
 *   npm run icons                     # artwork exactly as supplied
 *   FORGE_ICON_TRANSPARENT=1 npm run icons   # also clear the flat surround
 *
 * The application mark comes from assets/branding/app-icon-source.png. It is
 * only ever resampled — never redrawn — so the shipped icon matches the
 * supplied artwork. The activity-bar glyph stays vector, because the Code-OSS
 * workbench tints that icon itself and cannot tint a bitmap.
 *
 * Runs under Electron because Chromium is the only image pipeline already
 * available here with high-quality downsampling.
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const workspace = path.resolve(__dirname, "..");
const branding = path.join(workspace, "assets", "branding");
const sourcePng = path.join(branding, "app-icon-source.png");
const lineSvg = path.join(branding, "forge-mark-line.svg");

// The supplied artwork sits on an opaque background, which would render as a
// solid box around the icon. Clearing it is the default; set FORGE_ICON_RAW=1
// to emit the artwork completely untouched instead.
const CLEAR_SURROUND = process.env.FORGE_ICON_RAW !== "1";

// "plate" keeps the artwork's own backing panel. "ink" drops it too, so only
// the drawn marks survive on full transparency — the panel is what makes the
// icon a solid tile, and dropping it is what makes it a logo.
const INK_ONLY = process.env.FORGE_ICON_STYLE === "ink";
// Optional recolour for ink mode, e.g. "#e8e4ef" to make it legible on a dark
// taskbar. Unset keeps the artwork's own colour.
const INK_COLOR = process.env.FORGE_ICON_INK_COLOR || "";

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Below this an entry is stored as an uncompressed DIB; NSIS and older Windows
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

// Ink colours for the two surfaces the mark lands on. "light" is for a dark
// background, "dark" for a light one.
const THEME_INK = { light: "#e8e4ef", dark: "#4a4a4d" };

/**
 * Theme pairs. These are swapped at runtime — Electron repaints the window
 * icon when the system theme changes, and the renderer picks the matching
 * mark — so both have to exist on disk regardless of the default style.
 */
const THEME_OUTPUTS = [
  { file: "build/icon-light.png", size: 512, ink: THEME_INK.light },
  { file: "build/icon-dark.png", size: 512, ink: THEME_INK.dark },
  { file: "src/client/assets/forge-mark-light.png", size: 256, ink: THEME_INK.light },
  { file: "src/client/assets/forge-mark-dark.png", size: 256, ink: THEME_INK.dark },
];

let win;
const skipped = [];

/**
 * Writes an icon, tolerating a file the running app currently holds open.
 * Windows keeps a lock on icons a live process is displaying, and one locked
 * file should not abandon the whole regeneration.
 */
async function writeIcon(file, data) {
  const target = path.join(workspace, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, data);
    return true;
  } catch (error) {
    const code = error.code || "";
    if (!["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(code)) throw error;
    skipped.push(file);
    return false;
  }
}

/**
 * Rasterises the source at one size inside the page.
 *
 * The artwork is letterboxed into a square rather than stretched, so a source
 * that is not perfectly square keeps its proportions. Returns both a PNG and
 * the raw RGBA bytes, because the ICO packer needs pixels for its DIB entries.
 */
async function rasterise(size) {
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const image = window.__forgeSource;
      const scale = Math.min(${size} / image.width, ${size} / image.height);
      const targetWidth = Math.max(1, Math.round(image.width * scale));
      const targetHeight = Math.max(1, Math.round(image.height * scale));

      // Progressive halving. Going from 1105px straight to 16px in one draw
      // makes the browser sample far too sparsely and the thin rings alias
      // into broken dots; halving repeatedly averages every source pixel in.
      let current = document.createElement("canvas");
      current.width = image.width;
      current.height = image.height;
      let currentContext = current.getContext("2d", { willReadFrequently: true });
      currentContext.imageSmoothingEnabled = true;
      currentContext.imageSmoothingQuality = "high";
      currentContext.drawImage(image, 0, 0);

      while (current.width > targetWidth * 2 && current.height > targetHeight * 2) {
        const halved = document.createElement("canvas");
        halved.width = Math.max(targetWidth, Math.floor(current.width / 2));
        halved.height = Math.max(targetHeight, Math.floor(current.height / 2));
        const halvedContext = halved.getContext("2d", { willReadFrequently: true });
        halvedContext.imageSmoothingEnabled = true;
        halvedContext.imageSmoothingQuality = "high";
        halvedContext.drawImage(current, 0, 0, halved.width, halved.height);
        current = halved;
        currentContext = halvedContext;
      }

      const canvas = document.createElement("canvas");
      canvas.width = ${size};
      canvas.height = ${size};
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        current,
        (${size} - targetWidth) / 2,
        (${size} - targetHeight) / 2,
        targetWidth,
        targetHeight,
      );

      const pixels = context.getImageData(0, 0, ${size}, ${size});
      let binary = "";
      for (let i = 0; i < pixels.data.length; i += 1) binary += String.fromCharCode(pixels.data[i]);
      return JSON.stringify({ png: canvas.toDataURL("image/png"), rgba: btoa(binary) });
    })()
  `);
  const parsed = JSON.parse(result);
  return {
    png: Buffer.from(parsed.png.split(",")[1], "base64"),
    rgba: Buffer.from(parsed.rgba, "base64"),
  };
}

/**
 * Builds an uncompressed 32bpp icon image: BITMAPINFOHEADER, bottom-up BGRA
 * rows, then the 1bpp AND mask the format still requires.
 */
function dibEntry(rgba, size) {
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
    const target = (size - 1 - row) * rowBytes; // ICO rows run bottom-up
    for (let column = 0; column < size; column += 1) {
      const from = row * rowBytes + column * 4;
      const to = target + column * 4;
      xor[to] = rgba[from + 2];     // B
      xor[to + 1] = rgba[from + 1]; // G
      xor[to + 2] = rgba[from];     // R
      xor[to + 3] = rgba[from + 3]; // A
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // alpha lives in the XOR data
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
  await fs.access(sourcePng).catch(() => {
    throw new Error(`Missing ${path.relative(workspace, sourcePng)} — put the application artwork there first.`);
  });

  win = new BrowserWindow({ width: 600, height: 600, show: false, webPreferences: { zoomFactor: 1 } });
  await win.loadURL("data:text/html,<body></body>");

  // Inlined as a data URL because a data: page cannot load file: subresources.
  const sourceDataUrl = `data:image/png;base64,${(await fs.readFile(sourcePng)).toString("base64")}`;

  /**
   * Prepares the bitmap once for a given ink tint and parks it in the page, so
   * every size then resamples from the same prepared source. Re-running with a
   * different tint is how the theme pair is produced.
   */
  const prepare = (inkOnly, inkColor) => win.webContents.executeJavaScript(`
    (async () => {
      const image = new Image();
      image.src = ${JSON.stringify(sourceDataUrl)};
      await image.decode();

      if (!${CLEAR_SURROUND}) {
        window.__forgeSource = image;
        return JSON.stringify({ width: image.width, height: image.height, cleared: 0 });
      }

      // Flood fill inward from the corners, clearing only the flat background
      // the artwork sits on. Stopping at the first non-background pixel keeps
      // the icon itself untouched.
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = data.data;
      const seen = new Uint8Array(canvas.width * canvas.height);
      const sample = (x, y) => (y * canvas.width + x) * 4;
      const corner = pixels.slice(0, 4);
      const isBackground = (index) =>
        Math.abs(pixels[index] - corner[0]) < 26 &&
        Math.abs(pixels[index + 1] - corner[1]) < 26 &&
        Math.abs(pixels[index + 2] - corner[2]) < 26;

      const stack = [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]];
      let cleared = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
        const flat = y * canvas.width + x;
        if (seen[flat]) continue;
        seen[flat] = 1;
        const index = sample(x, y);
        if (!isBackground(index)) continue;
        pixels[index + 3] = 0;
        cleared += 1;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }

      // The artwork was anti-aliased against the white background, so the ring
      // of blend pixels just inside the fill is still opaque and reads as a
      // white rim once the surround is gone. Recover each one's true coverage:
      // it is a mix of the background and the icon, so how far it sits from the
      // background colour is its alpha, and dividing that back out restores the
      // icon's own colour.
      let feathered = 0;
      const backgroundLuma = (corner[0] + corner[1] + corner[2]) / 3;
      // How far the artwork can travel from the background before it is fully
      // opaque. Measured toward whichever extreme the background is not, so
      // this works for a white surround and a black one alike.
      const span = Math.max(1, backgroundLuma > 127 ? backgroundLuma : 255 - backgroundLuma);
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = sample(x, y);
          if (pixels[index + 3] === 0) continue;
          const touchesCleared =
            (x > 0 && pixels[sample(x - 1, y) + 3] === 0) ||
            (x < canvas.width - 1 && pixels[sample(x + 1, y) + 3] === 0) ||
            (y > 0 && pixels[sample(x, y - 1) + 3] === 0) ||
            (y < canvas.height - 1 && pixels[sample(x, y + 1) + 3] === 0);
          if (!touchesCleared) continue;

          const luma = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
          const alpha = Math.max(0, Math.min(1, Math.abs(luma - backgroundLuma) / span));
          if (alpha >= 0.98) continue;
          for (let channel = 0; channel < 3; channel += 1) {
            const value = pixels[index + channel];
            pixels[index + channel] = alpha > 0.01
              ? Math.max(0, Math.min(255, Math.round((value - corner[channel] * (1 - alpha)) / alpha)))
              : value;
          }
          pixels[index + 3] = Math.round(alpha * 255);
          feathered += 1;
        }
      }
      // Ink mode: keep only the drawn marks. Every surviving pixel is a blend
      // of the panel and the ink, so its distance from the panel colour is its
      // coverage — which recovers soft antialiased edges rather than a hard
      // cut, and clears enclosed panel areas (the F, the eyes, the bubble)
      // that a connectivity fill could never reach.
      let inked = 0;
      if (${inkOnly}) {
        // Panel and ink levels come from percentiles, not the extremes. A
        // handful of stray near-black pixels would otherwise stretch the range
        // and leave the whole icon washed out at partial opacity.
        const histogram = new Uint32Array(256);
        let counted = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] === 0) continue;
          histogram[Math.round((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3)] += 1;
          counted += 1;
        }
        const tail = Math.max(1, Math.round(counted * 0.02));
        let panelLuma = 255;
        for (let level = 255, seen = 0; level >= 0; level -= 1) {
          seen += histogram[level];
          if (seen >= tail) { panelLuma = level; break; }
        }
        let inkLuma = 0;
        for (let level = 0, seen = 0; level <= 255; level += 1) {
          seen += histogram[level];
          if (seen >= tail) { inkLuma = level; break; }
        }
        const range = Math.max(1, panelLuma - inkLuma);
        const override = ${JSON.stringify(inkColor)};
        const tint = override
          ? [parseInt(override.slice(1, 3), 16), parseInt(override.slice(3, 5), 16), parseInt(override.slice(5, 7), 16)]
          : null;

        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] === 0) continue;
          const luma = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
          const coverage = Math.max(0, Math.min(1, (panelLuma - luma) / range));
          if (coverage <= 0.02) {
            pixels[index + 3] = 0;
            continue;
          }
          if (tint) {
            pixels[index] = tint[0];
            pixels[index + 1] = tint[1];
            pixels[index + 2] = tint[2];
          }
          pixels[index + 3] = Math.round(coverage * 255);
          inked += 1;
        }
      }

      context.putImageData(data, 0, 0);

      const flattened = new Image();
      flattened.src = canvas.toDataURL("image/png");
      await flattened.decode();
      window.__forgeSource = flattened;
      return JSON.stringify({ width: image.width, height: image.height, cleared, feathered, inked });
    })()
  `);

  const prepared = await prepare(INK_ONLY, INK_COLOR);
  const info = JSON.parse(prepared);
  const notes = CLEAR_SURROUND
    ? [`cleared ${info.cleared} surround px`, `feathered ${info.feathered} edge px`]
      .concat(INK_ONLY ? [`ink mode: ${info.inked} px kept${INK_COLOR ? `, tinted ${INK_COLOR}` : ", original colour"}`] : [])
      .join(", ")
    : "used exactly as supplied";
  console.log(`  source ${path.relative(workspace, sourcePng)} (${info.width}x${info.height}), ${notes}`);

  for (const { file, size } of OUTPUTS) {
    const { png } = await rasterise(size);
    if (await writeIcon(file, png)) console.log(`  ${file} (${size}x${size})`);
  }

  const entries = [];
  for (const size of ICO_SIZES) {
    const { png, rgba } = await rasterise(size);
    entries.push({ size, data: size >= ICO_PNG_THRESHOLD ? png : dibEntry(rgba, size) });
  }
  if (await writeIcon("build/icon.ico", buildIco(entries))) {
    console.log(`  build/icon.ico (${ICO_SIZES.join(", ")})`);
  }

  // The theme pair is always emitted, whatever the default style is, because
  // the app swaps between these two at runtime.
  for (const { file, size, ink } of THEME_OUTPUTS) {
    await prepare(true, ink);
    const { png } = await rasterise(size);
    if (await writeIcon(file, png)) console.log(`  ${file} (${size}x${size}, ink ${ink})`);
  }

  // The activity-bar icon stays vector so the workbench can tint it.
  if (await writeIcon("extensions/forge-agent/media/forge.svg", await fs.readFile(lineSvg))) {
    console.log("  extensions/forge-agent/media/forge.svg (vector, currentColor)");
  }

  if (skipped.length) {
    console.log(`Forge icons regenerated, except ${skipped.length} file(s) locked by a running app:`);
    for (const file of skipped) console.log(`  LOCKED  ${file}`);
    console.log("Close Forge and run `npm run icons` again to update those.");
  } else {
    console.log("Forge icons regenerated.");
  }
  app.quit();
}).catch((error) => {
  console.error("Icon generation failed:", error.message || error);
  app.exit(1);
});
