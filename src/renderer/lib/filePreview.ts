/** Создаёт компактное превью, чтобы вложение было узнаваемо до скачивания полного файла. */
export async function createFilePreviewDataUrl(
  file: Blob,
  opts?: { mime?: string; name?: string }
): Promise<string | undefined> {
  const mime = (opts?.mime || file.type || "").toLowerCase();
  const name = (opts?.name || "").toLowerCase();
  const isImage = mime.startsWith("image/");
  const isVideo =
    mime.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i.test(name);

  if (isImage) {
    // В чат уходит уменьшенный кадр: полный файл передаётся отдельно и не раздувает сообщение.
    return await new Promise<string | undefined>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      let settled = false;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(value);
      };
      const timeoutId = window.setTimeout(() => finish(undefined), 8000);
      img.onload = () => {
        window.clearTimeout(timeoutId);
        try {
          const width = img.naturalWidth || 1;
          const height = img.naturalHeight || 1;
          const scale = Math.min(1, 480 / width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            finish(undefined);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL("image/jpeg", 0.82));
        } catch {
          finish(undefined);
        }
      };
      img.onerror = () => {
        window.clearTimeout(timeoutId);
        finish(undefined);
      };
      img.src = url;
    });
  }

  if (!isVideo) return undefined;

  return await new Promise<string | undefined>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    // Единый путь завершения освобождает URL и элемент при успехе, ошибке или тайм-ауте.
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // Ошибка очистки временного элемента не должна мешать возврату результата.
      }
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timeoutId = window.setTimeout(() => finish(undefined), 8000);

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    video.onloadeddata = () => {
      try {
        const t = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration * 0.1) : 0.1;
        video.currentTime = t;
      } catch {
        finish(undefined);
      }
    };

    video.onseeked = () => {
      try {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (!w || !h) {
          window.clearTimeout(timeoutId);
          finish(undefined);
          return;
        }
        const maxW = 480;
        const scale = Math.min(1, maxW / w);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          window.clearTimeout(timeoutId);
          finish(undefined);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        window.clearTimeout(timeoutId);
        finish(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        window.clearTimeout(timeoutId);
        finish(undefined);
      }
    };

    video.onerror = () => {
      window.clearTimeout(timeoutId);
      finish(undefined);
    };
  });
}

export function isVideoAttachmentMime(mime?: string, name?: string) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  return m.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i.test(n);
}

export function isImageAttachmentMime(mime?: string, name?: string) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  return m.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n);
}

export function mimeFromName(name: string) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    json: "application/json"
  };
  return map[ext] || "application/octet-stream";
}

export function isGifAttachmentMime(mime?: string, name?: string) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  return m === "image/gif" || n.endsWith(".gif");
}
