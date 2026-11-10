const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "src", "PromptTerminal.App", "Web", "vendor");
fs.mkdirSync(destination, { recursive: true });

for (const name of ["xterm", "addon-fit", "addon-search", "addon-serialize", "addon-web-links"]) {
  const source = path.join(root, "node_modules", "@xterm", name);
  fs.copyFileSync(path.join(source, "lib", `${name}.js`), path.join(destination, `${name}.js`));
  const license = name === "addon-serialize"
    ? path.join(root, "node_modules", "@xterm", "xterm", "LICENSE")
    : path.join(source, "LICENSE");
  fs.copyFileSync(license, path.join(destination, `${name}.LICENSE`));
}
fs.copyFileSync(
  path.join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  path.join(destination, "xterm.css")
);
console.log("Bundled local terminal assets and licenses.");
