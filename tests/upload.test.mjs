import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { multipartUpload, SIZE_LIMIT } from "../assets/main.mjs";

const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fileOf = (size) => ({
  name: "sample.dpk", type: "application/octet-stream", size,
  slice: (start, end) => ({ start, size: Math.min(end, size) - start }),
});
const partResponse = (number) => ({ data: { partNumber: number, etag: "etag-" + number } });
const completeResponse = () => ({ headers: { etag: "completed-etag" } });

test("three concurrent parts finish out of order, but completion is ordered and awaited", async () => {
  const file = fileOf(SIZE_LIMIT * 4 + 17);
  const pending = new Map();
  const progress = [];
  const states = [];
  const final = deferred();
  let active = 0, maximum = 0, completeParts, settled = false;
  globalThis.axios = {
    post(url, body) {
      assert.ok(url.startsWith("/api/write/items/temp/a%23b%3F.dpk?"));
      if (url.endsWith("?uploads")) return Promise.resolve({ data: { uploadId: "session" } });
      completeParts = body.parts;
      return final.promise;
    },
    put(url, chunk, config) {
      const number = Number(new URL(url, "https://test.invalid").searchParams.get("partNumber"));
      const wait = deferred();
      active++; maximum = Math.max(maximum, active);
      assert.ok(chunk.size <= SIZE_LIMIT);
      config.onUploadProgress({ loaded: chunk.size / 2 });
      pending.set(number, { wait, chunk });
      return wait.promise.finally(() => { active--; });
    },
  };
  const running = multipartUpload("temp/a#b?.dpk", file, {
    onUploadProgress: (event) => progress.push(event),
    onUploadState: (state) => states.push(state),
  });
  running.then(() => { settled = true; });
  await tick();
  assert.equal(pending.size, 3);
  pending.get(3).wait.resolve(partResponse(3)); await tick();
  assert.ok(pending.has(4));
  pending.get(1).wait.resolve(partResponse(1)); await tick();
  assert.ok(pending.has(5));
  for (const number of [5, 2, 4]) pending.get(number).wait.resolve(partResponse(number));
  await tick();
  assert.equal(maximum, 3);
  assert.deepEqual(completeParts.map((part) => part.partNumber), [1, 2, 3, 4, 5]);
  assert.equal(completeParts[4].etag, "etag-5");
  assert.equal(progress.at(-1).loaded, file.size);
  assert.ok(progress.every((event) => event.loaded >= 0 && event.loaded <= event.total));
  assert.equal(states.at(-1), "completing");
  assert.equal(settled, false);
  final.resolve(completeResponse());
  await running;
  assert.equal(states.at(-1), "completed");
});

test("a transient part error retries that part without double-counting progress", async () => {
  const file = fileOf(SIZE_LIMIT + 19);
  const attempts = new Map(), progress = [];
  let completedParts;
  globalThis.axios = {
    async post(url, body) {
      if (url.endsWith("?uploads")) return { data: { uploadId: "session" } };
      completedParts = body.parts; return completeResponse();
    },
    async put(url, chunk, config) {
      const number = Number(new URL(url, "https://test.invalid").searchParams.get("partNumber"));
      attempts.set(number, (attempts.get(number) || 0) + 1);
      config.onUploadProgress({ loaded: chunk.size });
      if (number === 1 && attempts.get(number) === 1) {
        throw Object.assign(new Error("temporary"), { response: { status: 503 } });
      }
      return partResponse(number);
    },
  };
  await multipartUpload("temp/sample.dpk", file, {
    concurrency: 1, retryDelay: 0, onUploadProgress: (event) => progress.push(event),
  });
  assert.equal(attempts.get(1), 2);
  assert.equal(attempts.get(2), 1);
  assert.deepEqual(completedParts.map((part) => part.partNumber), [1, 2]);
  assert.equal(progress.at(-1).loaded, file.size);
  assert.ok(progress.every((event) => event.loaded <= file.size));
});

test("a terminal part failure stops new scheduling and never completes a partial object", async () => {
  const failure = Object.assign(new Error("forbidden"), { response: { status: 403 } });
  const started = []; let completes = 0;
  globalThis.axios = {
    async post(url) {
      if (url.endsWith("?uploads")) return { data: { uploadId: "session" } };
      completes++; return completeResponse();
    },
    async put(url) {
      const number = Number(new URL(url, "https://test.invalid").searchParams.get("partNumber"));
      started.push(number);
      if (number === 1) throw failure;
      await tick(); return partResponse(number);
    },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT * 5)), (e) => e === failure);
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(completes, 0);
});

