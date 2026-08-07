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
    try {
      return await new Promise<string | undefined>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      });
    } catch {
      return undefined;
    }
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
