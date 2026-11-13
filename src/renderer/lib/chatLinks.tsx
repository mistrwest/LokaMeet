import React, { useEffect, useState } from "react";

const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"'()]+)/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|bmp|svg|avif|ico)(\?|#|$)/i;
const ANIM_EXT_RE = /\.(gif|apng|webp)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)(\?|#|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba)(\?|#|$)/i;

export function normalizeChatUrl(raw: string): string {
  const trimmed = raw.replace(/[.,;:!?]+$/g, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
}

export function extractHttpUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    const href = normalizeChatUrl(m[1] ?? m[0]);
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.searchParams.get("v") && /^[\w-]{11}$/.test(u.searchParams.get("v") || "")) {
        return u.searchParams.get("v");
      }
      const parts = u.pathname.split("/").filter(Boolean);
      if ((parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") && parts[1] && /^[\w-]{11}$/.test(parts[1])) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type ChatLinkKind = "image" | "animation" | "video" | "audio" | "youtube";

export type ChatMediaKind = "image" | "animation" | "video" | "youtube" | "vk" | "embed";

export type ChatMediaView = {
  kind: ChatMediaKind;
  src: string;
  title?: string;
  pageUrl?: string;
};

export type ChatEmbedOpen = {
  href: string;
  kind: ChatLinkKind;
  previewSrc: string;
  openHref: string;
};

export type ChatLinkProbe = {
  kind: ChatLinkKind;
  previewUrl?: string;
  mediaUrl?: string;
};

export function classifyChatLink(url: string): ChatLinkKind | null {
  const path = url.split("?")[0]?.split("#")[0] ?? url;
  if (ANIM_EXT_RE.test(path) || ANIM_EXT_RE.test(url)) return "animation";
  if (IMAGE_EXT_RE.test(path) || IMAGE_EXT_RE.test(url)) return "image";
  if (VIDEO_EXT_RE.test(path) || VIDEO_EXT_RE.test(url)) return "video";
  if (AUDIO_EXT_RE.test(path) || AUDIO_EXT_RE.test(url)) return "audio";
  if (youtubeVideoId(url)) return "youtube";
  return null;
}

function decodeHttpParam(value: string): string | null {
  let current = value.trim();
  for (let i = 0; i < 2; i++) {
    if (/^https?:\/\//i.test(current)) return current;
    if (!/%[0-9a-f]{2}/i.test(current)) break;
    try {
      current = decodeURIComponent(current);
    } catch {
      break;
    }
  }
  return /^https?:\/\//i.test(current) ? current : null;
}

/** Картинка или ролик, спрятанные в query: Яндекс Картинки (img_url), Google, Bing и похожие. */
export function embeddedMediaFromUrl(url: string): { href: string; kind: ChatLinkKind } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const preferred = ["img_url", "imgurl", "image_url", "mediaurl", "media_url", "image", "img", "src"];
  const ordered: string[] = [];
  for (const key of preferred) {
    const value = parsed.searchParams.get(key);
    if (value) ordered.push(value);
  }
  for (const value of parsed.searchParams.values()) ordered.push(value);
  const seen = new Set<string>();
  for (const value of ordered) {
    const href = decodeHttpParam(value);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const kind = classifyChatLink(href);
    if (kind) return { href, kind };
  }
  return null;
}

export function isVideoPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (host === "vkvideo.ru" || host === "vk.com" || host === "m.vk.com" || host === "vk.ru") {
      return /\/(?:video|clip|live)(-?\d+)_(\d+)/.test(path);
    }
    if (host === "rutube.ru" || host.endsWith(".rutube.ru")) return /\/(?:video|shorts|play\/embed)\//.test(path);
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return /\/\d+/.test(path);
    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) return /\/video\//.test(path);
    if (host === "ok.ru" || host.endsWith(".ok.ru")) return /\/video\//.test(path);
    if (host === "coub.com") return /\/view\//.test(path);
    return false;
  } catch {
    return false;
  }
}

type ResolvedEmbed = { kind: ChatLinkKind; previewSrc: string; openHref: string };

const probeCache = new Map<string, ChatLinkProbe | null>();