test("transient retry attempts are bounded", async () => {
  let attempts = 0, completes = 0;
  globalThis.axios = {
    async post(url) {
      if (url.endsWith("?uploads")) return { data: { uploadId: "session" } };
      completes++; return completeResponse();
    },
    async put() {
      attempts++;
      throw Object.assign(new Error("network"), { isAxiosError: true, code: "ERR_NETWORK" });
    },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT), { retryDelay: 0 }));
  assert.equal(attempts, 3);
  assert.equal(completes, 0);
});

test("HTTP 200 login HTML and missing part acknowledgments are rejected", async () => {
  let puts = 0, completes = 0;
  globalThis.axios = {
    async post() { return { data: "<html>Sign in</html>" }; },
    async put() { puts++; },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT)), /authorization/);
  assert.equal(puts, 0);
  globalThis.axios = {
    async post(url) {
      if (url.endsWith("?uploads")) return { data: { uploadId: "session" } };
      completes++; return completeResponse();
    },
    async put() { return { data: { partNumber: 1 } }; },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT)), /confirm an uploaded part/);
  assert.equal(completes, 0);
});

test("completion failure propagates instead of reporting success or creating another upload", async () => {
  const failure = Object.assign(new Error("completion failed"), { response: { status: 400 } });
  let creates = 0, completes = 0;
  globalThis.axios = {
    async post(url) {
      if (url.endsWith("?uploads")) { creates++; return { data: { uploadId: "session" } }; }
      completes++; throw failure;
    },
    async put() { return partResponse(1); },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT)), (e) => e === failure);
  assert.equal(creates, 1); assert.equal(completes, 1);
});

test("a completion response without the storage ETag does not count as success", async () => {
  globalThis.axios = {
    async post(url) {
      return url.endsWith("?uploads") ? { data: { uploadId: "session" } } :
        { data: "<html>Sign in</html>", headers: { "content-type": "text/html" } };
    },
    async put() { return partResponse(1); },
  };
  await assert.rejects(multipartUpload("temp/sample.dpk", fileOf(SIZE_LIMIT)), /completion could not be confirmed/);
});

async function appContext(axios = {}) {
  const source = await readFile(new URL("../assets/App.vue", import.meta.url), "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?;\s*/gm, "")
    .replace("export default", "globalThis.component =");
  const context = {
    URL, window: { location: "https://test.invalid/?p=temp/" },
    performance, setTimeout, axios, console,
    fetch: async () => ({ redirected: false }),
    Dialog: {}, Menu: {}, MimeIcon: {}, UploadPopup: {},
    multipartUpload, generateThumbnail: () => {}, blobDigest: () => {},
    SIZE_LIMIT,
  };
  vm.runInNewContext(script, context, { filename: "App.vue" });
  const app = context.component.data();
  for (const [name, method] of Object.entries(context.component.methods)) app[name] = method.bind(app);
  app.fetchFiles = () => {};
  return app;
}

test("adding files while uploading keeps one FIFO queue runner", async () => {
  const app = await appContext();
  const first = deferred(), seen = [];
  app.uploadFile = async (task) => {
    seen.push(task.file.name);
    if (task.file.name === "first") await first.promise;
  };
  app.uploadQueue.push({ file: { name: "first" } }, { file: { name: "second" } });
  const running = app.processUploadQueue();
  await tick();
  app.uploadFiles([{ name: "third" }]);
  await app.processUploadQueue();
  assert.deepEqual(seen, ["first"]);
  first.resolve(); await running;
  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.equal(app.uploading, false);
  assert.equal(app.uploadStatus, "Uploads complete.");
});

test("small-file login HTML leaves a visible upload failure", async () => {
  const app = await appContext({ put: async () => ({ data: "<html>Sign in</html>" }) });
  app.uploadQueue.push({ basedir: "temp/", file: fileOf(25) });
  await app.processUploadQueue();
  assert.equal(app.uploadErrors.length, 1);
  assert.match(app.uploadErrors[0], /Storage did not confirm/);
  assert.equal(app.uploadStatus, "Uploads finished with errors.");
  assert.equal(app.uploading, false);
});
