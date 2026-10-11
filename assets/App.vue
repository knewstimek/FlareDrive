<template>
  <div class="main" @dragenter.prevent @dragover.prevent @drop.prevent="onDrop">
    <div class="management-auth">
      <div class="management-auth-status" role="status" aria-live="polite">
        <span class="management-auth-dot" :data-state="writeAuthState"></span>
        <strong>{{ managementAuthLabel }}</strong>
        <small>{{ writeAuthState === 'authenticated' ? '업로드와 삭제를 사용할 수 있어요.' : '파일 관리는 관리자 인증이 필요해요.' }}</small>
      </div>
      <button class="management-auth-button" @click="signIn" :disabled="writeAuthBusy || writeAuthState === 'checking'">
        {{ writeAuthBusy ? '확인 중…' : writeAuthState === 'authenticated' ? '인증 상태 확인' : '관리자 로그인' }}
      </button>
      <span v-if="writeError" class="management-auth-error" role="alert">{{ writeError }}</span>
    </div>
    <section v-if="uploadJobs.length" class="upload-panel" aria-label="업로드">
      <header class="upload-panel-header">
        <div><strong>업로드</strong><small>{{ uploadQueue.length }}개 대기 · {{ uploadJobs.filter(job => job.status === 'done').length }}개 완료</small></div>
        <button v-if="uploading || uploadQueue.length" @click="cancelAllUploads">전체 취소</button>
        <button v-else @click="clearUploads">목록 닫기</button>
      </header>
      <div class="upload-status" role="status" aria-live="polite">{{ uploadSummary() }}</div>
      <article v-for="job in uploadJobs" :key="job.id" class="upload-job">
        <div class="upload-job-heading">
          <strong :title="job.file.name">{{ job.file.name }}</strong>
          <span class="upload-badge" :data-state="job.status">{{ uploadLabel(job) }}</span>
        </div>
        <progress :value="job.percent" max="100" :aria-label="job.file.name + ' 업로드 진행률'"></progress>
        <div class="upload-job-details">
          <span>{{ Math.floor(job.percent) }}% · {{ formatSize(job.sent) }} / {{ formatSize(job.file.size) }}</span>
          <span>전송속도 {{ formatSize(job.speed) }}/s</span>
          <span>{{ remainingTime(job) }}</span>
        </div>
        <p v-if="job.error" class="upload-error" role="alert">{{ job.error }}</p>
        <div class="upload-job-actions">
          <button v-if="['queued', 'preparing', 'uploading', 'retrying', 'confirming'].includes(job.status)" @click="cancelUpload(job)">취소</button>
          <button v-if="['failed', 'canceled'].includes(job.status)" @click="retryUpload(job)">다시 업로드</button>
        </div>
      </article>
    </section>
    <UploadPopup
      v-model="showUploadPopup"
      @upload="onUploadClicked"
      @createFolder="createFolder"
    ></UploadPopup>
    <button class="upload-button circle" @click="showUploadPopup = true">
      <img
        style="filter: invert(100%)"
        src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/upload_file/materialicons/36dp/2x/baseline_upload_file_black_36dp.png"
        alt="Upload"
        width="36"
        height="36"
        @contextmenu.prevent
      />
    </button>
    <div class="app-bar">
      <input type="search" v-model="search" aria-label="Search" />
      <div class="menu-button">
        <button class="circle" @click="showMenu = true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 448 512"
            width="24"
            height="24"
            title="Menu"
            style="display: block; margin: 4px"
          >
            <!--! Font Awesome Pro 6.2.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. -->
            <path
              d="M120 256c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm160 0c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm104 56c-30.9 0-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56s-25.1 56-56 56z"
            />
          </svg>
        </button>
        <Menu
          v-model="showMenu"
          :items="[{ text: 'Name' }, { text: 'Size' }, { text: 'Paste' }]"
          @click="onMenuClick"
        />
      </div>
    </div>
    <ul class="file-list">
      <li v-if="cwd !== ''">
        <div
          tabindex="0"
          class="file-item"
          @click="cwd = cwd.replace(/[^\/]+\/$/, '')"
          @contextmenu.prevent
        >
          <div class="file-icon">
            <img
              src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png"
              width="36"
              height="36"
              alt="Folder"
            />
          </div>
          <span class="file-name">..</span>
        </div>
      </li>
      <li v-for="folder in filteredFolders" :key="folder">
        <div
          tabindex="0"
          class="file-item"
          @click="cwd = folder"
          @contextmenu.prevent="
            showContextMenu = true;
            focusedItem = folder;
          "
        >
          <div class="file-icon">
            <img
              src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png"
              width="36"
              height="36"
              alt="Folder"
            />
          </div>
          <span
            class="file-name"
            v-text="folder.match(/.*?([^/]*)\/?$/)[1]"
          ></span>
        </div>
      </li>
      <li v-for="file in filteredFiles" :key="file.key">
        <a
          :href="`/raw/${file.key}`"
          target="_blank"
          @contextmenu.prevent="
            showContextMenu = true;
            focusedItem = file;
          "
        >
          <div class="file-item">
            <MimeIcon
              :content-type="file.httpMetadata.contentType"
              :thumbnail="
                file.customMetadata.thumbnail
                  ? `/raw/_$flaredrive$/thumbnails/${file.customMetadata.thumbnail}.png`
                  : null
              "
            />
            <div>
              <div class="file-name" v-text="file.key.split('/').pop()"></div>
              <div class="file-attr">
                <span v-text="new Date(file.uploaded).toLocaleString()"></span>
                <span v-text="formatSize(file.size)"></span>
              </div>
            </div>
          </div>
        </a>
      </li>
    </ul>
    <div v-if="loading" style="margin-top: 12px; text-align: center">
      <span>Loading...</span>
    </div>
    <div
      v-else-if="!filteredFiles.length && !filteredFolders.length"
      style="margin-top: 12px; text-align: center"
    >
      <span>No files</span>
    </div>
    <Dialog v-model="showContextMenu">
      <div
        v-text="focusedItem.key || focusedItem"
        class="contextmenu-filename"
        @click.stop.prevent
      ></div>
      <ul v-if="typeof focusedItem === 'string'" class="contextmenu-list">
        <li>
          <button @click="copyLink(`/?p=${encodeURIComponent(focusedItem)}`)">
            <span>Copy Link</span>
          </button>
        </li>
        <li>
          <button
            style="color: red"
            @click="removeFile(focusedItem + '_$folder$')"
          >
            <span>Remove</span>
          </button>
        </li>
      </ul>
      <ul v-else class="contextmenu-list">
        <li>
          <button @click="renameFile(focusedItem.key)">
            <span>Rename</span>
          </button>
        </li>
        <li>
          <button @click="clipboard = focusedItem.key">
            <span>Copy</span>
          </button>
        </li>
        <li>
          <a :href="`/raw/${focusedItem.key}`" target="_blank" download>
            <span>Download</span>
          </a>
        </li>
        <li>
          <button @click="copyLink(`/raw/${focusedItem.key}`)">
            <span>Copy Link</span>
          </button>
        </li>
        <li>
          <button style="color: red" @click="removeFile(focusedItem.key)">
            <span>Remove</span>
          </button>
        </li>
      </ul>
    </Dialog>
  </div>
