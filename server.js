import http from "node:http";
import worker from "./index.js";

const env = { ...process.env };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = body;
    const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, init);
    const background = [];
    const response = await worker.fetch(request, env, { waitUntil: (promise) => background.push(Promise.resolve(promise)) });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
    Promise.allSettled(background).catch(() => {});
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("internal error");
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => console.log(`VSNP bot listening on ${port}`));