function instantEmbed(url: string): ResolvedEmbed | null {
  const embedded = embeddedMediaFromUrl(url);
  if (embedded) return { kind: embedded.kind, previewSrc: embedded.href, openHref: embedded.href };
  const youtube = youtubeVideoId(url);
  if (youtube) return { kind: "youtube", previewSrc: `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg`, openHref: url };
  const sync = classifyChatLink(url);
  if (sync) return { kind: sync, previewSrc: url, openHref: url };
  if (isVideoPageUrl(url)) return { kind: "video", previewSrc: "", openHref: url };
  return null;
}

async function probeChatLink(url: string): Promise<ChatLinkProbe | null> {
  if (probeCache.has(url)) return probeCache.get(url) ?? null;
  try {
    const probed = await window.lokameet.app.linkProbe(url);
    const kind = probed?.kind;
    const hit =
      kind === "image" || kind === "animation" || kind === "video" || kind === "audio" || kind === "youtube" ? probed : null;
    probeCache.set(url, hit);
    return hit;
  } catch {
    probeCache.set(url, null);
    return null;
  }
}

export function vkEmbedSrc(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host !== "vk.com" && host !== "m.vk.com" && host !== "vk.ru" && host !== "vkvideo.ru") return null;
    const match = parsed.pathname.match(/\/(?:video|clip|live)(-?\d+)_(\d+)/);
    if (!match) return null;
    return `https://vk.com/video_ext.php?oid=${match[1]}&id=${match[2]}&hd=2&autoplay=1`;
  } catch {
    return null;
  }
}

export function pageEmbedSrc(url: string): { kind: "youtube" | "vk" | "embed"; src: string } | null {
  const youtube = youtubeVideoId(url);
  if (youtube) return { kind: "youtube", src: `https://www.youtube.com/embed/${youtube}?autoplay=1` };
  const vk = vkEmbedSrc(url);
  if (vk) return { kind: "vk", src: vk };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "rutube.ru" || host.endsWith(".rutube.ru")) {
      const id = parsed.pathname.match(/\/(?:video|shorts|play\/embed)\/([a-zA-Z0-9]+)/)?.[1];
      if (id) return { kind: "embed", src: `https://rutube.ru/play/embed/${id}` };
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      const id = parsed.pathname.match(/\/(\d+)/)?.[1];
      if (id) return { kind: "embed", src: `https://player.vimeo.com/video/${id}?autoplay=1` };
    }
  } catch {
    return null;
  }
  return null;
}

export function mediaViewFromEmbed(item: ChatEmbedOpen): ChatMediaView | null {
  if (item.kind === "audio") return null;
  if (item.kind === "image" || item.kind === "animation") {
    const src =
      item.kind === "animation"
        ? item.openHref || item.previewSrc || item.href
        : item.previewSrc || item.openHref || item.href;
    if (!src) return null;
    return { kind: item.kind, src, pageUrl: item.href };
  }
  const embedded = pageEmbedSrc(item.href) || pageEmbedSrc(item.openHref);
  if (embedded) return { kind: embedded.kind, src: embedded.src, pageUrl: item.href, title: item.previewSrc };
  const media = item.openHref || item.previewSrc || "";
  const path = media.split("?")[0]?.split("#")[0] ?? "";
  if (VIDEO_EXT_RE.test(path)) return { kind: "video", src: media, pageUrl: item.href };
  if (item.previewSrc) return { kind: "image", src: item.previewSrc, pageUrl: item.href };
  return null;
}

