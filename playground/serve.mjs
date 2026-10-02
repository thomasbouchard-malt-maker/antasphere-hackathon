// Serves the demo app on http://localhost:5173 (zero dependencies).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT) || 5173;
const page = new URL("./app/index.html", import.meta.url);

createServer(async (_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(await readFile(page));
}).listen(PORT, () => console.log(`Demo app on http://localhost:${PORT}`));
