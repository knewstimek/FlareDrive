const THUMBNAIL_SIZE = 144;

/**
 * @param {File} file
 */
export async function generateThumbnail(file) {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  var ctx = canvas.getContext("2d");

  /** @type HTMLImageElement */
  if (file.type.startsWith("image/")) {
    const image = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.src = URL.createObjectURL(file);
    });
    ctx.drawImage(image, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  } else if (file.type === "video/mp4") {
    // Generate thumbnail from video
    const video = await new Promise(async (resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(file);
      setTimeout(() => reject(new Error("Video load timeout")), 2000);
      await video.play();
      await video.pause();
      video.currentTime = 0;
      resolve(video);
    });
    ctx.drawImage(video, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  }

  /** @type Blob */
  const thumbnailBlob = await new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob))
  );

  return thumbnailBlob;
}

/**
 * @param {Blob} blob
 */
export async function blobDigest(blob) {
  const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
  const digestArray = Array.from(new Uint8Array(digest));
  const digestHex = digestArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return digestHex;
}

export const SIZE_LIMIT = 95 * 1000 * 1000;
export const UPLOAD_CONCURRENCY = 3;

/**
 * Upload parts concurrently, keeping completion ordered and awaited.
 * @param {string} key
 * @param {File} file
 * @param {Record<string, any>} options
 */
export async function multipartUpload(key, file, options = {}) {
  const headers = { ...options.headers, "content-type": file.type };
  const uploadUrl = "/api/write/items/" + key.split("/").map(encodeURIComponent).join("/");
  const notifyState = (stage) => options.onUploadState?.(stage);
  const created = await axios.post(uploadUrl + "?uploads", "", {
    headers,
    timeout: 30000,
  });
  const uploadId = created.data?.uploadId;
  if (typeof uploadId !== "string" || !uploadId) {
    throw new Error("Upload authorization or initialization failed.");
  }

  const totalChunks = Math.ceil(file.size / SIZE_LIMIT);
  const concurrency = Math.max(1, Math.min(4,
    Math.floor(options.concurrency || UPLOAD_CONCURRENCY)));
  const loaded = new Array(totalChunks).fill(0);
  const uploadedParts = new Array(totalChunks);
  let totalLoaded = 0;
  let nextPart = 0;
  let failure = null;

  function reportProgress(index, bytes) {
    const partSize = Math.min(SIZE_LIMIT, file.size - index * SIZE_LIMIT);
    const current = Math.min(partSize, Math.max(0, bytes));
    totalLoaded += current - loaded[index];
    loaded[index] = current;
    options.onUploadProgress?.({ loaded: totalLoaded, total: file.size });
    if (totalLoaded === file.size) notifyState("confirming");
  }

  async function uploadPart(index) {
    const partNumber = index + 1;
    const chunk = file.slice(index * SIZE_LIMIT, (index + 1) * SIZE_LIMIT);
    const params = new URLSearchParams({ partNumber, uploadId });
    for (let attempt = 0; ; attempt++) {
      if (failure) throw failure;
      try {
        const response = await axios.put(uploadUrl + "?" + params, chunk, {
          headers,
          timeout: 300000,
          onUploadProgress: (event) => reportProgress(index, event.loaded),
        });
        if (response.data?.partNumber !== partNumber ||
            typeof response.data?.etag !== "string" || !response.data.etag) {
          throw new Error("Storage did not confirm an uploaded part.");
        }
        uploadedParts[index] = { partNumber, etag: response.data.etag };
        reportProgress(index, chunk.size);
        return;
      } catch (error) {
        const status = error.response?.status;
        const transient = status === 408 || status === 429 || status >= 500 ||
          (!error.response && error.isAxiosError && error.code !== "ERR_CANCELED");
        if (failure || !transient || attempt >= 2) throw error;
        reportProgress(index, 0);
        notifyState("retrying");
        await new Promise((resolve) =>
          setTimeout(resolve, (options.retryDelay ?? 1000) * 2 ** attempt));
        notifyState("uploading");
      }
    }
  }

  async function worker() {
    while (!failure && nextPart < totalChunks) {
      const index = nextPart++;
      try {
        await uploadPart(index);
      } catch (error) {
        failure ||= error;
      }
    }
  }

  notifyState("uploading");
  await Promise.all(Array.from({ length: Math.min(concurrency, totalChunks) }, worker));
  if (failure) throw failure;

  notifyState("completing");
  const params = new URLSearchParams({ uploadId });
  const completed = await axios.post(uploadUrl + "?" + params,
    { parts: uploadedParts }, { headers, timeout: 60000 });
  if (typeof completed.headers?.etag !== "string" || !completed.headers.etag) {
    throw new Error("Storage completion could not be confirmed. Check the file before retrying.");
  }
  notifyState("completed");
  return completed;
}
