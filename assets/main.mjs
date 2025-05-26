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

export const SIZE_LIMIT = 95 * 1000 * 1000; // 100MB
const MIN_PART_SIZE    = 5 * 1_024 * 1_024;        // 5 MiB – R2 최소 크기

/**
 * @param {string} key
 * @param {File} file
 * @param {Record<string, any>} options
 */
export async function multipartUpload(key, file, options) {
  const headers = { ...(options?.headers || {}) };
  headers["content-type"] = file.type || "application/octet-stream";

  // 1) 업로드 세션 생성
  const uploadId = await axios
    .post(`/api/write/items/${key}?uploads`, "", { headers })
    .then((res) => res.data.uploadId);

  // 2) 파트 사이즈 계산 (마지막 파트 ≥ 5 MiB 보장)
  let partSize = SIZE_LIMIT;
  const partsNeeded = Math.ceil(file.size / partSize);
  if (file.size % partSize && file.size % partSize < MIN_PART_SIZE) {
    // 마지막 파트가 너무 작으면 파트 크기를 줄여 재계산
    partSize = Math.ceil(file.size / (partsNeeded - 1));
  }

  // 3) 각 파트 전송
  const uploadedParts = [];
  for (let partNumber = 1, offset = 0; offset < file.size; partNumber++) {
    const chunk = file.slice(offset, offset + partSize);
    offset += chunk.size;

    const qs = new URLSearchParams({
      partNumber: partNumber.toString(),
      uploadId,                     // URLSearchParams 가 안전하게 인코딩
    });

    const { headers: resHeaders } = await axios.put(
      `/api/write/items/${key}?${qs}`,
      chunk,
      {
        headers,
        onUploadProgress: (e) => {
          options?.onUploadProgress?.({
            loaded: offset - chunk.size + e.loaded,
            total:  file.size,
          });
        },
      },
    );

    uploadedParts.push({
      PartNumber: partNumber,
      ETag:       resHeaders.etag.replace(/"/g, ""), // 따옴표 제거
    });
  }

  // 4) 업로드 완료
  const finishQs = new URLSearchParams({ uploadId });
  await axios.post(`/api/write/items/${key}?${finishQs}`, {
    parts: uploadedParts,
  });
}