export function ChatMediaViewer(props: { view: ChatMediaView | null; onClose: () => void }) {
  useEffect(() => {
    if (!props.view) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.view, props.onClose]);

  if (!props.view) return null;
  const view = props.view;
  return (
    <div className="chatMediaViewer" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <div className="chatMediaViewerCard" onMouseDown={(event) => event.stopPropagation()}>
        <div className="chatMediaViewerBar">
          {view.pageUrl ? (
            <button type="button" className="btn" onClick={() => void window.lokameet.app.openExternal(view.pageUrl || view.src)}>
              {view.pageUrl.replace(/^https?:\/\//, "").slice(0, 48)}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        {view.kind === "image" || view.kind === "animation" ? (
          <img className="chatMediaViewerMedia" src={view.src} alt={view.title || ""} />
        ) : view.kind === "video" ? (
          <video className="chatMediaViewerMedia" src={view.src} controls autoPlay playsInline />
        ) : (
          <iframe
            className="chatMediaViewerFrame"
            src={view.src}
            title={view.title || "video"}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}

export function ChatLinkEmbeds(props: { text: string; onOpen: (item: ChatEmbedOpen) => void }) {
  const urls = extractHttpUrls(props.text);
  const [resolved, setResolved] = useState<Record<string, ResolvedEmbed | null>>({});

  useEffect(() => {
    let cancelled = false;
    const known: Record<string, ResolvedEmbed | null> = {};
    const pending: string[] = [];
    for (const href of urls) {
      const instant = instantEmbed(href);
      if (instant && instant.previewSrc) {
        known[href] = instant;
        continue;
      }
      if (instant) known[href] = instant;
      pending.push(href);
    }
    if (Object.keys(known).length > 0) setResolved((prev) => ({ ...prev, ...known }));
    if (pending.length === 0) return;
    void (async () => {
      const found: Record<string, ResolvedEmbed | null> = {};
      for (const href of pending) {
        const instant = instantEmbed(href);
        const probed = await probeChatLink(href);
        if (probed) {
          const previewSrc = probed.previewUrl || probed.mediaUrl || instant?.previewSrc || "";
          const openHref = probed.mediaUrl && classifyChatLink(probed.mediaUrl) ? probed.mediaUrl : instant?.openHref || href;
          found[href] = { kind: probed.kind, previewSrc, openHref };
        } else {
          found[href] = instant;
        }
      }
      if (!cancelled) setResolved((prev) => ({ ...prev, ...found }));
    })();
    return () => {
      cancelled = true;
    };
    // resolved намеренно не в зависимостях: иначе повторный probe после каждого ответа.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text]);

  const embeds = urls
    .map((href) => {
      const item = resolved[href] ?? instantEmbed(href);
      return item ? { href, ...item } : null;
    })
    .filter((item): item is { href: string } & ResolvedEmbed => Boolean(item));
  if (embeds.length === 0) return null;

  return (
    <div className="chatLinkEmbeds">
      {embeds.map(({ href, kind, previewSrc, openHref }) => {
        const item: ChatEmbedOpen = { href, kind, previewSrc, openHref };
        const open = () => props.onOpen(item);
        if (kind === "image" || kind === "animation") {
          const shown = kind === "animation" ? openHref || previewSrc || href : previewSrc || href;
          return (
            <a
              key={href}
              className={`chatLinkEmbed chatLinkEmbedImage${kind === "animation" ? " is-gif" : ""}`}
              href={openHref || href}
              onClick={(e) => {
                e.preventDefault();
                open();
              }}
            >
              <img src={shown} alt="" />
            </a>
          );
        }
        if (kind === "audio") {
          return (
            <div key={href} className="chatLinkEmbed chatLinkEmbedAudio">
              <audio src={previewSrc || href} controls preload="metadata" />
            </div>
          );
        }
        const directVideo = VIDEO_EXT_RE.test((openHref || previewSrc || "").split("?")[0] ?? "");
        if (kind === "video" && directVideo) {
          return (
            <a
              key={href}
              className="chatLinkEmbed chatLinkEmbedVideo"
              href={openHref || href}
              onClick={(e) => {
                e.preventDefault();
                open();
              }}
            >
              <video src={openHref || previewSrc} muted autoPlay loop playsInline preload="metadata" />
              <span className="chatMediaPreviewPlay" aria-hidden>
                ▶
              </span>
            </a>
          );
        }
        let host = "";
        try {
          host = new URL(href).hostname.replace(/^www\./, "");
        } catch {
          host = "";
        }
        return (
          <a
            key={href}
            className="chatLinkEmbed chatLinkEmbedVideo"
            href={openHref || href}
            onClick={(e) => {
              e.preventDefault();
              open();
            }}
          >
            {previewSrc ? <img src={previewSrc} alt="" /> : <span className="chatLinkEmbedFallback">{host}</span>}
            <span className="chatMediaPreviewPlay" aria-hidden>
              ▶
            </span>
          </a>
        );
      })}
    </div>
  );
}
