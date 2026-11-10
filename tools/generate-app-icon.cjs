const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

async function main() {
  const project = path.resolve(__dirname, "..", "src", "PromptTerminal.App");
  const svg = await fs.readFile(path.join(project, "Web", "app-icon.svg"), "utf8");
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const frames = [];
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      frames.push(await page.screenshot({ type: "png", omitBackground: true, animations: "disabled" }));
    }
  } finally { await browser.close(); }

  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frames[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  }
  const destination = path.join(project, "Assets", "PromptTerminal.ico");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, Buffer.concat([directory, ...frames]));
  console.log(`Generated the red command-prompt icon at ${sizes.join(", ")} pixels.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