</template>

<script>
import {
  generateThumbnail,
  blobDigest,
  multipartUpload,
  SIZE_LIMIT,
} from "/assets/main.mjs";
import Dialog from "./Dialog.vue";
import Menu from "./Menu.vue";
import MimeIcon from "./MimeIcon.vue";
import UploadPopup from "./UploadPopup.vue";

export default {
  data: () => ({
    clipboard: null,
    cwd: new URL(window.location.href || window.location).searchParams.get("p") || "",
    files: [],
    folders: [],
    focusedItem: null,
    loading: false,
    order: null,
    search: "",
    showContextMenu: false,
    showMenu: false,
    showUploadPopup: false,
    uploadProgress: null,
    uploadQueue: [],
    uploading: false,
    uploadStatus: "",
    uploadErrors: [],
    uploadJobs: [],
    nextUploadId: 0,
    writeError: "",
    writeAuthState: "checking",
    writeAuthBusy: false,
  }),

  computed: {
    managementAuthLabel() {
      return {
        checking: "인증 확인 중…",
        authenticated: "관리자 로그인됨",
        required: "로그인 필요",
        unknown: "인증 상태 확인 필요",
      }[this.writeAuthState];
    },

    filteredFiles() {
      let files = this.files;
      if (this.search) {
        files = files.filter((file) =>
          file.key.split("/").pop().includes(this.search)
        );
      }
      return files;
    },

    filteredFolders() {
      let folders = this.folders;
      if (this.search) {
        folders = folders.filter((folder) => folder.includes(this.search));
      }
      return folders;
    },
  },

  methods: {
    writeLoginUrl() {
      const url = new URL("/api/write/login", window.location.href || window.location);
      if (this.cwd) url.searchParams.set("p", this.cwd);
      return url.pathname + url.search;
    },

    async probeWriteAccess() {
      const response = await fetch(this.writeLoginUrl(), {
        credentials: "same-origin", redirect: "manual", cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (response.status === 204) {
        this.writeAuthState = "authenticated";
        return true;
      }
      if (response.type === "opaqueredirect" || [401, 403].includes(response.status)) {
        this.writeAuthState = "required";
        return false;
      }
      this.writeAuthState = "unknown";
      throw new Error("인증 상태를 확인하지 못했습니다.");
    },

    async refreshWriteAccess() {
      try {
        await this.probeWriteAccess();
      } catch {
        this.writeAuthState = "unknown";
      }
    },

    async ensureWriteAccess() {
      if (await this.probeWriteAccess()) return true;
      this.writeError = "관리자 로그인 후 작업을 다시 실행해 주세요.";
      window.location.assign(this.writeLoginUrl());
      return false;
    },

    async signIn() {
      if (this.writeAuthBusy) return;
      this.writeAuthBusy = true;
      this.writeError = "";
      try {
        await this.ensureWriteAccess();
      } catch {
        this.writeAuthState = "unknown";
        this.writeError = "인증 상태를 확인하지 못했습니다. 다시 시도해 주세요.";
      } finally {
        this.writeAuthBusy = false;
      }
    },

    copyLink(link) {
      const url = new URL(link, window.location.origin);
      navigator.clipboard.writeText(url.toString());
    },

    async copyPaste(source, target) {
      const uploadUrl = `/api/write/items/${target}`;
      await axios.put(uploadUrl, "", {
        headers: { "x-amz-copy-source": encodeURIComponent(source) },
      });
    },

    async createFolder() {
      try {
        const folderName = window.prompt("Folder name");
        if (!folderName) return;
        this.showUploadPopup = false;
        const uploadUrl = `/api/write/items/${this.cwd}${folderName}/_$folder$`;
        await axios.put(uploadUrl, "");
        this.fetchFiles();
      } catch (error) {
        fetch("/api/write/")
          .then((value) => {
            if (value.redirected) window.location.href = value.url;
          })
          .catch(() => {});
        console.log(`Create folder failed`);
      }
    },

    fetchFiles() {
      this.files = [];
      this.folders = [];
      this.loading = true;
      fetch(`/api/children/${this.cwd}`)
        .then((res) => res.json())
        .then((files) => {
          this.files = files.value;
          if (this.order) {
            this.files.sort((a, b) => {
              if (this.order === "size") {
                return b.size - a.size;
              }
            });
          }
          this.folders = files.folders;
          this.loading = false;
        });
    },

    formatSize(size) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (size >= 1000) {
        size /= 1000;
        i++;
      }
      return `${size.toFixed(1)} ${units[i]}`;
    },

    onDrop(ev) {
      let files;
      if (ev.dataTransfer.items) {
        files = [...ev.dataTransfer.items]
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile());
      } else files = ev.dataTransfer.files;
      this.uploadFiles(files);
    },

    onMenuClick(text) {
      switch (text) {
        case "Name":
          this.order = null;
          break;
        case "Size":
          this.order = "size";
          break;
        case "Paste":
          return this.pasteFile();
      }
      let compareFn = undefined;
      if (this.order === "size") compareFn = (a, b) => b.size - a.size;
      this.files.sort(compareFn);
    },

    onUploadClicked(fileElement) {
      if (!fileElement.value) return;
      this.uploadFiles(fileElement.files);
      this.showUploadPopup = false;
      fileElement.value = null;
    },

    async pasteFile() {
      if (!this.clipboard) return;
      let newName = window.prompt("Rename to:");
      if (newName === null) return;
      if (newName === "") newName = this.clipboard.split("/").pop();
      await this.copyPaste(this.clipboard, `${this.cwd}${newName}`);
      this.fetchFiles();
    },

    uploadSummary() {
      return { "Uploads complete.": "업로드가 모두 완료되었습니다.",
        "Uploads finished with errors.": "업로드 종료 · 실패한 파일을 확인해 주세요." }[this.uploadStatus] || this.uploadStatus;
    },

    uploadLabel(job) {
      if (job.status === "uploading" && job.waiting) return "파트 저장 확인 중";
      return { queued: "대기", preparing: "준비 중", uploading: "전송 중", retrying: "재시도 중",
        confirming: "저장 확인 중", completing: "최종 저장 중", done: "완료",
        failed: "실패", canceled: "취소됨" }[job.status] || job.status;
    },

    remainingTime(job) {
      if (job.status === "done") return "저장 완료";
      if (["confirming", "completing"].includes(job.status)) return "서버 확인 대기";
      if (job.waiting && job.status === "uploading") return "서버 응답 대기";
      if (!job.speed || job.status !== "uploading") return "남은 시간 —";
      const seconds = Math.ceil(Math.max(0, job.file.size - job.sent) / job.speed);
      return seconds >= 60 ? `약 ${Math.ceil(seconds / 60)}분 남음` : `약 ${seconds}초 남음`;
    },

    cancelUpload(job) {
      if (["done", "failed", "canceled", "completing"].includes(job.status)) return;
      job.controller?.abort();
      job.status = "canceled";
      this.uploadQueue = this.uploadQueue.filter(task => task.id !== job.id);
    },

    cancelAllUploads() {
      this.uploadJobs.forEach(job => this.cancelUpload(job));
    },

    retryUpload(job) {
      if (!["failed", "canceled"].includes(job.status) || job.running) return;
      job.status = "queued"; job.error = ""; job.percent = 0; job.sent = 0; job.speed = 0;
      this.uploadQueue.push(job);
      this.processUploadQueue();
    },

    clearUploads() {
      if (!this.uploading) { this.uploadJobs = []; this.uploadStatus = ""; this.uploadErrors = []; }
    },

    async processUploadQueue() {
      if (this.uploading || !this.uploadQueue.length) return;
      this.uploading = true;
      this.uploadErrors = [];
      try {
        while (this.uploadQueue.length) {
          const task = this.uploadQueue.shift();
          if (task.status === "canceled") continue;
          task.running = true;
          try {
            await this.uploadFile(task);
            task.status = "done";
          } catch (error) {
            if (task.controller?.signal.aborted || error.code === "ERR_CANCELED") {
              task.status = "canceled";
              task.error = error.cleanupFailed ? "전송은 중단했습니다. 임시 업로드 정리를 확인하지 못했습니다." : "";
            } else {
              task.status = "failed";
              const status = error.response?.status;
              task.error = status === 401 || status === 403 ? "업로드 권한 또는 로그인을 확인해 주세요." :
                status === 413 ? "요청 크기 제한으로 실패했습니다." :
                error.code === "ECONNABORTED" ? "응답 시간이 초과되었습니다. 연결을 확인하고 다시 시도하세요." :
                `업로드 실패: ${error.message}`;
              this.uploadErrors.push(task.error);
            }
          } finally { task.running = false; task.controller = null; if (["failed", "canceled"].includes(task.status)) task.speed = 0; }
        }
        this.uploadStatus = this.uploadErrors.length ? "Uploads finished with errors." :
          this.uploadJobs.some(job => job.status === "canceled") ? "업로드 종료 · 취소한 파일이 있습니다." : "Uploads complete.";
        this.fetchFiles();
      } finally {
        this.uploading = false;
        this.uploadProgress = null;
      }
    },

    async uploadFile(job) {
      const { basedir, file } = job;
      const controller = new AbortController();
      job.controller = controller;
      job.status = "preparing";
      this.uploadProgress = 0;
      this.uploadStatus = `준비 중: ${file.name}`;
      const started = performance.now();
      let lastByteAt = started;
      let previousTime = started, previousSent = 0;
      const updateStatus = () => {
        const now = performance.now();
        job.waiting = now - lastByteAt >= 2000;
        const dt = (now - previousTime) / 1000;
        if (dt >= 0.5) {
          const rate = Math.max(0, job.sent - previousSent) / dt;
          job.speed = job.speed ? job.speed * 0.5 + rate * 0.5 : rate;
          previousTime = now; previousSent = job.sent;
        }
        this.uploadStatus = `${this.uploadLabel(job)}: ${file.name}`;
      };
      const timer = setInterval(updateStatus, 1000);
      try {
        let thumbnailDigest = null;
        if (file.type.startsWith("image/") || file.type === "video/mp4") {
          try {
            const thumbnailBlob = await generateThumbnail(file);
            if (controller.signal.aborted) throw Object.assign(new Error("Upload canceled."), { code: "ERR_CANCELED" });
            const digestHex = await blobDigest(thumbnailBlob);
            await axios.put(`/api/write/items/_$flaredrive$/thumbnails/${digestHex}.png`, thumbnailBlob,
              { signal: controller.signal, timeout: 30000 });
            thumbnailDigest = digestHex;
          } catch (error) {
            if (controller.signal.aborted) throw error;
          }
        }
        if (controller.signal.aborted) throw Object.assign(new Error("Upload canceled."), { code: "ERR_CANCELED" });
        const uploadUrl = "/api/write/items/" + (basedir + file.name).split("/").map(encodeURIComponent).join("/");
        const headers = {};
        if (thumbnailDigest) headers["fd-thumbnail"] = thumbnailDigest;
        const onUploadProgress = event => {
          if (event.loaded !== job.sent) lastByteAt = performance.now();
          job.sent = event.loaded;
          job.percent = Math.min(99, event.loaded * 100 / (event.total || file.size || 1));
          this.uploadProgress = job.percent;
          if (event.loaded === file.size && job.status === "uploading") job.status = "confirming";
          updateStatus();
        };
        job.status = "uploading";
        if (file.size >= SIZE_LIMIT) {
          await multipartUpload(basedir + file.name, file, {
            headers, signal: controller.signal, onUploadProgress,
            onUploadState: state => { if (job.status !== "canceled") job.status = state === "completed" ? "done" : state; updateStatus(); },
          });
        } else {
          const response = await axios.put(uploadUrl, file, {
            headers, signal: controller.signal, timeout: 300000, onUploadProgress,
          });
          if (response.data?.size !== file.size) throw new Error("Storage did not confirm the uploaded file.");
        }
        job.percent = 100; job.sent = file.size; job.status = "done";
        this.uploadProgress = 100;
      } finally { clearInterval(timer); }
    },

    async removeFile(key) {
      if (!window.confirm(`Delete ${key} permanently?`)) return;
      this.writeError = "";
      try {
        if (!(await this.ensureWriteAccess())) return;
        await axios.delete(`/api/write/items/${key}`, {
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        this.fetchFiles();
      } catch (error) {
        if ([401, 403].includes(error.response?.status)) {
          this.writeError = "관리자 로그인 후 삭제를 다시 실행해 주세요.";
          window.location.assign(this.writeLoginUrl());
        } else {
          this.writeError = "삭제하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.";
        }
      }
    },

    async renameFile(key) {
      const newName = window.prompt("Rename to:");
      if (!newName) return;
      await this.copyPaste(key, `${this.cwd}${newName}`);
      await axios.delete(`/api/write/items/${key}`);
      this.fetchFiles();
    },

    uploadFiles(files) {
      if (this.cwd && !this.cwd.endsWith("/")) this.cwd += "/";

      const uploadTasks = Array.from(files).map((file) => ({
        basedir: this.cwd,
        file, id: ++this.nextUploadId, status: "queued", percent: 0, sent: 0,
        speed: 0, error: "", controller: null, running: false, waiting: false,
      }));
      this.uploadJobs.push(...uploadTasks);
      this.uploadQueue.push(...uploadTasks);
      if (!this.uploading) setTimeout(() => this.processUploadQueue());
    },
  },

  watch: {
    cwd: {
      handler() {
        this.fetchFiles();
        const url = new URL(window.location);
        if ((url.searchParams.get("p") || "") !== this.cwd) {
          this.cwd
            ? url.searchParams.set("p", this.cwd)
            : url.searchParams.delete("p");
          window.history.pushState(null, "", url.toString());
        }
        document.title = `${
          this.cwd.replace(/.*\/(?!$)|\//g, "") || "/"
        } - FlareDrive`;
      },
      immediate: true,
    },
  },

  created() {
    this.refreshWriteAccess();
    window.addEventListener("popstate", (ev) => {
      const searchParams = new URL(window.location).searchParams;
      if (searchParams.get("p") !== this.cwd)
        this.cwd = searchParams.get("p") || "";
    });
  },

  components: {
    Dialog,
    Menu,
    MimeIcon,
    UploadPopup,
  },
};
</script>

<style>
.main {
  height: 100%;
}

.upload-panel { margin: 12px; padding: 16px; border: 1px solid #dce3ef; border-radius: 14px; background: #f8faff; box-shadow: 0 4px 16px #172d4d0a; }
.upload-panel-header, .upload-job-heading, .upload-job-details, .upload-job-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.upload-panel-header small { display: block; margin-top: 5px; color: #65748b; }
.upload-panel button { border: 1px solid #c9d5e7; background: white; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
.upload-panel button:hover { background: #eaf0fb; }
.upload-panel button:focus-visible { outline: 3px solid #5c8fe6; outline-offset: 2px; }
.upload-status { padding: 10px 0; color: #435574; overflow-wrap: anywhere; }
.upload-job { background: white; padding: 14px; border-radius: 10px; margin-top: 8px; }
.upload-job-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.upload-badge { flex-shrink: 0; font-size: 12px; border-radius: 20px; padding: 4px 9px; background: #e8efff; color: #2859aa; }
.upload-badge[data-state="failed"] { background: #ffe7e7; color: #a40000; }
.upload-badge[data-state="done"] { background: #def4e7; color: #166438; }
.upload-badge[data-state="canceled"] { background: #eef0f3; color: #596373; }
.upload-job progress { display: block; position: static; width: 100%; height: 8px; margin: 12px 0; accent-color: #3978df; }
.upload-job-details { color: #586983; font-size: 12px; flex-wrap: wrap; }
.upload-job-actions { justify-content: flex-end; margin-top: 8px; }
.upload-error { margin: 10px 0 0; overflow-wrap: anywhere; color: #a40000; }
@media (max-width: 600px) { .upload-panel { margin: 8px; padding: 10px; } .upload-job-details { gap: 6px; } }

.app-bar {
  position: sticky;
  top: 0;
  padding: 8px;
  background-color: white;
  display: flex;
}

.menu-button {
  display: flex;
  position: relative;
  margin-left: 4px;
}

.menu-button > button {
  transition: background-color 0.2s ease;
}

.menu-button > button:hover {
  background-color: whitesmoke;
}

.menu {
  position: absolute;
  top: 100%;
  right: 0;
}
</style>
