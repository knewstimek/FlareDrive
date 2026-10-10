import { openAsBlob, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { multipartUpload } from "../assets/main.mjs";

const text = await fs.readFile(process.env.FLARE_PROFILE, "utf8");
const match = text.match(/```json flaredrive-isolated-upload-test\r?\n([\s\S]*?)\r?\n```/);
if (!match) throw new Error("Isolated test profile is required.");
const config = JSON.parse(match[1]);
if (!config.bucketName.startsWith("upload-check-") ||
    config.baseUrl !== "https://" + config.projectName + ".pages.dev") {
  throw new Error("An isolated test destination is required.");
}
await fs.mkdir(config.artifactPath, { recursive: true });
const sourceBefore = await fs.stat(config.sourcePath);
const result = { state: "starting", size: sourceBefore.size, runs: [] };
let lastSaved = 0, currentRun, active = 0, maximum = 0;
async function save() {
  result.observed_at = new Date().toISOString();
  await fs.writeFile(config.resultPath + ".new", JSON.stringify(result, null, 2));
  await fs.rename(config.resultPath + ".new", config.resultPath);
}
function progressSave() {
  if (performance.now() - lastSaved < 5000) return;
  lastSaved = performance.now();
  // One write chain prevents progress events from racing on the status file.
  writes = writes.then(save);
}
let writes = Promise.resolve();
const authorization = "Bearer " + config.authToken;
async function hashFile() {
  const hash = createHash("sha256");
  for await (const data of createReadStream(config.sourcePath)) hash.update(data);
  return hash.digest("hex");
}
const file = await openAsBlob(config.sourcePath, { type: "application/octet-stream" });

async function request(method, path, data, options = {}) {
  const headers = { ...options.headers, Authorization: authorization };
  const started = performance.now();
  let body = data;
  const part = method === "PUT";
  const number = part ? Number(new URL(path, config.baseUrl).searchParams.get("partNumber")) : null;
  if (data instanceof Blob) {
    headers["Content-Length"] = String(data.size);
    const reader = data.stream().getReader();
    let loaded = 0;
    body = new ReadableStream({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        loaded += next.value.byteLength;
        options.onUploadProgress?.({ loaded, total: data.size });
        controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
  } else if (data && typeof data === "object") {
    body = JSON.stringify(data);
    headers["Content-Type"] = "application/json";
  }
  if (part) { active++; maximum = Math.max(maximum, active); }
  let status = null, colo = null;
  try {
    const response = await fetch(new URL(path, config.baseUrl), {
      method, headers, body: method === "GET" ? undefined : body,
      duplex: "half", redirect: "error",
      signal: AbortSignal.timeout(Math.min(options.timeout || 300000, 120000)),
    });
    status = response.status;
    colo = response.headers.get("cf-ray")?.split("-").at(-1);
    const responseText = await response.text();
    let parsed;
    try { parsed = JSON.parse(responseText); } catch { parsed = responseText; }
    if (!response.ok) {
      throw Object.assign(new Error("HTTP " + response.status), {
        isAxiosError: true, response: { status: response.status }, code: "HTTP_ERROR",
      });
    }
    return { data: parsed, headers: Object.fromEntries(response.headers) };
  } catch (error) {
    if (error.response) throw error;
    throw Object.assign(new Error(error.message, { cause: error }), {
      isAxiosError: true,
      code: error.name === "TimeoutError" ? "ETIMEDOUT" : "ERR_NETWORK",
    });
  } finally {
    if (part) {
      active--;
      currentRun.parts.push({ part: number, status, edge: colo,
        elapsed_s: Number(((performance.now() - started) / 1000).toFixed(3)) });
      progressSave();
    }
  }
}
globalThis.axios = {
  post: (url, data, options) => request("POST", url, data, options),
  put: (url, data, options) => request("PUT", url, data, options),
};
async function verifyDownload(key) {
  const response = await fetch(new URL("/raw/" + key, config.baseUrl), {
    headers: { Authorization: authorization, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error("Verification download HTTP " + response.status);
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of response.body) { size += bytes.byteLength; hash.update(bytes); }
  const digest = hash.digest("hex");
  if (size !== file.size || digest !== result.source_sha256) {
    throw new Error("Downloaded bytes do not match the source.");
  }
  return { size, sha256_match: true };
}
try {
  await save();
  const denied = await fetch(new URL("/api/children/temp/", config.baseUrl));
  if (denied.status !== 401) throw new Error("Anonymous test access is not blocked.");
  const listing = await request("GET", "/api/children/temp/");
  if (!Array.isArray(listing.data.value)) throw new Error("Isolated bucket binding is not ready.");
  result.source_sha256 = await hashFile();
  for (const [mode, concurrency] of [["serial", 1], ["parallel", 3]]) {
    active = 0; maximum = 0;
    const key = "temp/" + mode + "/sample.dpk";
    currentRun = { mode, concurrency, state: "uploading", parts: [], progress_bytes: 0 };
    result.runs.push(currentRun);
    result.state = mode;
    await writes; await save();
    const started = performance.now();
    await multipartUpload(key, file, {
      concurrency,
      onUploadProgress: (event) => {
        currentRun.progress_bytes = event.loaded;
        currentRun.elapsed_s = Number(((performance.now() - started) / 1000).toFixed(2));
        progressSave();
      },
      onUploadState: (stage) => { currentRun.stage = stage; progressSave(); },
    });
    const elapsed = (performance.now() - started) / 1000;
    currentRun.elapsed_s = Number(elapsed.toFixed(3));
    currentRun.average_MB_s = Number((file.size / elapsed / 1e6).toFixed(3));
    currentRun.maximum_simultaneous_parts = maximum;
    currentRun.state = "verifying";
    await writes; await save();
    currentRun.verification = await verifyDownload(key);
    currentRun.state = "completed";
    await writes; await save();
  }
  const after = await fs.stat(config.sourcePath);
  if (after.size !== sourceBefore.size || after.mtimeMs !== sourceBefore.mtimeMs) {
    throw new Error("Source changed during the benchmark.");
  }
  result.state = "completed";
  result.speedup = Number((result.runs[0].elapsed_s / result.runs[1].elapsed_s).toFixed(3));
} catch (error) {
  result.state = "failed";
  result.error = error.message;
  if (currentRun) currentRun.state = "failed";
} finally {
  await writes; await save();
}
