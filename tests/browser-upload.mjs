import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const profile = await fs.readFile(process.env.FLARE_PROFILE, "utf8");
const config = JSON.parse(profile.match(/```json flaredrive-isolated-upload-test\r?\n([\s\S]*?)\r?\n```/)[1]);
if (!config.bucketName.startsWith("upload-check-") ||
    config.baseUrl !== "https://" + config.projectName + ".pages.dev") {
  throw new Error("An isolated test destination is required.");
}
const resultPath = config.artifactPath + "/browser.json";
const result = { state: "starting", parts: [], runtime_errors: [], failed_resources: [], auth_challenges: [] };
const launchedAt = Date.now();
const save = () => fs.writeFile(resultPath, JSON.stringify(result, null, 2));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = spawn(process.env.TEST_CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  "--user-data-dir=" + config.artifactPath + "/browser-profile",
], { stdio: "ignore", windowsHide: true });
let ws, sequence = 0;
const pending = new Map();
function call(method, params = {}, timeout = 30000) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, timeout);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
let loadResolve, navigationResolve;
const requests = new Map();
try {
  await save();
  let port;
  const until = performance.now() + 15000;
  while (!port && performance.now() < until) {
    try {
      const portPath = config.artifactPath + "/browser-profile/DevToolsActivePort";
      if ((await fs.stat(portPath)).mtimeMs < launchedAt - 1000) {
        await delay(100); continue;
      }
      const text = await fs.readFile(portPath, "utf8");
      port = text.split("\n")[0];
    } catch { await delay(100); }
  }
  if (!port) throw new Error("Isolated browser did not start.");
  const targets = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("Isolated browser page is unavailable.");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.id && pending.has(event.id)) {
      const wait = pending.get(event.id); pending.delete(event.id);
      event.error ? wait.reject(new Error(event.error.message)) : wait.resolve(event.result);
      return;
    }
    if (event.method === "Fetch.requestPaused") {
      call("Fetch.continueRequest", { requestId: event.params.requestId }).catch(() => {});
    } else if (event.method === "Fetch.authRequired") {
      const own = event.params.authChallenge.origin === config.baseUrl;
      result.auth_challenges.push({ own_origin: own, scheme: event.params.authChallenge.scheme });
      call("Fetch.continueWithAuth", {
        requestId: event.params.requestId,
        authChallengeResponse: own ?
          { response: "ProvideCredentials", username: "test", password: config.authToken } :
          { response: "CancelAuth" },
      }).catch(() => {});
    } else if (event.method === "Runtime.exceptionThrown") {
      if (result.runtime_errors.length < 5) result.runtime_errors.push(
        (event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text)
          .replaceAll(config.baseUrl, "[test origin]").slice(0, 1500));
    } else if (event.method === "Page.frameNavigated") {
      if (event.params.frame.url === config.baseUrl + "/") navigationResolve?.();
    } else if (event.method === "Page.loadEventFired") {
      loadResolve?.();
    } else if (event.method === "Network.requestWillBeSent") {
      const url = new URL(event.params.request.url);
      if (url.origin === config.baseUrl && url.pathname.startsWith("/api/write/items/")) {
        requests.set(event.params.requestId, {
          part: url.searchParams.get("partNumber"),
          started: event.params.timestamp,
        });
      }
    } else if (event.method === "Network.responseReceived") {
      if (event.params.response.status >= 400 && result.failed_resources.length < 10) {
        result.failed_resources.push({ path: new URL(event.params.response.url).pathname,
          status: event.params.response.status });
      }
      const request = requests.get(event.params.requestId);
      if (request?.part) {
        const headers = event.params.response.headers;
        const ray = headers["cf-ray"] || headers["CF-RAY"];
        result.parts.push({
          part: Number(request.part), status: event.params.response.status,
          edge: ray?.split("-").at(-1),
          elapsed_s: Number((event.params.timestamp - request.started).toFixed(3)),
        });
      }
    }
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable", { maxPostDataSize: 0 });
  await call("Fetch.enable", {
    patterns: [{ urlPattern: config.baseUrl + "/", requestStage: "Request" }],
    handleAuthRequests: true,
  });
  const navigated = new Promise((resolve) => { navigationResolve = resolve; });
  const navigation = await call("Page.navigate", { url: config.baseUrl + "/" });
  if (navigation.errorText) throw new Error("Navigation: " + navigation.errorText);
  await Promise.race([navigated, delay(20000).then(() => { throw new Error("Navigation timed out"); })]);
  const ready = await call("Runtime.evaluate", {
    expression: `new Promise(resolve => {
      const check = () => !!document.querySelector(".main");
      if (check()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (check()) { observer.disconnect(); resolve(true); }
      });
      observer.observe(document, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(false); }, 20000);
    })`,
    awaitPromise: true, returnByValue: true,
  });
  if (ready.result.value !== true) {
    const page = await call("Runtime.evaluate", {
      expression: '({title:document.title,text:document.body.innerText.slice(0,1200),vue:typeof Vue,loader:typeof window["vue3-sfc-loader"]})',
      returnByValue: true,
    });
    result.page_diagnostic = page.result.value;
    result.eval_diagnostic = ready.exceptionDetails?.exception?.description || ready.exceptionDetails?.text || page.exceptionDetails?.exception?.description;
    throw new Error("Upload UI did not render.");
  }
  await call("Runtime.evaluate", { expression: `
    history.pushState(null, "", "/?p=temp/browser/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const input = document.createElement("input");
    input.type = "file"; input.id = "upload-test-file";
    document.body.appendChild(input);
  ` });
  const doc = await call("DOM.getDocument", { depth: 0 });
  const input = await call("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#upload-test-file" });
  await call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [config.sourcePath] });
  result.state = "uploading";
  await save();
  const started = performance.now();
  const outcome = await call("Runtime.evaluate", {
    expression: `new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const status = document.querySelector(".upload-status")?.textContent.trim() || "";
        const error = document.querySelector(".upload-error")?.textContent.trim() || "";
        if (status === "Uploads complete." || status === "Uploads finished with errors.") {
          observer.disconnect(); resolve({ status, error });
        }
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      const data = new DataTransfer();
      data.items.add(document.querySelector("#upload-test-file").files[0]);
      document.querySelector(".main").dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: data,
      }));
      setTimeout(() => { observer.disconnect(); resolve({ status: "timeout" }); }, 180000);
    })`,
    awaitPromise: true, returnByValue: true,
  }, 190000);
  result.elapsed_s = Number(((performance.now() - started) / 1000).toFixed(3));
  result.ui = outcome.result.value;
  result.state = result.ui.status === "Uploads complete." && !result.ui.error ? "completed" : "failed";
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(config.artifactPath + "/browser-upload.png", Buffer.from(screenshot.data, "base64"));
} catch (error) {
  result.state = "failed";
  result.error = error.message.replaceAll(config.baseUrl, "[test origin]");
} finally {
  await save();
  if (ws?.readyState === WebSocket.OPEN) {
    await call("Browser.close", {}, 2000).catch(() => {});
    ws.close();
  }
}
