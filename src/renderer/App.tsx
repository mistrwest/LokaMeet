import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Gamepad2,
  Hash,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorUp,
  Paperclip,
  Pause,
  Pencil,
  Phone,
  PhoneOff,
  Play,
  Plus,
  Reply,
  Search,
  Send,
  Settings as SettingsIcon,
  Shrink,
  Smile,
  Trash2,
  Power,
  Users,
  Video,
  Volume2,
  VolumeX,
  MousePointer2,
  Keyboard,
  Copy,
  Scissors,
  ClipboardPaste,
} from "lucide-react";
import { api } from "./api";
import { engine } from "./engine";
import { GameInvite, Games, games, setGameInvite, startGames } from "./games";
import { translate, type Key } from "./i18n";
import { railTiles, showSelfFloat } from "./call-layout";
import { applyCameraTune, cameraConstraints } from "./pipeline";
import { playCue, playTone, speakRecord } from "./sound";
import { SMILEYS, Smiley, renderRichText } from "./smileys";
import { colorFromId, dmChat, previewText, roomChat, type AvatarFocus, type ChatMessage, type Identity, type PeerInfo, type Presence, type Profile, type RoomInfo, type Settings, type Snapshot, type ThemeId } from "../shared/types";
import { AboutPanel } from "./about";
import { APP_VERSION } from "../shared/version";

const logoUrl = `${import.meta.env.BASE_URL}icon.png`;
const CHAT_MIN = 372;
const LIST_MIN = 360;

type ConfirmAsk = { text: string; yes: string; no: string; resolve: (value: boolean) => void };
let openConfirm: ((ask: ConfirmAsk) => void) | null = null;

function askConfirm(text: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!openConfirm) {
      resolve(window.confirm(text));
      return;
    }
    openConfirm({ text, yes, no, resolve });
  });
}

type Route = "chats" | "calls" | "lan" | "rooms" | "games" | "settings";
type SettingsGroup = "profile" | "appearance" | "chat" | "notifications" | "audio" | "video" | "files" | "games" | "about";

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [route, setRoute] = useState<Route>("chats");
  const [chatId, setChatId] = useState("");
  const [showChat, setShowChat] = useState(true);
  const [gamesOpen, setGamesOpen] = useState(false);
  const [error, setError] = useState("");
  const [entered, setEntered] = useState(false);
  const [callFocus, setCallFocus] = useState(false);
  const [docking, setDocking] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>("profile");
  const [personId, setPersonId] = useState("");
  const [toast, setToast] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  useDismiss(statusOpen, () => setStatusOpen(false), statusRef);
  const autoAway = useRef(false);
  const [confirmAsk, setConfirmAsk] = useState<ConfirmAsk | null>(null);
  const [cols, setCols] = useState({ list: 400, rail: 220, chat: CHAT_MIN });
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const layoutDrag = useRef(false);
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const phaseWas = useRef(live.phase);
  const snapRef = useRef<Snapshot | null>(null);
  const recPrev = useRef<string | null>(null);
  snapRef.current = snap;

  useEffect(() => { startGames(); }, []);
  useEffect(() => {
    let had = Boolean(games.get().match);
    return games.subscribe(() => {
      const now = Boolean(games.get().match);
      if (now && !had) {
        setGamesOpen(true);
        setRoute("games");
      }
      had = now;
    });
  }, []);
  useEffect(() => {
    if (!chatId && snap?.openChatId) setChatId(snap.openChatId);
  }, [snap?.openChatId, chatId]);
  useEffect(() => { if (snap) setGameInvite(snap.settings); }, [snap?.settings]);
  useEffect(() => {
    openConfirm = (ask) => setConfirmAsk(ask);
    return () => { openConfirm = null; };
  }, []);
  useEffect(() => {
    if (!confirmAsk) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      confirmAsk.resolve(false);
      setConfirmAsk(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmAsk]);
  useEffect(() => {
    void api.invoke<Snapshot>("snapshot").then(setSnap);
    return api.on((event) => {
      if (event.t === "snapshot") setSnap(event.snapshot as Snapshot);
      if (event.t !== "incoming-message") return;
      const current = snapRef.current;
      if (!current) return;
      if (event.system && typeof event.text === "string") {
        const name = event.text.split("\t")[1] || "";
        const join = event.text.startsWith("sys:join") || event.text.startsWith("sys:start-conf");
        const rec = event.text.startsWith("sys:rec-on") || event.text.startsWith("sys:rec-off");
        if ((join || rec) && name !== current.profile.name) {
          const allowed = rec ? current.settings.notifyRecord !== false : current.settings.notifyJoin !== false;
          if (allowed) {
            const text = formatSystem(event.text, (key) => translate(current.settings.locale, key));
            setToast(text);
            playCue("join", current.settings);
            desktopNotice(text, current.settings.desktopNotify !== false);
          }
        }
        return;
      }
      if (event.from && event.from === current.profile.id) return;
      const sender = current.peers.find((peer) => peer.id === event.from);
      const who = sender?.name || translate(current.settings.locale, "notify.someone");
      const kind = String(event.kind || "text");
      const fileName = String(event.fileName || "");
      const noteKey = kind === "voice" ? "notify.voice" : kind === "image" || kind === "gif" || kind === "video" ? "notify.photo" : kind === "file" ? "notify.file" : "notify.message";
      const note = translate(current.settings.locale, noteKey).replaceAll("{name}", who).replaceAll("{text}", String(event.text || "").slice(0, 80)).replaceAll("{file}", fileName);
      setToast(note);
      if (current.settings.messageSound) playCue("message", current.settings);
      desktopNotice(note, current.settings.desktopNotify !== false);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const recState = `${live.recording ? 1 : 0}|${[...live.recorders].sort().join(",")}`;
  useEffect(() => {
    if (!snap) return;
    if (recPrev.current === null) {
      recPrev.current = recState;
      return;
    }
    if (recPrev.current === recState) return;
    const before = recPrev.current;
    recPrev.current = recState;
    const was = before.startsWith("1") || before.slice(before.indexOf("|") + 1).length > 0;
    const now = recState.startsWith("1") || recState.slice(recState.indexOf("|") + 1).length > 0;
    if (was === now) return;
    speakRecord(now ? "start" : "stop");
  }, [recState, snap]);

  useEffect(() => {
    if (!snap) return;
    engine.setIdentity(snap.profile.id, snap.profile.name, snap.settings);
    document.documentElement.dataset.theme = snap.settings.theme || "ink";
    document.documentElement.dataset.motion = snap.settings.reduceMotion ? "reduce" : "";
    document.documentElement.dataset.chatSize = snap.settings.chatSize || "m";
    document.documentElement.dataset.chatDense = snap.settings.chatDense ? "1" : "0";
    document.documentElement.dataset.chatAvatars = snap.settings.chatAvatars === false ? "0" : "1";
    const scale = snap.settings.fontScale || 1;
    document.documentElement.style.fontSize = `${Math.round(14 * scale)}px`;
    document.title = `LokaMeet ${APP_VERSION}`;
  }, [snap]);

  const awayMinutes = snap?.settings.awayMinutes ?? 10;
  const myStatus = snap?.profile.status;
  useEffect(() => {
    if (!myStatus) return;
    let last = Date.now();
    const minutes = Math.max(0, awayMinutes);
    const onMove = () => {
      last = Date.now();
      if (autoAway.current && myStatus === "away") {
        autoAway.current = false;
        void api.invoke("setProfile", { status: "online" });
      }
    };
    window.addEventListener("pointerdown", onMove);
    window.addEventListener("keydown", onMove);
    window.addEventListener("mousemove", onMove);
    const timer = window.setInterval(() => {
      if (!minutes || myStatus !== "online") return;
      if (Date.now() - last < minutes * 60_000) return;
      autoAway.current = true;
      void api.invoke("setProfile", { status: "away" });
    }, 5000);
    return () => {
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("keydown", onMove);
      window.removeEventListener("mousemove", onMove);
      window.clearInterval(timer);
    };
  }, [awayMinutes, myStatus]);

  const layoutSig = `${snap?.settings.layoutList ?? ""}|${snap?.settings.layoutRail ?? ""}|${snap?.settings.layoutChat ?? ""}`;
  useEffect(() => {
    if (!snap || layoutDrag.current) return;
    setCols({
      list: Math.max(LIST_MIN, snap.settings.layoutList || 400),
      rail: snap.settings.layoutRail || 220,
      chat: Math.max(CHAT_MIN, snap.settings.layoutChat || CHAT_MIN),
    });
  }, [layoutSig]);

  useEffect(() => {
    const prev = phaseWas.current;
    phaseWas.current = live.phase;
    if (live.phase === "idle" || live.phase === "incoming") {
      setCallFocus(false);
      return;
    }
    if (prev === "idle" || prev === "incoming") setCallFocus(true);
  }, [live.phase]);

  const limit = (kind: "list" | "rail" | "chat", value: number) => {
    const width = window.innerWidth;
    const side = width < 860 ? 76 : 140;
    const free = Math.max(320, width - side);
    if (kind === "list") return clamp(value, LIST_MIN, Math.max(LIST_MIN, Math.min(560, free - 280)));
    if (kind === "chat") return clamp(value, CHAT_MIN, Math.max(CHAT_MIN, Math.min(520, free - 280)));
    return clamp(value, 150, Math.max(150, Math.min(320, free - 380)));
  };
  const nudge = (kind: "list" | "rail" | "chat", dx: number) => {
    const sign = kind === "list" ? 1 : -1;
    setCols((prev) => {
      const next = { ...prev, [kind]: limit(kind, prev[kind] + dx * sign) };
      colsRef.current = next;
      return next;
    });
  };
  const commitLayout = () => {
    layoutDrag.current = false;
    const next = colsRef.current;
    void api.invoke("setSettings", { layoutList: Math.round(next.list), layoutRail: Math.round(next.rail), layoutChat: Math.round(next.chat) });
  };

  if (!snap) return null;
  const t = (key: Key) => translate(snap.settings.locale, key);
  if (!entered) return <Welcome t={t} identities={snap.identities ?? []} onDone={() => setEntered(true)} />;

  const openChat = (id: string) => {
    setChatId(id);
    setRoute("chats");
    if (live.phase === "active" || live.phase === "calling") collapseCall();
    void api.invoke("setOpenChat", { chatId: id });
  };
  const browse = (next: Route) => {
    if (next === "calls" && (live.phase === "active" || live.phase === "calling")) {
      setRoute("calls");
      expandCall();
      return;
    }
    setRoute(next);
    if (live.phase === "active" || live.phase === "calling") collapseCall();
  };
  const collapseCall = () => {
    if (!callFocus || docking) return;
    minimizeCall();
  };
  const expandCall = () => {
    if (callFocus) return;
    if (snap.settings.reduceMotion) {
      setCallFocus(true);
      return;
    }
    setExpanding(true);
    setCallFocus(true);
    window.setTimeout(() => setExpanding(false), 560);
  };
  const openProfile = () => {
    setSettingsGroup("profile");
    browse("settings");
  };
  const openPeer = (id: string) => {
    if (id === snap.profile.id) openProfile();
    else if (personById(snap, id)) setPersonId(id);
  };
  const minimizeCall = () => {
    if (snap.settings.reduceMotion) {
      setCallFocus(false);
      return;
    }
    setDocking(true);
    window.setTimeout(() => {
      setCallFocus(false);
      setDocking(false);
    }, 520);
  };
  const inCall = live.phase === "active" || live.phase === "calling";
  const mine = selfView(snap.profile.status, inCall, live.mode, t);
  const unread = Object.values(snap.unread).some((count) => count > 0);
  const person = personId ? personById(snap, personId) : undefined;
  const caller = live.incoming ? personById(snap, live.incoming.peerId) : undefined;

  return (
    <div className="app" style={{ ["--layout-list" as string]: `${cols.list}px`, ["--layout-rail" as string]: `${cols.rail}px`, ["--layout-chat" as string]: `${cols.chat}px` }}>
      <nav className="rail">
        <button type="button" className="logo-link has-tip" data-tip="GitHub" onClick={() => void api.invoke("openExternal", { url: "https://github.com/mistrwest/LokaMeet" })}>
          <img className="logo" src={logoUrl} alt="LokaMeet" />
        </button>
        <RailButton active={!inCall || !callFocus ? route === "chats" : false} alert={unread} icon={<MessageCircle size={30} />} label={t("nav.chats")} tip={t("tip.chats")} onClick={() => browse("chats")} />
        <RailButton active={(inCall && callFocus) || route === "calls"} icon={<Phone size={30} />} label={t("nav.calls")} tip={t("tip.calls")} onClick={() => browse("calls")} />
        <RailButton active={route === "lan" && (!inCall || !callFocus)} icon={<Users size={30} />} label={t("nav.lan")} tip={t("tip.lan")} onClick={() => browse("lan")} />
        <RailButton active={route === "rooms" && (!inCall || !callFocus)} icon={<Hash size={30} />} label={t("nav.rooms")} tip={t("tip.rooms")} onClick={() => browse("rooms")} />
        <RailButton active={route === "games" || gamesOpen} icon={<Gamepad2 size={30} />} label={t("nav.games")} tip={t("tip.games")} onClick={() => browse("games")} />
        <div className="spacer" />
        <div className="me-anchor" ref={statusRef}>
          <button className={`rail-me has-tip${route === "settings" && settingsGroup === "profile" ? " active" : ""}${statusOpen ? " no-tip" : ""}`} data-tip={t("welcome.status")} onClick={() => setStatusOpen((on) => !on)}>
            <span className="rail-avatar">
              <Avatar name={snap.profile.name} color={snap.selfColor} photo={snap.profile.avatar} focus={snap.profile.avatarFocus} status={mine.kind} />
              <i className={`presence ${mine.kind}`} />
            </span>
            <span className="rail-me-name">{snap.profile.name}</span>
            <span className={`rail-me-status status-word ${mine.kind}`}>{mine.label}</span>
          </button>
          {statusOpen && (
            <div className="status-pop" role="menu">
              <div className="status-pop-title">{t("welcome.status")}</div>
              {(["online", "away", "busy", "invisible"] as const).map((item) => (
                <button key={item} type="button" className={snap.profile.status === item ? "active" : ""} onClick={() => { autoAway.current = false; setStatusOpen(false); void api.invoke("setProfile", { status: item }); }}>
                  <i className={`presence ${item}`} />
                  <span className={`status-word ${item}`}>{t(presenceKey(item))}</span>
                </button>
              ))}
              <button type="button" onClick={() => { setStatusOpen(false); openProfile(); }}>{t("profile.settings")}</button>
            </div>
          )}
        </div>
        <RailButton active={route === "settings" && (!inCall || !callFocus)} icon={<SettingsIcon size={30} />} label={t("nav.settings")} tip={t("tip.settings")} onClick={() => browse("settings")} />
        <RailButton active={false} icon={<Power size={30} />} label={t("nav.quit")} tip={t("tip.quit")} onClick={() => {
          void (async () => {
            if (inCall && !await askConfirm(t("app.quitAsk"), t("app.quit"), t("composer.cancel"))) return;
            void api.invoke("quit");
          })();
        }} />
      </nav>
      <div className="content">
        {inCall && !callFocus && <CallDock snap={snap} t={t} onExpand={expandCall} />}
        {inCall && callFocus ? (
          <CallScreen snap={snap} t={t} showChat={showChat} setShowChat={setShowChat} openGames={() => setGamesOpen(true)} onMinimize={minimizeCall} docking={docking} expanding={expanding} openProfile={openProfile} openPeer={openPeer} onRail={(dx) => nudge("rail", dx)} onChat={(dx) => nudge("chat", dx)} onDragStart={() => { layoutDrag.current = true; }} onDragEnd={commitLayout} />
        ) : (
          <main className={route === "settings" || route === "games" || route === "calls" ? "workspace solo" : "workspace"}>
            {route === "chats" && <ChatList snap={snap} t={t} chatId={chatId} openChat={openChat} openProfile={openProfile} openPeer={openPeer} />}
            {route === "chats" && <Splitter className="list" onStart={() => { layoutDrag.current = true; }} onDelta={(dx) => nudge("list", dx)} onDone={commitLayout} />}
            {route === "chats" && <Thread snap={snap} t={t} chatId={chatId} openProfile={openProfile} openPeer={openPeer} />}
            {route === "calls" && <CallList snap={snap} t={t} />}
            {route === "lan" && <LanList snap={snap} t={t} openChat={openChat} openProfile={openProfile} openPeer={openPeer} />}
            {route === "rooms" && <RoomList snap={snap} t={t} openChat={openChat} setError={setError} />}
            {route === "settings" && <SettingsView snap={snap} t={t} group={settingsGroup} onGroup={setSettingsGroup} />}
            {route === "games" && <Games snap={snap} t={t} hintPeer={live.peerId} hintRoom={live.roomId} />}
          </main>
        )}
      </div>
      {live.invite && (
        <div className="modal-back">
          <div className="modal">
            <h2>{t("rooms.invited")}</h2>
            <p>{t("rooms.inviteFrom").replaceAll("{name}", live.invite.from).replaceAll("{room}", live.invite.name)}</p>
            <div className="row">
              <button className="btn ghost" onClick={() => engine.declineInvite()}>{t("call.decline")}</button>
              <button className="btn" onClick={() => void engine.acceptInvite().catch((reason) => setError(String(reason)))}>{t("rooms.joinConf")}</button>
            </div>
          </div>
        </div>
      )}
      {live.incoming && (
        <div className="call-pop-back">
          <div className="call-pop">
            <div className="call-pop-face">
              <Avatar name={caller?.name || live.incoming.name} color={caller?.color || snap.selfColor} photo={caller?.avatar} focus={caller?.avatarFocus} large />
            </div>
            <h2>{caller?.name || live.incoming.name}</h2>
            <p>{t("call.incomingHint")}</p>
            <div className="call-pop-acts">
              <button type="button" className="call-pop-ok" onClick={() => void engine.accept()}><Phone size={28} /></button>
              <button type="button" className="call-pop-no" onClick={() => engine.decline()}><PhoneOff size={28} /></button>
            </div>
            <div className="call-pop-caps">
              <span>{t("call.accept")}</span>
              <span>{t("call.decline")}</span>
            </div>
          </div>
        </div>
      )}
      {gamesOpen && (
        <div className="modal-back" onClick={() => { if (!games.get().match) setGamesOpen(false); }}>
          <div className="modal games-modal" onClick={(event) => event.stopPropagation()}>
            <Games snap={snap} t={t} hintPeer={live.mode === "p2p" ? live.peerId : ""} hintRoom={live.mode === "conf" ? live.roomId : ""} />
          </div>
        </div>
      )}
      <GameInvite t={t} />
      {live.controlAsk && <ControlAsk snap={snap} t={t} ask={live.controlAsk} />}
      {error && <div className="modal-back" onClick={() => setError("")}><div className="modal">{error}</div></div>}
      {person && <PeerCard peer={person} t={t} onClose={() => setPersonId("")} />}
      {toast && <button type="button" className="toast" onClick={() => setToast("")}>{toast}</button>}
      {confirmAsk && (
        <div className="modal-back confirm-back" onClick={() => { confirmAsk.resolve(false); setConfirmAsk(null); }}>
          <div className="modal confirm-modal" role="alertdialog" onClick={(event) => event.stopPropagation()}>
            <h2>{confirmAsk.text}</h2>
            <div className="row confirm-actions">
              <button className="btn ghost" type="button" onClick={() => { confirmAsk.resolve(false); setConfirmAsk(null); }}>{confirmAsk.no}</button>
              <button className="btn danger" type="button" autoFocus onClick={() => { confirmAsk.resolve(true); setConfirmAsk(null); }}>{confirmAsk.yes}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RailButton({ active, icon, label, tip, onClick, alert = false }: { active: boolean; icon: ReactNode; label: string; tip: string; onClick: () => void; alert?: boolean }) {
  return <button className={active ? "active has-tip" : "has-tip"} data-tip={tip} onClick={onClick}>{icon}{alert && <i className="rail-alert" />} <span>{label}</span></button>;
}

function Welcome({ t, identities, onDone }: { t: (key: Key) => string; identities: Identity[]; onDone: () => void }) {
  const saved = identities.filter((item) => item.name);
  const [mode, setMode] = useState<"pick" | "new">(saved.length ? "pick" : "new");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Presence>(saved[0]?.status || "online");
  const [avatar, setAvatar] = useState("");
  const [error, setError] = useState("");
  const color = colorFromId(name || "new");
  const shown = name.trim() || "?";
  const hints: Record<"online" | "invisible" | "busy", Key> = { online: "welcome.onlineHint", invisible: "welcome.invisibleHint", busy: "welcome.busyHint" };
  const cancel = () => {
    if (mode === "new" && saved.length) {
      setMode("pick");
      setName("");
      setAvatar("");
      setStatus("online");
      return;
    }
    void api.invoke("quit");
  };
  const onFile = (file?: File) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError(t("profile.tooBig"));
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result || ""));
    reader.readAsDataURL(file);
  };
  if (mode === "pick") {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="welcome-top">
            <img className="welcome-logo" src={logoUrl} alt="" />
            <div>
              <div className="welcome-brand">LokaMeet</div>
              <div className="welcome-ver">{APP_VERSION}</div>
            </div>
          </div>
          <h2>{t("welcome.who")}</h2>
          <p className="muted">{t("welcome.whoHint")}</p>
          <div className="welcome-label">{t("welcome.status")}</div>
          <div className="welcome-statuses">
            {(["online", "invisible", "busy"] as const).map((item) => (
              <button key={item} type="button" className={status === item ? `welcome-status ${item} on` : `welcome-status ${item}`} onClick={() => setStatus(item)}>
                <i className={`presence ${item}`} />
                <strong className={`status-word ${item}`}>{t(presenceKey(item))}</strong>
                <small>{t(hints[item])}</small>
              </button>
            ))}
          </div>
          <div className="welcome-people">
            {saved.map((item) => (
              <button key={item.id} type="button" className="welcome-person" onClick={() => void api.invoke("pickIdentity", { id: item.id, status }).then(() => onDone())}>
                <Avatar name={item.name} color={colorFromId(item.id)} photo={item.avatar} focus={item.avatarFocus} large status={status} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{t("welcome.enterAs").replace("{status}", t(presenceKey(status)))}</small>
                </span>
              </button>
            ))}
          </div>
          <button className="btn ghost welcome-go" type="button" onClick={() => setMode("new")}>{t("welcome.new")}</button>
          <button className="btn ghost welcome-cancel" type="button" onClick={cancel}>{t("welcome.cancel")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="welcome">
      <form className="welcome-card" onSubmit={(event) => {
        event.preventDefault();
        const next = name.trim().slice(0, 40);
        if (!next) return;
        void api.invoke("enterAs", { name: next, avatar, status, fresh: saved.length > 0 }).then(() => onDone());
      }}>
        <div className="welcome-top">
          <img className="welcome-logo" src={logoUrl} alt="" />
          <div>
            <div className="welcome-brand">LokaMeet</div>
            <div className="welcome-ver">{APP_VERSION}</div>
          </div>
        </div>
        <label className="welcome-hero has-tip" data-tip={t("welcome.photo")}>
          <Avatar name={shown} color={color} photo={avatar} large status={status} />
          <span className="welcome-photo">{t("welcome.photo")}</span>
          <input hidden type="file" accept="image/*,video/webm,video/mp4,.gif,.webp" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        {avatar && <button className="welcome-clear" type="button" onClick={() => setAvatar("")}>{t("settings.clearPhoto")}</button>}
        <h2>{t("welcome.title")}</h2>
        <p className="muted">{t("welcome.hint")}</p>
        <label className="welcome-name">
          <span>{t("welcome.name")}</span>
          <input autoFocus maxLength={40} value={name} placeholder={t("welcome.namePh")} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="welcome-label">{t("welcome.status")}</div>
        <div className="welcome-statuses">
          {(["online", "invisible", "busy"] as const).map((item) => (
            <button key={item} type="button" className={status === item ? `welcome-status ${item} on` : `welcome-status ${item}`} onClick={() => setStatus(item)}>
              <i className={`presence ${item}`} />
              <strong className={`status-word ${item}`}>{t(presenceKey(item))}</strong>
              <small>{t(hints[item])}</small>
            </button>
          ))}
        </div>
        {error && <p className="hint">{error}</p>}
        <button className="btn welcome-go" type="submit" disabled={!name.trim()}>{t("welcome.go")}</button>
        <button className="btn ghost welcome-cancel" type="button" onClick={cancel}>{t("welcome.cancel")}</button>
      </form>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.replace(/[«»"'„“]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  return (name.trim().slice(0, 2) || "L").toUpperCase();
}

function Avatar({ name, color, photo, focus, large = false, status, onClick }: { name: string; color: string; photo?: string; focus?: AvatarFocus; large?: boolean; status?: string; onClick?: () => void }) {
  const letters = initials(name);
  const ring = status ? ` status-${status}` : "";
  const motion = isMotion(photo);
  const style = focusStyle(focus);
  return (
    <div className={`${large ? "avatar-lg" : "avatar"}${ring}${onClick ? " clickable" : ""}`} style={{ background: color }} onClick={onClick ? (event) => { event.stopPropagation(); onClick(); } : undefined}>
      {photo && motion ? <video src={photo} autoPlay muted loop playsInline style={style} /> : photo ? <img src={photo} alt="" style={style} /> : letters}
    </div>
  );
}

function ChatList({ snap, t, chatId, openChat, openProfile, openPeer }: { snap: Snapshot; t: (key: Key) => string; chatId: string; openChat: (id: string) => void; openProfile: () => void; openPeer: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "dm" | "group">("all");
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const rows = useMemo(() => {
    const hidden = new Set(snap.hiddenChats ?? []);
    const items: Array<{
      id: string; kind: "dm" | "group"; title: string; color: string; photo?: string; focus?: AvatarFocus;
      preview: string; ts: number; unread: number; inCall: boolean; status?: string; statusLabel?: string; peerId?: string;
      recording: boolean; sharing: boolean; mine: boolean; delivered: boolean;
    }> = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (!id || seen.has(id) || hidden.has(id)) return;
      const thread = snap.messages[id] ?? [];
      if (!thread.length) return;
      seen.add(id);
      const last = thread[thread.length - 1];
      const title = titleOf(snap, id, t);
      const peer = peerOf(snap, id);
      const view = peer ? peerView(peer, t) : undefined;
      const flags = peer ? activityOf(snap, peer.id, false) : { recording: false, sharing: false };
      const room = id.startsWith("room:") ? snap.rooms.find((item) => item.id === id.slice(5)) : undefined;
      const kind = id.startsWith("room:") ? "group" as const : "dm" as const;
      const raw = last.deleted ? t("msg.deleted") : last.kind === "system" ? formatSystem(last.text, t) : previewText(last);
      const who = last.kind === "system" ? "" : last.senderId === snap.profile.id ? t("chats.you") : kind === "group" ? (personById(snap, last.senderId)?.name || "") : "";
      const preview = [who, raw.replace(/\s+/g, " ").trim()].filter(Boolean).join(": ");
      items.push({
        id,
        kind,
        title: title.name,
        color: title.color,
        photo: title.photo,
        focus: title.focus,
        peerId: peer?.id,
        preview,
        ts: last.ts,
        unread: snap.unread[id] ?? 0,
        inCall: Boolean(peer?.inCall || room?.conference),
        status: room?.conference ? "conf" : view?.kind,
        statusLabel: room?.conference ? t("status.inConf") : view?.label,
        recording: flags.recording,
        sharing: flags.sharing,
        mine: last.senderId === snap.profile.id,
        delivered: last.status === "delivered",
      });
    };
    for (const id of Object.keys(snap.messages)) push(id);
    const q = query.trim().toLowerCase();
    return items.filter((item) => !q || item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q)).sort((a, b) => b.ts - a.ts);
  }, [snap, query, t, live.recording, live.shareOn, live.recorders, live.tiles]);
  const removeChat = async (id: string) => {
    if (!await askConfirm(t("chats.deleteAsk"), t("common.ok"), t("composer.cancel"))) return;
    if (id === chatId) openChat("");
    await api.invoke("hideChat", { chatId: id });
  };
  const visible = rows.filter((row) => filter === "all" || row.kind === filter);
  const renderRow = (row: (typeof rows)[number]) => {
    const unread = row.unread > 0 && row.id !== chatId;
    return (
      <button key={row.id} className={`person chat-row${row.id === chatId ? " active" : ""}${row.inCall ? " in-call" : ""}${unread ? " unread" : ""}`} onClick={() => openChat(row.id)}>
        <span className="rail-avatar">
          <Avatar name={row.title} color={row.color} photo={row.photo} focus={row.focus} status={row.status} onClick={row.peerId ? () => openPeer(row.peerId!) : undefined} />
          {row.status && <i className={`presence ${row.status}`} />}
        </span>
        <span className="chat-copy">
          <div className="chat-top">
            <div className="name">{row.title} <NickMarks recording={row.recording} sharing={row.sharing} t={t} /></div>
            <div className="time">{row.ts ? clock(row.ts) : ""}</div>
          </div>
          <div className="chat-bottom">
            <div className="sub preview">{row.statusLabel && <span className={`status-word ${row.status}`}>{row.statusLabel}</span>}{!row.inCall && row.preview ? `${row.statusLabel ? " · " : ""}${row.preview}` : ""}</div>
            {unread ? <i className="badge unread-n">{row.unread}</i> : row.mine ? <span className={row.delivered ? "ticks on" : "ticks"}>✓✓</span> : null}
          </div>
        </span>
        <span className="wipe" title={t("chats.delete")} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeChat(row.id); }}><Trash2 size={14} /></span>
      </button>
    );
  };
  return (
    <section className="list chats-pane">
      <header><strong>{t("nav.chats")}</strong></header>
      <label className="search"><Search size={16} /><input value={query} placeholder={t("chats.search")} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="chat-filter">
        {([
          ["all", t("chats.all"), rows.filter((row) => row.unread > 0 && row.id !== chatId).length],
          ["dm", t("chats.direct"), rows.filter((row) => row.kind === "dm" && row.unread > 0 && row.id !== chatId).length],
          ["group", t("chats.groupsShort"), rows.filter((row) => row.kind === "group" && row.unread > 0 && row.id !== chatId).length],
        ] as const).map(([id, label, count]) => (
          <button key={id} type="button" className={filter === id ? "chip on" : "chip"} onClick={() => setFilter(id)}>
            {label}{count > 0 ? <b>{count}</b> : null}
          </button>
        ))}
      </div>
      <div className="scroll">
        {visible.length === 0 && <div className="empty">{t("chats.empty")}</div>}
        {visible.map(renderRow)}
      </div>
    </section>
  );
}

function Thread({ snap, t, chatId, openProfile, openPeer }: { snap: Snapshot; t: (key: Key) => string; chatId: string; openProfile: () => void; openPeer: (id: string) => void }) {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [smileys, setSmileys] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [drafts, setDrafts] = useState<Array<{ id: string; file: File; preview: string; kind: ChatMessage["kind"] }>>([]);
  const [recording, setRecording] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const [wave, setWave] = useState<number[]>([]);
  const dragDepth = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; started: number; raf: number } | null>(null);
  const gesture = useRef({ down: false, x: 0, released: false });
  const arming = useRef(false);
  const voiceGen = useRef(0);
  const messages = [...(snap.messages[chatId] ?? [])].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const title = titleOf(snap, chatId, t);
  const peer = peerOf(snap, chatId);
  const faces = chatFaces(snap, chatId);
  const smileRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; compose: boolean; message?: ChatMessage } | null>(null);
  useEffect(() => {
    if (!recording || !voiceRef.current) return;
    const id = window.setInterval(() => {
      const current = voiceRef.current;
      if (!current) return;
      setRecMs(performance.now() - current.started);
    }, 200);
    return () => window.clearInterval(id);
  }, [recording]);
  useDismiss(smileys, () => setSmileys(false), smileRef);
  useEffect(() => {
    const node = feedRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, chatId]);
  useEffect(() => {
    voiceGen.current += 1;
    setDrafts([]);
    setText("");
    setReply(null);
    setEditing(null);
    setSmileys(false);
    dropVoice(false);
  }, [chatId]);

  async function stageFiles(files: File[]) {
    for (const file of files) {
      const id = crypto.randomUUID();
      const kind = sightKind(await sniffFile(file));
      const visual = kind === "image" || kind === "gif" || kind === "video";
      setDrafts((list) => [...list, { id, file, preview: visual && file.size < 80_000_000 ? URL.createObjectURL(file) : "", kind }]);
    }
  }

  async function deliver(kind: ChatMessage["kind"], file?: File, voice?: Blob, caption = "") {
    if (!chatId) return;
    const id = crypto.randomUUID();
    let sourcePath = "";
    let preview = "";
    let info: ChatMessage["file"];
    const blob = voice ?? file;
    if (blob) {
      const named = file?.name || `voice-${id}.webm`;
      const disk = (file as File & { path?: string } | undefined)?.path;
      sourcePath = disk && disk.length > 0 ? disk : await api.invoke<string>("storeFile", { name: named, bytes: new Uint8Array(await blob.arrayBuffer()) });
      const resolved = voice ? "voice" : kind;
      if (file && resolved === "image" && file.size < 12_000_000) preview = await imagePreview(file);
      if (file && resolved === "video" && file.size < 80_000_000) preview = await videoPoster(file);
      info = { transferId: id, name: named, size: blob.size, mime: file ? mimeOf(file) : (blob.type || "application/octet-stream"), sourcePath, preview };
    }
    const message: ChatMessage = {
      id, chatId, senderId: snap.profile.id, kind: voice ? "voice" : file ? kind : kind,
      text: caption, replyTo: reply ? { id: reply.id, text: previewText(reply) } : undefined,
      ts: Date.now(), status: "pending", file: info,
    };
    const stored = await api.invoke<ChatMessage>("sendChat", { message });
    const voiceInline = Boolean(voice && blob && blob.size <= 6_000_000);
    try {
      if (!voiceInline && stored.file?.sourcePath && chatId.startsWith("dm:")) await engine.transfer(chatId.slice(3), stored);
      if (!voiceInline && stored.file?.sourcePath && chatId.startsWith("room:")) {
        const room = snap.rooms.find((item) => roomChat(item.id) === chatId);
        await Promise.all((room?.members ?? []).filter((member) => member !== snap.profile.id).map((member) => engine.transfer(member, stored)));
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function submit() {
    const caption = text.trim();
    if (editing) {
      if (editing.kind === "text" && !caption) return;
      await api.invoke("editChat", { chatId, id: editing.id, text: caption });
      setEditing(null);
      setText("");
      return;
    }
    if (!caption && drafts.length === 0) return;
    const queued = drafts;
    setText("");
    setDrafts([]);
    setReply(null);
    setSmileys(false);
    if (queued.length === 0) {
      await deliver("text", undefined, undefined, caption);
      return;
    }
    for (let index = 0; index < queued.length; index += 1) {
      await deliver(queued[index].kind, queued[index].file, undefined, index === 0 ? caption : "");
    }
  }

  function dropVoice(send: boolean) {
    const current = voiceRef.current;
    if (!current) return;
    voiceRef.current = null;
    window.cancelAnimationFrame(current.raf);
    current.recorder.onstop = () => {
      current.stream.getTracks().forEach((track) => track.stop());
      void current.ctx.close();
      const blob = new Blob(current.chunks, { type: current.recorder.mimeType || "audio/webm" });
      if (send && blob.size > 1000) void deliver("voice", undefined, blob, text.trim()).then(() => { setText(""); setReply(null); });
    };
    if (current.recorder.state !== "inactive") current.recorder.stop();
    setRecording(false);
    setWave([]);
    setRecMs(0);
  }

  async function beginVoice(event: ReactPointerEvent<HTMLButtonElement>) {
    if (voiceRef.current) {
      dropVoice(true);
      return;
    }
    if (arming.current) return;
    const gen = voiceGen.current;
    arming.current = true;
    gesture.current = { down: true, x: event.clientX, released: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      console.error(error);
      gesture.current.down = false;
      arming.current = false;
      return;
    }
    arming.current = false;
    if (gen !== voiceGen.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (item) => { if (item.data.size) chunks.push(item.data); };
    const started = performance.now();
    const bucket = { recorder, stream, ctx, chunks, started, raf: 0 };
    voiceRef.current = bucket;
    const sample = new Uint8Array(analyser.fftSize);
    let painted = 0;
    const tick = (now: number) => {
      if (voiceRef.current !== bucket) return;
      if (now - painted > 70) {
        painted = now;
        analyser.getByteTimeDomainData(sample);
        let sum = 0;
        for (const value of sample) {
          const x = (value - 128) / 128;
          sum += x * x;
        }
        const amp = Math.min(1, Math.sqrt(sum / sample.length) * 5);
        setWave((prev) => [...prev.slice(-46), amp]);
        setRecMs(now - started);
      }
      bucket.raf = window.requestAnimationFrame(tick);
    };
    recorder.start();
    setRecording(true);
    setWave([]);
    setRecMs(0);
    bucket.raf = window.requestAnimationFrame(tick);
  }

  function moveVoice(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!gesture.current.down || !voiceRef.current) return;
    if (gesture.current.x - event.clientX > 88) {
      gesture.current.down = false;
      dropVoice(false);
    }
  }

  function releaseVoice() {
    gesture.current.released = true;
    gesture.current.down = false;
    const current = voiceRef.current;
    if (!current) return;
    if (performance.now() - current.started > 350) dropVoice(true);
  }

  if (!chatId) return <section className="thread thread-empty"><header><strong>{t("chats.pick")}</strong></header><div className="empty">{t("chats.pickHint")}</div></section>;
  const heading = title;
  const group = chatId.startsWith("room:");
  const view = peer ? peerView(peer, t) : undefined;
  const room = group ? snap.rooms.find((item) => roomChat(item.id) === chatId) : undefined;
  const other = !group ? peer || personById(snap, chatId.slice(3)) : undefined;
  const callPeer = (video: boolean) => {
    if (!other) return;
    void engine.call(other.id, video, other.name);
  };
  const beginEdit = (message: ChatMessage) => {
    setReply(null);
    setEditing(message);
    setText(message.text);
    box.current?.focus();
  };
  const insertAtCaret = (chunk: string) => {
    const node = box.current;
    if (!node) {
      setText((value) => `${value}${chunk}`);
      return;
    }
    const start = node.selectionStart ?? text.length;
    const end = node.selectionEnd ?? text.length;
    const next = `${text.slice(0, start)}${chunk}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      node.focus();
      const pos = start + chunk.length;
      node.setSelectionRange(pos, pos);
    });
  };
  const selectedText = () => {
    const node = box.current;
    if (!node) return "";
    return text.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0);
  };
  const runMenu = async (act: "copy" | "paste" | "cut" | "delete") => {
    if (!menu) return;
    if (menu.compose) {
      const pick = selectedText();
      if (act === "copy" && pick) await navigator.clipboard.writeText(pick);
      if (act === "cut" && pick) {
        await navigator.clipboard.writeText(pick);
        insertAtCaret("");
      }
      if (act === "paste") insertAtCaret(await navigator.clipboard.readText().catch(() => ""));
      if (act === "delete" && pick) insertAtCaret("");
    } else if (menu.message) {
      if (act === "copy" && menu.message.text) await navigator.clipboard.writeText(menu.message.text);
      if (act === "delete" && menu.message.senderId === snap.profile.id) void api.invoke("deleteChat", { chatId, id: menu.message.id });
    }
    setMenu(null);
  };
  return (
    <section
      className={dragOver ? "thread dropping" : "thread chat-thread"}
      onDragEnter={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        void stageFiles([...(event.dataTransfer.files ?? [])]);
      }}
    >
      {dragOver && <div className="drop-veil">{t("composer.drop")}</div>}
      <header className="thread-head">
        <span className="rail-avatar">
          <Avatar name={heading.name} color={heading.color} photo={heading.photo || (faces[0]?.photo)} focus={heading.focus || faces[0]?.focus} status={view?.kind} onClick={peer ? () => openPeer(peer.id) : openProfile} />
          {view && <i className={`presence ${view.kind}`} />}
        </span>
        <div className="thread-who">
          <div className="name">{heading.name} {peer && <NickMarks {...activityOf(snap, peer.id, false)} t={t} />} {peer?.online && <i className="dot" />}</div>
          <div className="sub">
            {view ? <span className={`status-word ${view.kind}`}>{view.label}</span>
              : room?.conference ? <span className="status-word conf">{t("status.inConf")}</span>
              : group ? `${Math.max(room?.onlineCount || 0, new Set(messages.filter((item) => item.senderId !== "system").map((item) => item.senderId)).size)} ${t("conf.members")}`
              : ""}
          </div>
        </div>
        {other && <button className="icon-btn has-tip" data-tip={t("tip.audioCall")} onClick={() => callPeer(false)}><Phone size={26} /></button>}
        {other && <button className="icon-btn has-tip" data-tip={t("tip.videoCall")} onClick={() => callPeer(true)}><Video size={26} /></button>}
      </header>
      <ChatRecStrip chatId={chatId} t={t} />
      <div className="messages" ref={feedRef}>
        {messages.length === 0 && <div className="empty">{t("chats.pickHint")}</div>}
        {messages.map((message, index) => {
          const mine = message.senderId === snap.profile.id;
          const sender = personById(snap, message.senderId);
          const prev = messages[index - 1];
          const stampDay = !prev || dayKey(prev.ts) !== dayKey(message.ts);
          return (
            <Fragment key={message.id}>
              {stampDay && <div className="day-chip">{dayLabel(message.ts, snap.settings.locale, t)}</div>}
              <Bubble
                message={message}
                mine={mine}
                room={group}
                name={mine ? "" : sender?.name || (group ? t("chats.member") : peer?.name || "")}
                color={mine ? snap.selfColor : sender?.color || heading.color}
                avatar={sender?.avatar}
                focus={sender?.avatarFocus}
                t={t}
                onReply={() => { setEditing(null); setReply(message); }}
                onEdit={() => beginEdit(message)}
                onDelete={() => void api.invoke("deleteChat", { chatId, id: message.id })}
                onMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, compose: false, message }); }}
              />
            </Fragment>
          );
        })}
      </div>
      {editing && <div className="replybar"><span>{t("composer.editing")}</span><button className="icon-btn" onClick={() => { setEditing(null); setText(""); }}>{t("composer.cancel")}</button></div>}
      {reply && !editing && <div className="replybar"><span>{t("composer.reply")}: {renderRichText(previewText(reply), 16)}</span><button className="icon-btn" onClick={() => setReply(null)}>{t("composer.cancel")}</button></div>}
      {drafts.length > 0 && (
        <div className="drafts">
          {drafts.map((draft) => (
            <div key={draft.id} className="draft" title={draft.file.name}>
              {draft.preview && draft.kind === "video" ? <video src={draft.preview} muted playsInline /> : draft.preview ? <img src={draft.preview} alt="" /> : <span className="sub">{draft.file.name}</span>}
              <button type="button" onClick={() => setDrafts((list) => list.filter((item) => item.id !== draft.id))}>×</button>
            </div>
          ))}
          <span className="sub">{t("composer.attachHint")}</span>
        </div>
      )}
      <div className="composer" ref={smileRef}>
        {smileys && !recording && (
          <div className="smile-pop" role="dialog" aria-label={t("smileys")}>
            {SMILEYS.map((name) => (
              <button key={name} type="button" title={name} onClick={() => { setText((value) => `${value}:${name}:`); box.current?.focus(); }}>
                <Smiley name={name} size={28} />
              </button>
            ))}
          </div>
        )}
        {recording ? (
          <div className="rec-bar on">
            <button className="icon-btn danger has-tip" type="button" data-tip={t("tip.voiceCancel")} onClick={() => dropVoice(false)}><Trash2 size={26} /></button>
            <span className="rec-dot" />
            <span className="rec-time">{stamp(recMs / 1000)}</span>
            <span className="rec-live" aria-hidden>{wave.map((amp, index) => <i key={index} style={{ height: `${Math.max(6, amp * 32)}px` }} />)}</span>
            <button className="send has-tip" type="button" data-tip={t("tip.voiceStop")} onClick={() => dropVoice(true)}><Send size={20} /></button>
          </div>
        ) : (
          <>
            <textarea ref={box} rows={1} placeholder={t("composer.placeholder")} value={text} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, compose: true }); }} onChange={(event) => setText(event.target.value)} onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length) { event.preventDefault(); void stageFiles(files); }
            }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && snap.settings.enterToSend !== false) { event.preventDefault(); void submit(); } }} />
            <div className="composer-bar">
              <div className="tools">
                <label className="icon-btn has-tip" data-tip={t("tip.attach")}><Paperclip size={26} /><input hidden type="file" multiple onChange={(event) => { void stageFiles([...(event.target.files ?? [])]); event.target.value = ""; }} /></label>
                <button className={`icon-btn has-tip${smileys ? " active no-tip" : ""}`} type="button" data-tip={t("tip.smile")} onClick={() => setSmileys((value) => !value)}><Smile size={26} /></button>
                <button className="icon-btn has-tip" type="button" data-tip={t("tip.voice")} onPointerDown={(event) => { void beginVoice(event); }} onPointerMove={moveVoice} onPointerUp={releaseVoice}><Mic size={26} /></button>
                {other && <button className="icon-btn has-tip" type="button" data-tip={t("tip.audioCall")} onClick={() => callPeer(false)}><Phone size={26} /></button>}
                {other && <button className="icon-btn has-tip" type="button" data-tip={t("tip.videoCall")} onClick={() => callPeer(true)}><Video size={26} /></button>}
              </div>
              <button className="send has-tip" data-tip={t("tip.send")} disabled={!editing && !text.trim() && drafts.length === 0} onClick={() => void submit()}><Send size={20} /> {editing ? t("composer.save") : t("composer.send")}</button>
            </div>
          </>
        )}
      </div>
      {menu && createPortal(
        <div className="ctx-back" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
          <ChatCtxMenu x={menu.x} y={menu.y} compose={menu.compose} t={t} onCopy={() => void runMenu("copy")} onPaste={() => void runMenu("paste")} onCut={() => void runMenu("cut")} onDelete={() => void runMenu("delete")} />
        </div>,
        document.body,
      )}
    </section>
  );
}

function Bubble({ message, mine, room, name, color, avatar, focus, t, onReply, onEdit, onDelete, onMenu }: { message: ChatMessage; mine: boolean; room: boolean; name: string; color?: string; avatar?: string; focus?: AvatarFocus; t: (key: Key) => string; onReply: () => void; onEdit: () => void; onDelete: () => void; onMenu: (event: React.MouseEvent) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (message.kind === "system" && message.text.startsWith("sys:rec-saved")) {
    const filePath = message.text.split("\t")[2] || "";
    const folder = /\.(mp4|webm|mkv)$/i.test(filePath) ? filePath.replace(/[\\/][^\\/]+$/, "") || filePath : filePath;
    return (
      <div className="system rec-note rec-alert">
        <div>{formatSystem(message.text, t, message.ts)}</div>
        {filePath && <div className="sub">{filePath}</div>}
        {folder && <button className="btn ghost" type="button" onClick={() => void api.invoke("openPath", { path: folder })}>{t("settings.openFolder")}</button>}
      </div>
    );
  }
  if (message.kind === "system") {
    const rec = message.text.startsWith("sys:rec-on") || message.text.startsWith("sys:rec-off");
    return <div className={rec ? "system rec-note rec-alert" : "system"}>{formatSystem(message.text, t, message.ts)}</div>;
  }
  const file = message.file;
  const localPath = file ? ((mine ? file.sourcePath || file.path : file.path) || "") : "";
  const video = message.kind !== "voice" && Boolean(file && (message.kind === "video" || looksVideo(file)));
  const anim = Boolean(file && !video && message.kind === "gif");
  const photo = Boolean(file && !video && message.kind === "image");
  const visual = Boolean(file && !file.deleted && !message.deleted && (video || anim || photo));
  const poster = file?.preview?.startsWith("data:image") ? file.preview : "";
  const mediaSrc = localPath ? fileUrl(localPath) : "";
  const src = mediaSrc || poster || (message.kind === "gif" ? "" : file?.preview || "");
  const canEdit = mine && !message.deleted && message.kind !== "voice";
  const acts = !message.deleted && (
    <div className="acts">
      <button type="button" title={t("msg.quote")} onClick={onReply}><Reply size={16} /></button>
      {canEdit && <button type="button" title={t("msg.edit")} onClick={onEdit}><Pencil size={16} /></button>}
      {mine && <button type="button" title={t("msg.delete")} onClick={onDelete}><Trash2 size={16} /></button>}
    </div>
  );
  return (
    <div className={mine ? "msg-row mine" : "msg-row theirs"}>
      {mine && acts}
          {!mine && name && <Avatar name={name} color={color || "#2f6fed"} photo={avatar} focus={focus} />}
          <div className={mine ? "bubble-wrap mine" : "bubble-wrap theirs"}>
            <article className={mine ? "bubble mine" : "bubble theirs"} onDoubleClick={() => { if (!message.deleted) onReply(); }} onContextMenu={onMenu}>
              {!mine && name && <div className="who" style={{ color }}>{name}</div>}
          {message.deleted ? <div className="deleted-note">{t("msg.deleted")}</div> : (
            <>
              {message.replyTo && <div className="quote">{message.replyTo.text}</div>}
              {file?.deleted && <div className="file-card">{t("file.deleted")}</div>}
              {visual && src && (
                <button type="button" className="preview-card" onClick={() => setOpen(true)}>
                  {video && mediaSrc ? <video src={mediaSrc} poster={poster || undefined} muted playsInline /> : <img src={video && poster ? poster : src} alt={file?.name || ""} />}
                  {(video || anim) && <span className="preview-play"><Play size={16} /></span>}
                </button>
              )}
              {file && !file.deleted && message.kind === "voice" && (localPath || file.path) && <VoiceNote src={fileUrl(localPath || file.path || "")} />}
              {file && !file.deleted && message.kind === "voice" && !(localPath || file.path) && <div className="sub">{t("composer.voiceWait")}</div>}
              {file && !file.deleted && message.kind !== "voice" && (!visual || !src) && (
                <div className="file-card">
                  <div><b>{file.name}</b><div className="sub">{Math.ceil(file.size / 1024)} KB</div></div>
                  {(localPath || file.path) && <button className="btn ghost" onClick={() => void api.invoke("openPath", { path: localPath || file.path })}>{t("file.open")}</button>}
                </div>
              )}
              {message.text && <div>{renderRichText(message.text)}</div>}
            </>
          )}
          <div className="meta">
            {message.editedAt && !message.deleted && <span className="edited">{t("msg.edited")}</span>}
            <span>{clock(message.ts)}</span>
            {mine && !message.deleted && <span className={message.status === "delivered" ? "ticks on" : "ticks"}>✓✓</span>}
          </div>
          {open && src && createPortal(
            <div className="lightbox" onClick={() => setOpen(false)}>
              <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
                {video && mediaSrc ? <video src={mediaSrc} poster={poster || undefined} controls autoPlay /> : <img src={src} alt={file?.name || ""} />}
              </div>
            </div>,
            document.body,
          )}
        </article>
      </div>
      {!mine && acts}
    </div>
  );
}

function VoiceNote({ src }: { src: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gen = useRef(0);
  const raf = useRef(0);
  const offsetRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [peaks, setPeaks] = useState<number[]>(() => Array.from({ length: 42 }, (_, index) => 0.28 + ((index * 7) % 8) / 16));
  useEffect(() => {
    let dead = false;
    const ctx = new AudioContext();
    void fetch(src).then((response) => response.arrayBuffer()).then(async (bytes) => {
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      await ctx.close();
      if (dead) return;
      bufferRef.current = decoded;
      const data = decoded.getChannelData(0);
      const bars = 42;
      const size = Math.max(1, Math.floor(data.length / bars));
      const next = Array.from({ length: bars }, (_, index) => {
        let peak = 0;
        const start = index * size;
        for (let offset = 0; offset < size; offset += 16) peak = Math.max(peak, Math.abs(data[start + offset] || 0));
        return Math.max(0.16, Math.min(1, peak * 1.7));
      });
      setPeaks(next);
      setDur(decoded.duration);
      if (audio.current && !audio.current.paused) audio.current.pause();
    }).catch(() => { void ctx.close(); });
    return () => {
      dead = true;
      gen.current += 1;
      window.cancelAnimationFrame(raf.current);
      try { sourceRef.current?.stop(); } catch { /* already stopped */ }
      void ctxRef.current?.close();
      ctxRef.current = null;
      bufferRef.current = null;
    };
  }, [src]);
  const pause = () => {
    gen.current += 1;
    window.cancelAnimationFrame(raf.current);
    const prev = sourceRef.current;
    sourceRef.current = null;
    if (prev) { try { prev.stop(); } catch { /* already stopped */ } }
    if (audio.current && !audio.current.paused) audio.current.pause();
    setPlaying(false);
  };
  const playFrom = (offset: number) => {
    const buffer = bufferRef.current;
    if (!buffer) {
      const node = audio.current;
      if (!node) return;
      node.currentTime = offset;
      void node.play();
      return;
    }
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      ctxRef.current = ctx;
    }
    void ctx.resume();
    const mine = ++gen.current;
    window.cancelAnimationFrame(raf.current);
    const prev = sourceRef.current;
    sourceRef.current = null;
    if (prev) { try { prev.stop(); } catch { /* already stopped */ } }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = clamp(offset, 0, Math.max(0, buffer.duration - 0.03));
    node.start(0, start);
    sourceRef.current = node;
    const base = ctx.currentTime - start;
    offsetRef.current = start;
    setPlaying(true);
    setTime(start);
    const tick = () => {
      if (gen.current !== mine) return;
      const now = ctx.currentTime - base;
      if (now >= buffer.duration - 0.03) {
        setPlaying(false);
        setTime(0);
        offsetRef.current = 0;
        sourceRef.current = null;
        return;
      }
      offsetRef.current = now;
      setTime(now);
      raf.current = window.requestAnimationFrame(tick);
    };
    raf.current = window.requestAnimationFrame(tick);
  };
  const toggle = () => {
    if (playing) pause();
    else playFrom(offsetRef.current);
  };
  const seek = (clientX: number) => {
    const node = waveRef.current;
    const total = bufferRef.current?.duration || dur || audio.current?.duration || 0;
    if (!node || !total || !Number.isFinite(total)) return;
    const rect = node.getBoundingClientRect();
    const next = clamp((clientX - rect.left) / rect.width, 0, 1) * total;
    offsetRef.current = next;
    setTime(next);
    if (playing) playFrom(next);
    else if (audio.current && !bufferRef.current) audio.current.currentTime = next;
  };
  const played = dur ? time / dur : 0;
  return (
    <div className="voice">
      <button type="button" onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
      <div
        className="wave"
        ref={waveRef}
        onPointerDown={(event) => {
          drag.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seek(event.clientX);
        }}
        onPointerMove={(event) => { if (drag.current) seek(event.clientX); }}
        onPointerUp={() => { drag.current = false; }}
        onPointerCancel={() => { drag.current = false; }}
      >
        {peaks.map((peak, index) => <i key={index} className={(index + 0.5) / peaks.length <= played ? "on" : ""} style={{ height: `${Math.max(4, peak * 28)}px` }} />)}
        <span className="wave-head" style={{ left: `${played * 100}%` }} />
      </div>
      <span>{stamp(playing || time > 0.05 ? time : dur || time)}</span>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => { if (!bufferRef.current) setPlaying(true); }}
        onPause={() => { if (!bufferRef.current) setPlaying(false); }}
        onEnded={() => { if (!bufferRef.current) { setPlaying(false); setTime(0); offsetRef.current = 0; } }}
        onTimeUpdate={(event) => { if (!bufferRef.current) { setTime(event.currentTarget.currentTime); offsetRef.current = event.currentTarget.currentTime; } }}
        onLoadedMetadata={(event) => {
          const node = event.currentTarget;
          if (!bufferRef.current && Number.isFinite(node.duration)) setDur(node.duration);
        }}
      />
    </div>
  );
}

function CallScreen({ snap, t, showChat, setShowChat, openGames, onMinimize, docking, expanding, openProfile, openPeer, onRail, onChat, onDragStart, onDragEnd }: { snap: Snapshot; t: (key: Key) => string; showChat: boolean; setShowChat: (value: boolean) => void; openGames: () => void; onMinimize: () => void; docking: boolean; expanding: boolean; openProfile: () => void; openPeer: (id: string) => void; onRail: (dx: number) => void; onChat: (dx: number) => void; onDragStart: () => void; onDragEnd: () => void }) {
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const stageRef = useRef<HTMLVideoElement>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [fsOn, setFsOn] = useState(false);
  const fsHold = useRef(1);
  const fsOver = useRef(false);
  const fsTimer = useRef(0);
  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const [shareOpen, setShareOpen] = useState(false);
  const [showRail, setShowRail] = useState(true);
  const railOn = live.mode === "conf" && showRail;
  const desk = live.controlling
    ? live.tiles.find((tile) => tile.source === "screen" && tile.peerId === (live.controlPeerId || live.peerId) && tile.stream)
    : undefined;
  const stage = desk ?? live.tiles.find((tile) => tile.id === live.stageId) ?? live.tiles[0];
  const pip = live.tiles.find((tile) => tile.source === "self");
  const screenStage = stage?.source === "screen";
  const host = live.mode === "conf" && live.hostId === snap.profile.id;
  useEffect(() => {
    const root = railRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const ids = entries.filter((entry) => entry.isIntersecting).map((entry) => (entry.target as HTMLElement).dataset.id || "");
      void engine.setVisible(ids.filter(Boolean));
    }, { root, threshold: 0.35 });
    root.querySelectorAll("[data-id]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [live.tiles.length]);
  const chatId = live.mode === "conf" ? roomChat(live.roomId) : dmChat(live.peerId);
  const face = (tile: { peerId: string; name: string; source: string } | undefined) => tile ? faceOf(snap, tile.peerId, tile.source === "self", tile.name) : undefined;
  const stageLevel = stage && stage.source !== "screen" ? live.levels[stage.peerId] ?? 0 : 0;
  const selfLevel = live.levels[snap.profile.id] ?? 0;
  const stageHalo = useHalo(stageLevel);
  const selfHalo = useHalo(selfLevel);
  const ownerHalo = useHalo(screenStage && stage ? live.levels[stage.peerId] ?? 0 : 0);
  const [shareLabel, setShareLabel] = useState("");
  useEffect(() => {
    const node = stageRef.current;
    if (!screenStage || !node) {
      setShareLabel("");
      return;
    }
    const read = () => {
      const width = node.videoWidth;
      const height = node.videoHeight;
      setShareLabel(width > 0 ? `${width}×${height}` : "");
    };
    read();
    node.addEventListener("resize", read);
    const timer = window.setInterval(read, 1000);
    return () => {
      node.removeEventListener("resize", read);
      window.clearInterval(timer);
    };
  }, [screenStage, stage?.id, stage?.stream]);
  const openTile = (tile: { peerId: string; source: string }) => {
    if (tile.source === "self" || tile.peerId === snap.profile.id) return;
    openPeer(tile.peerId);
  };
  const goFull = () => {
    const screen = live.tiles.find((tile) => tile.source === "screen");
    if (screen && live.stageId !== screen.id) engine.pin(screen.id);
    const node = stageBox.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen();
  };
  const shareVol = snap.settings.shareVolume ?? 1;
  const shareMuted = shareVol <= 0.001;
  const setShare = (shareVolume: number) => {
    engine.applyShareVolume(shareVolume);
    void api.invoke("setSettings", { shareVolume });
  };
  const toggleShareMute = () => {
    if (shareVol > 0.001) {
      fsHold.current = shareVol;
      setShare(0);
      return;
    }
    setShare(fsHold.current > 0.001 ? fsHold.current : 1);
  };
  const pokeFs = () => {
    if (!document.fullscreenElement) return;
    setFsOn(true);
    window.clearTimeout(fsTimer.current);
    fsTimer.current = window.setTimeout(() => { if (!fsOver.current) setFsOn(false); }, screenStage ? 1400 : 2300);
  };
  return (
    <section className={`call-shell${railOn ? " with-rail" : ""}${showChat ? " with-chat" : ""}${docking ? " shrinking" : ""}${expanding ? " expanding" : ""}`}>
      <div className="stage-wrap">
        <div className="call-top">
          <img className="logo tiny" src={logoUrl} alt="" />
          <strong>LokaMeet {APP_VERSION}</strong>
          <span className="pill"><i className="dot" /> {live.phase === "calling" ? t("call.calling") : <Clock started={live.started} />}</span>
          {(live.recording || live.recorders.length > 0) && (
            <span className="rec">● {t("conf.rec")} {live.recording && live.recStarted ? <Clock started={live.recStarted} /> : recPeerClock(live)}</span>
          )}
          <span className="pill">{screenStage ? (shareLabel || "2K · 60") : "720p"}</span>
        </div>
        <div ref={stageBox} className={`${screenStage ? "stage screen" : "stage"}${stageHalo > 0.05 ? " speaking" : ""}${full && !fsOn && screenStage ? " fs-quiet" : ""}`} style={{ ["--level" as string]: stageLevel, ["--halo" as string]: stageHalo }} onMouseMove={pokeFs}>
          <div className="stage-media">
            {stage ? (
              <MediaView stream={stage.stream} videoRef={stageRef} person={face(stage)} videoOn={stage.source === "screen" || (stage.source === "self" ? live.camOn : true)} contain={screenStage} mirror={stage.source === "self" && snap.settings.camMirror} speaking={stageHalo > 0.05} level={stageHalo} onOpen={() => openTile(stage)} />
            ) : (
              <MediaView stream={null} person={faceOf(snap, live.peerId, false, "")} videoOn={false} onOpen={() => openPeer(live.peerId)} />
            )}
          </div>
          {live.controlling && screenStage && stage?.peerId === (live.controlPeerId || live.peerId) && (
            <ControlLayer size={live.controlSize} videoRef={stageRef} t={t} who={face(stage)?.name || live.controlledBy} />
          )}
          {live.controlling && !(screenStage && stage?.peerId === (live.controlPeerId || live.peerId)) && (
            <div className="control-wait">{t("control.waitScreen")}</div>
          )}
          {live.controlled && (
            <div className="control-host-bar">
              <MousePointer2 size={16} />
              <span>{t("control.by").replaceAll("{name}", live.controlledBy || t("chats.member"))}</span>
              <small>{t("control.takeHint")}</small>
              <button className="btn" type="button" onClick={() => engine.stopControl()}>{t("control.stop")}</button>
            </div>
          )}
          {stage && face(stage) && (
            <div className="stage-name">
              <b>{stage.source === "self" ? t("call.you") : face(stage)!.name}</b>
              {(stage.source === "self" || stage.peerId === snap.profile.id ? !live.micOn : live.mutedPeers.includes(stage.peerId)) && <span className="mark-mute"><MicOff size={12} />{t("call.micOffShort")}</span>}
            </div>
          )}
          {screenStage && !live.controlling && face(stage) && <SpeakOrb person={face(stage)!} halo={ownerHalo} />}
          {pip && !live.controlling && showSelfFloat(stage, snap.profile.id, live.camOn) && (
            <div className={`stage-float${selfHalo > 0.05 ? " speaking" : ""}`} style={{ ["--level" as string]: selfLevel, ["--halo" as string]: selfHalo }}>
              <MediaView stream={pip.stream} person={face(pip)} videoOn={live.camOn} mirror={snap.settings.camMirror} speaking={selfHalo > 0.05} level={selfHalo} />
              {!live.micOn && <span className="float-mute"><MicOff size={12} />{t("call.micOffShort")}</span>}
            </div>
          )}
          {full && (
            <div className={fsOn ? "fs-bar on" : "fs-bar"} onMouseEnter={() => { fsOver.current = true; setFsOn(true); }} onMouseLeave={() => { fsOver.current = false; pokeFs(); }}>
              <button type="button" onClick={() => void document.exitFullscreen()}><Shrink size={18} /> {t("call.exitFull")}</button>
              <button type="button" className={live.micOn ? "" : "off"} onClick={() => void engine.toggleMic()}>{live.micOn ? <Mic size={22} /> : <MicOff size={22} />} {t("call.mic")}</button>
              <div className="fs-vol">
                <button type="button" className={shareMuted ? "off" : ""} title={t("call.shareMute")} onClick={toggleShareMute}>{shareMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
                <input type="range" min={0} max={1} step={0.05} value={shareVol} aria-label={t("call.shareVolume")} onInput={(event) => setShare(Number((event.target as HTMLInputElement).value))} onChange={(event) => setShare(Number(event.target.value))} />
              </div>
              <button type="button" className="danger" onClick={() => {
                void (async () => {
                  if (host && !await askConfirm(t("call.endHost"), t("common.ok"), t("composer.cancel"))) return;
                  void engine.hangup();
                })();
              }}><PhoneOff size={18} /></button>
            </div>
          )}
        </div>
        <div className="controls">
          <button className={live.micOn ? "ctrl has-tip" : "ctrl off mic-off has-tip"} data-tip={t(live.micOn ? "tip.micOn" : "tip.micOff")} onClick={() => void engine.toggleMic()}>{live.micOn ? <Mic size={28} /> : <MicOff size={28} />}<small>{t("call.mic")}</small></button>
          <button className={live.camOn ? "ctrl has-tip" : "ctrl off has-tip"} data-tip={t("tip.camera")} disabled={live.phase !== "active"} onClick={() => void engine.toggleCam()}><Video size={28} /><small>{t("call.camera")}</small></button>
          <button className={live.shareOn ? "ctrl active has-tip" : "ctrl has-tip"} data-tip={t("tip.screen")} disabled={live.phase !== "active"} onClick={() => { if (live.shareOn) void engine.stopShare(); else setShareOpen(true); }}><MonitorUp size={28} /><small>{live.shareOn ? t("call.screenStop") : t("call.screen")}</small></button>
          {live.phase === "active" && (
            <button className={live.controlPending ? "ctrl pending has-tip" : live.controlling ? "ctrl active has-tip" : "ctrl has-tip"} data-tip={t("tip.control")} onClick={() => { if (live.controlling || live.controlled) engine.stopControl(); else if (!live.controlPending) void engine.askControl(); }}><MousePointer2 size={28} /><small>{live.controlPending ? t("control.waiting") : live.controlling ? t("control.stop") : t("call.control")}</small></button>
          )}
          {live.tiles.some((tile) => tile.source === "screen") && (
            <div className="ctrl vol-ctrl has-tip" data-tip={t("call.shareVolume")}>
              <button type="button" className={shareMuted ? "off" : ""} onClick={toggleShareMute}>{shareMuted ? <VolumeX size={22} /> : <Volume2 size={22} />}</button>
              <input type="range" min={0} max={1} step={0.05} value={shareVol} aria-label={t("call.shareVolume")} onInput={(event) => setShare(Number((event.target as HTMLInputElement).value))} onChange={(event) => setShare(Number(event.target.value))} />
              <small>{t("call.shareVolume")}</small>
            </div>
          )}
          <button className={full ? "ctrl active has-tip" : "ctrl has-tip"} data-tip={t("tip.fullscreen")} onClick={goFull}><Maximize2 size={28} /><small>{t("call.fullscreen")}</small></button>
          <button className={live.recording ? "ctrl active has-tip rec-ctrl" : "ctrl has-tip"} data-tip={t("tip.record")} onClick={() => void engine.toggleRecord(stageRef.current)}><span className={live.recording ? "rec-glyph on" : "rec-glyph"} /><small>{live.recording && live.recStarted ? <Clock started={live.recStarted} /> : t("call.record")}</small></button>
          <button className="ctrl has-tip" data-tip={t("tip.games")} onClick={openGames}><Gamepad2 size={28} /><small>{t("call.games")}</small></button>
          {live.mode === "conf" && <button className={showRail ? "ctrl active has-tip" : "ctrl has-tip"} data-tip={t("tip.cameras")} onClick={() => setShowRail((value) => !value)}><Users size={28} /><small>{t("call.cameras")}</small></button>}
          <button className={showChat ? "ctrl active has-tip" : "ctrl has-tip"} data-tip={t("tip.chat")} onClick={() => setShowChat(!showChat)}><MessageCircle size={28} /><small>{t("call.chat")}</small></button>
          <button className="ctrl has-tip" data-tip={t("tip.minimize")} onClick={onMinimize}><Minimize2 size={28} /><small>{t("call.minimize")}</small></button>
          <button className="ctrl danger has-tip" data-tip={t("tip.hangup")} onClick={() => {
            void (async () => {
              if (host && !await askConfirm(t("call.endHost"), t("common.ok"), t("composer.cancel"))) return;
              void engine.hangup();
            })();
          }}><PhoneOff size={28} /><small>{live.mode === "conf" && !host ? t("call.leave") : t("call.hangup")}</small></button>
        </div>
      </div>
      {railOn && <Splitter className="rail" onStart={onDragStart} onDelta={onRail} onDone={onDragEnd} />}
      {showChat && <Splitter className="chat" onStart={onDragStart} onDelta={onChat} onDone={onDragEnd} />}
      {railOn && (
        <div className="rail-tiles" ref={railRef}>
          {railTiles(live.tiles, snap.profile.id).map((tile) => (
            <RailTile key={tile.id} tile={tile} level={tile.source === "screen" ? 0 : live.levels[tile.peerId] ?? 0} you={t("call.you")} mirror={tile.source === "self" && snap.settings.camMirror} camOn={live.camOn} person={face(tile)} recording={activityOf(snap, tile.peerId, tile.source === "self").recording} sharing={tile.source === "screen" || activityOf(snap, tile.peerId, tile.source === "self").sharing} muted={live.mutedPeers.includes(tile.peerId) || ((tile.source === "self" || tile.peerId === snap.profile.id) && !live.micOn)} t={t} host={host} mine={tile.source === "self" || tile.peerId === snap.profile.id} onOpen={() => openTile(tile)} />
          ))}
        </div>
      )}
      {showChat && <Thread snap={snap} t={t} chatId={chatId} openProfile={openProfile} openPeer={openPeer} />}
      {shareOpen && <ShareDialog t={t} onClose={() => setShareOpen(false)} />}
    </section>
  );
}

function CallDock({ snap, t, onExpand }: { snap: Snapshot; t: (key: Key) => string; onExpand: () => void }) {
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const people = live.tiles.filter((tile) => tile.source !== "screen").slice(0, 4);
  const title = live.mode === "conf"
    ? snap.rooms.find((room) => room.id === live.roomId)?.name || t("nav.rooms")
    : snap.peers.find((peer) => peer.id === live.peerId)?.name || t("call.calling");
  const host = live.mode === "conf" && live.hostId === snap.profile.id;
  return (
    <div className="call-dock">
      <span className="pill"><i className="dot" /> {live.phase === "calling" ? t("call.calling") : <Clock started={live.started} />}</span>
      <div className="dock-people">
        {people.map((tile) => {
          const person = faceOf(snap, tile.peerId, tile.source === "self", tile.name);
          return <Avatar key={tile.id} name={person.name} color={person.color} photo={person.photo} focus={person.focus} status={person.status} />;
        })}
      </div>
      <span className="dock-title">{title} {live.peerId && <NickMarks {...activityOf(snap, live.peerId, false)} t={t} />} {live.mode === "conf" && live.hostId && <NickMarks {...activityOf(snap, live.hostId, live.hostId === snap.profile.id)} t={t} />}</span>
      <span style={{ flex: 1 }} />
      <button className={live.micOn ? "icon-btn has-tip" : "icon-btn off has-tip"} data-tip={t(live.micOn ? "tip.micOn" : "tip.micOff")} onClick={() => void engine.toggleMic()}>{live.micOn ? <Mic size={26} /> : <MicOff size={26} />}</button>
      <button className={live.camOn ? "icon-btn has-tip" : "icon-btn off has-tip"} data-tip={t("tip.camera")} onClick={() => void engine.toggleCam()}><Video size={26} /></button>
      <button className="btn has-tip" data-tip={t("tip.return")} onClick={onExpand}>{t("call.return")}</button>
      <button className="btn danger" onClick={() => {
        void (async () => {
          if (host && !await askConfirm(t("call.endHost"), t("common.ok"), t("composer.cancel"))) return;
          void engine.hangup();
        })();
      }}>{live.mode === "conf" && !host ? t("call.leave") : t("call.hangup")}</button>
    </div>
  );
}

function useHalo(level: number): number {
  const raw = useRef(level);
  raw.current = level;
  const [halo, setHalo] = useState(0);
  const shown = useRef(0);
  const painted = useRef(0);
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const sample = raw.current;
      const target = sample < 0.04 ? 0 : Math.min(1, ((sample - 0.04) / 0.2) ** 0.6);
      const current = shown.current;
      const tau = target > current ? 90 : 780;
      const next = current + (target - current) * (1 - Math.exp(-dt / tau));
      const settled = Math.abs(next - target) < 0.008 ? target : next;
      shown.current = settled;
      if (settled === 0 ? painted.current !== 0 : Math.abs(settled - painted.current) > 0.015) {
        painted.current = settled;
        setHalo(settled);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return halo;
}

function SpeakOrb({ person, halo }: { person: { name: string; color: string; photo?: string; focus?: AvatarFocus }; halo: number }) {
  return (
    <div className="stage-orb" style={{ ["--halo" as string]: halo }}>
      <div className={halo > 0.05 ? "face speaking" : "face"}>
        <span className="orb">
          <Avatar name={person.name} color={person.color} photo={person.photo} focus={person.focus} large />
        </span>
      </div>
    </div>
  );
}

function RailTile({ tile, level, you, mirror, camOn, person, recording, sharing, muted, t, host, mine, onOpen }: { tile: { id: string; source: string; name: string; peerId: string; stream: MediaStream | null }; level: number; you: string; mirror: boolean; camOn: boolean; person?: { name: string; color: string; photo?: string; focus?: AvatarFocus; status?: string }; recording: boolean; sharing: boolean; muted: boolean; t: (key: Key) => string; host: boolean; mine: boolean; onOpen: () => void }) {
  const halo = useHalo(muted ? 0 : level);
  return (
    <button data-id={tile.id} className={halo > 0.05 ? "tile speaking" : "tile"} style={{ ["--level" as string]: muted ? 0 : level, ["--halo" as string]: halo }} onClick={() => engine.pin(tile.id)}>
      <MediaView stream={tile.stream} person={person} videoOn={tile.source === "screen" || (tile.source === "self" ? camOn : true)} contain={tile.source === "screen"} mirror={mirror} speaking={halo > 0.05} level={halo} onOpen={onOpen} />
      <span className="cap">{tile.source === "self" ? you : tile.name || tile.peerId.slice(0, 4)} <NickMarks recording={recording} sharing={sharing} muted={muted} t={t} /> <i className="level" style={{ ["--level" as string]: muted ? 0 : level }} /></span>
      {host && !mine && (
        <span className={muted ? "tile-mute on" : "tile-mute"} title={muted ? t("call.unmute") : t("call.mute")} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void engine.mutePeer(tile.peerId, !muted); }}>{muted ? <MicOff size={14} /> : <Mic size={14} />}</span>
      )}
      {!mine && (
        <span className="tile-ctrl" title={t("tip.control")} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void engine.askControl(tile.peerId); }}><MousePointer2 size={14} /></span>
      )}
    </button>
  );
}

function ControlLayer({ size, videoRef, t, who }: { size: { w: number; h: number }; videoRef: RefObject<HTMLVideoElement>; t: (key: Key) => string; who: string }) {
  const box = useRef<HTMLDivElement>(null);
  const hold = useRef(false);
  const [cursor, setCursor] = useState({ x: 24, y: 24, in: false });
  const [full, setFull] = useState(false);
  const [chromeOn, setChromeOn] = useState(true);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === box.current?.closest(".stage"));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggleFull = () => {
    const stage = box.current?.closest(".stage");
    if (!(stage instanceof HTMLElement)) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen();
  };
  const map = (event: ReactPointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const node = box.current || video;
    if (!node) return { x: 0, y: 0, cx: 0, cy: 0 };
    const rect = node.getBoundingClientRect();
    const vw = video && video.videoWidth > 0 ? video.videoWidth : rect.width;
    const vh = video && video.videoHeight > 0 ? video.videoHeight : rect.height;
    const scale = Math.min(rect.width / Math.max(1, vw), rect.height / Math.max(1, vh));
    const dw = vw * scale;
    const dh = vh * scale;
    const left = rect.left + (rect.width - dw) / 2;
    const top = rect.top + (rect.height - dh) / 2;
    const nx = (event.clientX - left) / Math.max(1, dw);
    const ny = (event.clientY - top) / Math.max(1, dh);
    const x = Math.round(Math.max(0, Math.min(1, nx)) * size.w);
    const y = Math.round(Math.max(0, Math.min(1, ny)) * size.h);
    return { x, y, cx: event.clientX - rect.left, cy: event.clientY - rect.top };
  };
  const send = (kind: "move" | "down" | "up" | "wheel" | "key", event: ReactPointerEvent<HTMLDivElement>, extra?: { button?: number; delta?: number }) => {
    const p = map(event);
    setCursor({ x: p.cx, y: p.cy, in: true });
    if (document.fullscreenElement) {
      const near = p.cy < 72 || hold.current;
      setChromeOn((on) => (on === near ? on : near));
    }
    engine.sendControl({
      t: "control-input",
      kind,
      x: p.x,
      y: p.y,
      nx: size.w ? p.x / size.w : 0,
      ny: size.h ? p.y / size.h : 0,
      button: extra?.button,
      delta: extra?.delta,
      w: size.w,
      h: size.h,
    });
  };
  return (
    <div
      ref={box}
      className="control-layer"
      tabIndex={0}
      onContextMenu={(event) => event.preventDefault()}
      onPointerEnter={() => setCursor((cur) => ({ ...cur, in: true }))}
      onPointerLeave={() => setCursor((cur) => ({ ...cur, in: false }))}
      onPointerMove={(event) => send("move", event)}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); send("down", event, { button: event.button }); }}
      onPointerUp={(event) => send("up", event, { button: event.button })}
      onWheel={(event) => {
        event.preventDefault();
        const p = map(event as unknown as ReactPointerEvent<HTMLDivElement>);
        engine.sendControl({
          t: "control-input",
          kind: "wheel",
          x: p.x,
          y: p.y,
          nx: size.w ? p.x / size.w : 0,
          ny: size.h ? p.y / size.h : 0,
          delta: event.deltaY < 0 ? 120 : -120,
          w: size.w,
          h: size.h,
        });
      }}
      onKeyDown={(event) => { event.preventDefault(); engine.sendControl({ t: "control-input", kind: "key", key: event.key, down: true }); }}
      onKeyUp={(event) => { event.preventDefault(); engine.sendControl({ t: "control-input", kind: "key", key: event.key, down: false }); }}
    >
      <div
        className={full && !chromeOn ? "control-chrome away" : "control-chrome"}
        onPointerEnter={() => { hold.current = true; setChromeOn(true); }}
        onPointerLeave={() => { hold.current = false; }}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <MousePointer2 size={14} />
        <span>{t("control.desktop").replaceAll("{name}", who || t("chats.member"))}</span>
        <i>{size.w}×{size.h}</i>
        <button type="button" onClick={toggleFull}>{full ? <Shrink size={14} /> : <Maximize2 size={14} />} {full ? t("call.exitFull") : t("call.fullscreen")}</button>
        <button type="button" onClick={() => engine.stopControl()}>{t("control.stop")}</button>
      </div>
      {cursor.in && <span className="control-cursor" style={{ left: cursor.x, top: cursor.y }} />}
    </div>
  );
}

function ChatCtxMenu({ x, y, compose, t, onCopy, onPaste, onCut, onDelete }: { x: number; y: number; compose: boolean; t: (key: Key) => string; onCopy: () => void; onPaste: () => void; onCut: () => void; onDelete: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = node.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h + 8 > window.innerHeight ? Math.max(8, y - h - 6) : y;
    setPos({ left, top });
  }, [x, y, compose]);
  return (
    <div ref={node} className="ctx-menu" style={{ left: pos.left, top: pos.top }} onClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={onCopy}><Copy size={16} /> {t("ctx.copy")}</button>
      {compose && <button type="button" onClick={onPaste}><ClipboardPaste size={16} /> {t("ctx.paste")}</button>}
      {compose && <button type="button" onClick={onCut}><Scissors size={16} /> {t("ctx.cut")}</button>}
      <button type="button" className="danger" onClick={onDelete}><Trash2 size={16} /> {t("ctx.delete")}</button>
    </div>
  );
}

function MediaView({ stream, videoRef, person, videoOn, contain = false, framed = false, mirror = false, speaking = false, level = 0, onOpen }: { stream: MediaStream | null; videoRef?: RefObject<HTMLVideoElement>; person?: { name: string; color: string; photo?: string; focus?: AvatarFocus; status?: string }; videoOn: boolean; contain?: boolean; framed?: boolean; mirror?: boolean; speaking?: boolean; level?: number; onOpen?: () => void }) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  const [frames, setFrames] = useState(false);
  useEffect(() => {
    setFrames(false);
    const node = ref.current;
    if (!node) return;
    node.srcObject = stream;
    node.playbackRate = 1;
  }, [stream, ref]);
  useEffect(() => {
    if (!stream) {
      setFrames(false);
      return;
    }
    const bound = new Set<MediaStreamTrack>();
    const sync = () => {
      const node = ref.current;
      if (node && node.srcObject !== stream) {
        node.srcObject = stream;
        node.playbackRate = 1;
        void node.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      if (track && !bound.has(track)) {
        bound.add(track);
        track.addEventListener("mute", sync);
        track.addEventListener("unmute", sync);
        track.addEventListener("ended", sync);
      }
      const painted = (node?.videoWidth ?? 0) > 0;
      setFrames(Boolean(track && track.enabled && track.readyState === "live" && painted));
    };
    const onAdd = () => {
      const node = ref.current;
      if (node) {
        node.srcObject = null;
        node.srcObject = stream;
        node.playbackRate = 1;
        void node.play().catch(() => undefined);
      }
      sync();
    };
    sync();
    stream.addEventListener("addtrack", onAdd);
    stream.addEventListener("removetrack", sync);
    return () => {
      stream.removeEventListener("addtrack", onAdd);
      stream.removeEventListener("removetrack", sync);
      bound.forEach((track) => {
        track.removeEventListener("mute", sync);
        track.removeEventListener("unmute", sync);
        track.removeEventListener("ended", sync);
      });
    };
  }, [stream, ref]);
  const show = videoOn && frames;
  return (
    <div className={`media-face${contain ? " contain" : ""}${speaking ? " speaking" : ""}`} style={{ ["--level" as string]: level, ["--halo" as string]: level }}>
      <video ref={ref} autoPlay playsInline muted className={`${show ? "" : "is-off"}${mirror ? " mirror" : ""}${contain ? " contain" : ""}`} onPlaying={() => {
        const node = ref.current;
        if (node) node.playbackRate = 1;
        const track = stream?.getVideoTracks()[0];
        setFrames(Boolean(track && track.enabled && track.readyState === "live" && (node?.videoWidth ?? 0) > 0));
      }} onLoadedData={() => {
        const track = stream?.getVideoTracks()[0];
        setFrames(Boolean(track && track.enabled && track.readyState === "live" && (ref.current?.videoWidth ?? 0) > 0));
      }} />
      {!show && person && (framed ? (
        person.photo
          ? <img className="fill-photo" src={person.photo} alt="" style={focusStyle(person.focus)} onClick={onOpen ? (event) => { event.stopPropagation(); onOpen(); } : undefined} />
          : <div className="face flat" onClick={onOpen ? (event) => { event.stopPropagation(); onOpen(); } : undefined}>{person.name.slice(0, 1).toUpperCase() || "L"}</div>
      ) : (
        <div className={speaking ? "face speaking" : "face"}>
          <span className="orb" style={{ ["--level" as string]: level, ["--halo" as string]: level }}>
            <Avatar name={person.name} color={person.color} photo={person.photo} focus={person.focus} large onClick={onOpen} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ControlAsk({ snap, t, ask }: { snap: Snapshot; t: (key: Key) => string; ask: { peerId: string; name: string } }) {
  type Desk = { id: string; name: string; thumbnail: string; width: number; height: number; x?: number; y?: number; primary?: boolean };
  const [sources, setSources] = useState<Desk[]>([]);
  const [picked, setPicked] = useState("");
  const asker = personById(snap, ask.peerId);
  useEffect(() => {
    let dead = false;
    void api.invoke<Desk[]>("screenSources").then((list) => {
      if (dead) return;
      const screens = list
        .filter((item) => item.id.startsWith("screen:"))
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || (a.x || 0) - (b.x || 0) || (a.y || 0) - (b.y || 0));
      setSources(screens);
      setPicked(screens.find((item) => item.primary)?.id || screens[0]?.id || "");
    });
    return () => { dead = true; };
  }, [ask.peerId]);
  return (
    <div className="modal-back control-ask-back">
      <div className="modal control-ask">
        <p className="control-ask-kicker">{t("control.askTitle")}</p>
        <Avatar name={ask.name} color={asker?.color || "#4c8dff"} photo={asker?.avatar} focus={asker?.avatarFocus} large status="call" />
        <h2>{ask.name}</h2>
        <p>{t("control.askText").replaceAll("{name}", ask.name)}</p>
        <ul className="control-perms">
          <li><Monitor size={18} /> {t("control.permScreen")}</li>
          <li><MousePointer2 size={18} /> {t("control.permMouse")}</li>
          <li><Keyboard size={18} /> {t("control.permKeys")}</li>
        </ul>
        <h3 className="desk-label">{t("control.pickScreen")}</h3>
        <p className="hint">{t("control.pickHint")}</p>
        <div className="source-grid screens desk-grid">
          {sources.map((source, index) => (
            <button key={source.id} type="button" className={picked === source.id ? "source picked" : "source"} onClick={() => setPicked(source.id)}>
              <span className="source-shot" style={{ ["--shot" as string]: `${Math.max(1, source.width)} / ${Math.max(1, source.height)}` }}>
                {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Monitor size={28} />}
              </span>
              <span className="source-name">
                <b>{source.name || t("control.screenN").replace("{n}", String(index + 1))}</b>
                <small>{source.primary ? t("control.primary") : `${source.width}×${source.height}`}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="control-ask-acts">
          <button className="control-ask-ok" type="button" disabled={sources.length > 0 && !picked} onClick={() => void engine.answerControl(true, picked)}>{t("control.accept")}</button>
          <button className="control-ask-no" type="button" onClick={() => void engine.answerControl(false)}>{t("control.decline")}</button>
        </div>
      </div>
    </div>
  );
}

function ShareDialog({ t, onClose }: { t: (key: Key) => string; onClose: () => void }) {
  type Source = { id: string; name: string; thumbnail: string; width: number; height: number };
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState("");
  const [withAudio, setWithAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.invoke<Source[]>("screenSources").then(setSources);
  }, []);
  const screens = sources.filter((source) => source.id.startsWith("screen:"));
  const apps = sources.filter((source) => !source.id.startsWith("screen:"));
  const start = async () => {
    const sourceIds = selected === "all" ? screens.map((source) => source.id) : selected ? [selected] : [];
    if (!sourceIds.length) return;
    setBusy(true);
    try {
      const ok = await engine.shareScreen({ sourceIds, withAudio });
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };
  const card = (source: Source, screenCard: boolean) => (
    <button key={source.id} type="button" className={selected === source.id ? "source picked" : "source"} onClick={() => setSelected(source.id)}>
      <span className="source-shot" style={{ ["--shot" as string]: `${Math.max(1, source.width)} / ${Math.max(1, source.height)}` }}>
        {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Monitor size={28} />}
      </span>
      <span className="source-name"><b>{source.name}</b>{screenCard && <small>{source.width}×{source.height}</small>}</span>
    </button>
  );
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal share-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{t("call.sharePick")}</h2>
        <label className="check-row share-audio">
          <input type="checkbox" checked={withAudio} onChange={(event) => setWithAudio(event.target.checked)} />
          {t("call.shareSound")}
        </label>
        <div className="share-scroll">
          <h3>{t("call.shareScreens")}</h3>
          <div className="source-grid screens">
            {screens.length > 0 && (
              <button type="button" className={selected === "all" ? "source picked" : "source"} onClick={() => setSelected("all")}>
                <span className="source-shot" style={{ ["--shot" as string]: "16 / 9" }}>
                  <span className="all-screens"><Monitor size={28} /></span>
                </span>
                <span className="source-name"><b>{t("call.shareAll")}</b></span>
              </button>
            )}
            {screens.map((source) => card(source, true))}
          </div>
          {apps.length > 0 && <h3>{t("call.shareApps")}</h3>}
          {apps.length > 0 && <div className="source-grid apps">{apps.map((source) => card(source, false))}</div>}
          {sources.length === 0 && <p className="hint">{t("call.shareNone")}</p>}
        </div>
        <div className="row">
          <button className="btn ghost" type="button" onClick={onClose}>{t("composer.cancel")}</button>
          <button className="btn" type="button" disabled={!selected || busy} onClick={() => void start()}>{t("call.shareStart")}</button>
        </div>
      </div>
    </div>
  );
}

function LanList({ snap, t, openChat, openProfile, openPeer }: { snap: Snapshot; t: (key: Key) => string; openChat: (id: string) => void; openProfile: () => void; openPeer: (id: string) => void }) {
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("47721");
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const inCall = live.phase === "active" || live.phase === "calling";
  const mine = selfView(snap.profile.status, inCall, live.mode, t);
  return (
    <>
      <section className="list">
        <header><strong>{t("lan.title")}</strong></header>
        <div className="scroll">
          <div className="person me">
            <span className="rail-avatar">
              <Avatar name={snap.profile.name} color={snap.selfColor} photo={snap.profile.avatar} focus={snap.profile.avatarFocus} status={mine.kind} onClick={openProfile} />
              <i className={`presence ${mine.kind}`} />
            </span>
            <span>
              <div className="name">{snap.profile.name} <NickMarks {...activityOf(snap, snap.profile.id, true)} t={t} /></div>
              <div className="sub">{t("common.you")} · <span className={`status-word ${mine.kind}`}>{mine.label}</span></div>
            </span>
          </div>
          {snap.peers.length === 0 && <div className="empty">{t("lan.empty")}</div>}
          {snap.peers.map((peer) => {
            const view = peerView(peer, t);
            return (
            <div key={peer.id} className="person">
              <span className="rail-avatar">
                <Avatar name={peer.name} color={peer.color} photo={peer.avatar} focus={peer.avatarFocus} status={view.kind} onClick={() => openPeer(peer.id)} />
                <i className={`presence ${view.kind}`} />
              </span>
              <span><div className="name">{peer.name} <NickMarks {...activityOf(snap, peer.id, false)} t={t} /></div><div className="sub"><span className={`status-word ${view.kind}`}>{view.label}</span> · {peer.ip}</div></span>
              <span className="lan-acts">
                <button className="btn ghost" onClick={() => openChat(dmChat(peer.id))}>{t("lan.chat")}</button>
                <button className="btn" onClick={() => void engine.call(peer.id, false, peer.name)}>{t("lan.call")}</button>
              </span>
            </div>
            );
          })}
        </div>
      </section>
      <section className="thread">
        <header><strong>{t("lan.manual")}</strong></header>
        <form className="settings" onSubmit={(event) => { event.preventDefault(); void api.invoke("manualConnect", { ip, port: Number(port) }); }}>
          <label className="field">IP<input value={ip} onChange={(event) => setIp(event.target.value)} /></label>
          <label className="field">Port<input value={port} onChange={(event) => setPort(event.target.value)} /></label>
          <button className="btn" type="submit">{t("rooms.join")}</button>
        </form>
      </section>
    </>
  );
}

function StartConference({ snap, t, room, onClose, setError }: { snap: Snapshot; t: (key: Key) => string; room: RoomInfo | null; onClose: () => void; setError: (value: string) => void }) {
  const fallback = `${snap.profile.name} ${t("rooms.confSuffix")}`.trim();
  const [name, setName] = useState(room?.name || "");
  const [password, setPassword] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const people = snap.peers.filter((peer) => peer.online);
  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  const start = async () => {
    try {
      const title = name.trim() || fallback;
      let roomId = room?.id || "";
      let roomName = room?.name || title;
      if (!room) {
        const created = await api.invoke<{ id: string; name: string }>("createRoom", { name: title, password });
        roomId = created.id;
        roomName = created.name;
      }
      await engine.startConference(roomId, roomName);
      for (const id of picked) {
        await api.invoke("signal", {
          peerId: id,
          payload: { t: "conf-invite", roomId, name: roomName, password, hostId: snap.profile.id, from: snap.profile.name },
        });
      }
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <h2>{t("rooms.startTitle")}</h2>
        {room ? <p>{room.name}</p> : (
          <label className="field">{t("rooms.name")}<input value={name} placeholder={fallback} onChange={(event) => setName(event.target.value)} /></label>
        )}
        <label className="field">{t("rooms.passwordOptional")}<input type="password" value={password} autoComplete="off" onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="field">{t("rooms.invite")}</div>
        {people.length === 0 && <p className="hint">{t("rooms.noPeers")}</p>}
        {people.length > 0 && <button type="button" className="btn ghost" onClick={() => setPicked(people.map((peer) => peer.id))}>{t("rooms.inviteAll")}</button>}
        <div className="invite-list">
          {people.map((peer) => (
            <label key={peer.id} className="check-row">
              <input type="checkbox" checked={picked.includes(peer.id)} onChange={() => toggle(peer.id)} />
              {peer.name}
            </label>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose}>{t("composer.cancel")}</button>
          <button className="btn" type="submit">{t("rooms.start")}</button>
        </div>
      </form>
    </div>
  );
}

function RoomList({ snap, t, openChat, setError }: { snap: Snapshot; t: (key: Key) => string; openChat: (id: string) => void; setError: (value: string) => void }) {
  const [ask, setAsk] = useState<RoomInfo | null>(null);
  const [entered, setEntered] = useState("");
  const [startRoom, setStartRoom] = useState<RoomInfo | "new" | null>(null);
  const liveRooms = snap.rooms.filter((room) => room.conference);
  const idleRooms = snap.rooms.filter((room) => !room.conference);
  return (
    <>
      <section className="list">
        <header><strong>{t("rooms.title")}</strong> <button className="icon-btn" title={t("rooms.start")} onClick={() => setStartRoom("new")}><Plus size={22} /></button></header>
        <div className="scroll">
          {snap.rooms.length === 0 && (
            <div className="empty">
              <p>{t("rooms.empty")}</p>
              <button className="btn" type="button" onClick={() => setStartRoom("new")}>{t("rooms.start")}</button>
            </div>
          )}
          {liveRooms.length > 0 && <div className="list-label">{t("rooms.live")}</div>}
          {liveRooms.map((room) => (
            <button key={room.id} className="room-row live" onClick={() => {
              if (!room.joined) { setAsk(room); return; }
              if (room.conference && engine.state.phase === "idle") void engine.joinConference(room.id, room.conference.hostId, room.name);
              else openChat(roomChat(room.id));
            }}>
              <Avatar name={room.name} color="#2f6fed" />
              <span><div className="name">{room.name}</div><div className="sub"><span className="status-word conf">{t("status.inConf")}</span> · {room.conference?.count ?? room.onlineCount}</div></span>
              {room.passwordHash ? <span className="pill">●</span> : <span />}
            </button>
          ))}
          {idleRooms.map((room) => (
            <button key={room.id} className="room-row" onClick={() => room.joined ? openChat(roomChat(room.id)) : setAsk(room)}>
              <Avatar name={room.name} color="#2f6fed" />
              <span><div className="name">{room.name}</div><div className="sub">{room.onlineCount} {t("conf.members")}{room.createdBy === snap.profile.id ? ` · ${t("rooms.youHost")}` : ""}</div></span>
              {room.passwordHash ? <span className="pill">●</span> : <span />}
            </button>
          ))}
        </div>
        {snap.rooms.length > 0 && <div className="list-foot"><button className="btn wide" type="button" onClick={() => setStartRoom("new")}>{t("rooms.start")}</button></div>}
      </section>
      <section className="thread">
        <div className="settings">
          <h2>{t("rooms.start")}</h2>
          <p className="hint">{t("rooms.hint")}</p>
          <button className="btn" type="button" onClick={() => setStartRoom("new")}>{t("rooms.start")}</button>
          {snap.rooms.filter((room) => room.joined).map((room) => (
            <div key={room.id} className="row">
              <span>{room.name}</span>
              <span>
                {!room.conference && <button type="button" className="btn" onClick={() => setStartRoom(room)}>{t("rooms.start")}</button>}
                {room.conference && room.conference.hostId !== snap.profile.id && engine.state.phase === "idle" && <button type="button" className="btn" onClick={() => void engine.joinConference(room.id, room.conference!.hostId, room.name)}>{t("rooms.joinConf")}</button>}
                <button type="button" className="btn ghost" onClick={() => {
                  const inside = engine.state.roomId === room.id && engine.state.phase !== "idle";
                  void api.invoke("leaveRoom", { roomId: room.id });
                  if (inside) void engine.hangup();
                }}>{t("rooms.leave")}</button>
              </span>
            </div>
          ))}
        </div>
      </section>
      {startRoom && <StartConference snap={snap} t={t} room={startRoom === "new" ? null : startRoom} onClose={() => setStartRoom(null)} setError={setError} />}
      {ask && (
        <div className="modal-back" onClick={() => setAsk(null)}>
          <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.invoke("joinRoom", { roomId: ask.id, password: entered });
              if (ask.conference && engine.state.phase === "idle") await engine.joinConference(ask.id, ask.conference.hostId, ask.name);
              else openChat(roomChat(ask.id));
              setAsk(null);
            } catch {
              setError(t("rooms.badPassword"));
            }
          }}>
            <h2>{ask.name}</h2>
            {ask.passwordHash && <label className="field">{t("rooms.password")}<input type="password" value={entered} onChange={(event) => setEntered(event.target.value)} /></label>}
            <div className="row">
              <button type="button" className="btn ghost" onClick={() => setAsk(null)}>{t("composer.cancel")}</button>
              <button className="btn" type="submit">{t("rooms.join")}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function CallList({ snap, t }: { snap: Snapshot; t: (key: Key) => string }) {
  return (
    <section className="list">
      <header><strong>{t("nav.calls")}</strong></header>
      <div className="scroll">
        {snap.calls.length === 0 && <div className="empty">{t("calls.empty")}</div>}
        {snap.calls.map((call) => (
          <div key={call.id} className="call-row">
            <Phone size={18} />
            <span><div className="name">{call.title}</div><div className="sub">{call.direction === "missed" ? t("calls.missed") : call.direction === "out" ? t("calls.out") : t("calls.in")}</div></span>
            <span className="time">{clock(call.ts)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChatPreview({ t, name }: { t: (key: Key) => string; name: string }) {
  return (
    <div className="chat-preview">
      <div className="msg-row theirs">
        <Avatar name={t("settings.chatPreviewPeer")} color="#5eead4" />
        <div className="bubble-wrap theirs"><article className="bubble theirs"><div className="who">{t("settings.chatPreviewPeer")}</div>{t("settings.chatPreviewIn")}</article></div>
      </div>
      <div className="msg-row mine">
        <div className="bubble-wrap mine"><article className="bubble mine">{t("settings.chatPreviewOut").replaceAll("{name}", name)}</article></div>
      </div>
      <div className="msg-row theirs">
        <Avatar name={t("settings.chatPreviewPeer")} color="#5eead4" />
        <div className="bubble-wrap theirs"><article className="bubble theirs"><div className="voice"><button type="button"><Play size={16} /></button><div className="wave">{[0.3, 0.7, 0.45, 0.9, 0.4, 0.8, 0.35, 0.6].map((peak, index) => <i key={index} style={{ height: `${8 + peak * 16}px` }} />)}</div><span>0:04</span></div></article></div>
      </div>
    </div>
  );
}

function SettingsView({ snap, t, group, onGroup }: { snap: Snapshot; t: (key: Key) => string; group: SettingsGroup; onGroup: (group: SettingsGroup) => void }) {
  const settings = snap.settings;
  const patch = (partial: Partial<Settings>) => void api.invoke("setSettings", partial);
  const groups = ["profile", "appearance", "chat", "notifications", "audio", "video", "files", "games", "about"] as const;
  const groupLabel: Record<(typeof groups)[number], Key> = {
    profile: "settings.group.profile",
    appearance: "settings.group.appearance",
    chat: "settings.group.chat",
    notifications: "settings.group.notifications",
    audio: "settings.group.audio",
    video: "settings.group.video",
    files: "settings.group.files",
    games: "settings.group.games",
    about: "settings.group.about",
  };
  const themes: ThemeId[] = ["ink", "graphite", "harbor", "porcelain", "sand", "iris", "clay", "grove", "ember", "sky", "dusk", "azure", "ice", "navy"];
  return (
    <section className="settings-shell">
      <nav className="settings-nav">
        {groups.map((item) => (
          <button key={item} type="button" className={group === item ? "active" : ""} onClick={() => onGroup(item)}>
            {t(groupLabel[item])}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {group === "profile" && (
          <div className="settings-card">
            <AvatarStudio profile={snap.profile} color={snap.selfColor} t={t} />
            <label className="field">{t("welcome.name")}<input value={snap.profile.name} onChange={(event) => void api.invoke("setProfile", { name: event.target.value })} /></label>
            <div className="field">{t("welcome.status")}</div>
            {(["online", "away", "busy", "invisible"] as const).map((item) => (
              <button key={item} type="button" className={snap.profile.status === item ? "status-row active" : "status-row"} onClick={() => { autoAway.current = false; void api.invoke("setProfile", { status: item }); }}>
                <i className={`presence ${item}`} />
                <span><b className={`status-word ${item}`}>{t(presenceKey(item))}</b><small>{t(statusHint(item))}</small></span>
              </button>
            ))}
          </div>
        )}
        {group === "appearance" && (
          <div className="settings-card">
            <h2>{t("settings.language")}</h2>
            <div className="row">
              <button className={settings.locale === "ru" ? "btn" : "btn ghost"} onClick={() => patch({ locale: "ru" })}>Русский</button>
              <button className={settings.locale === "en" ? "btn" : "btn ghost"} onClick={() => patch({ locale: "en" })}>English</button>
            </div>
            <h2>{t("settings.theme")}</h2>
            <div className="theme-grid">
              {themes.map((theme) => (
                <button key={theme} type="button" className={settings.theme === theme ? "theme-swatch active" : "theme-swatch"} onClick={() => patch({ theme })}>
                  <div className={`swatch swatch-${theme}`} />
                  <span>{t(`settings.theme.${theme}` as Key)}</span>
                </button>
              ))}
            </div>
            <Slider label={t("settings.fontScale")} min={0.85} max={1.3} step={0.05} value={settings.fontScale || 1} text={`${Math.round((settings.fontScale || 1) * 100)}%`} onChange={(fontScale) => patch({ fontScale })} />
            <Toggle label={t("settings.reduceMotion")} on={Boolean(settings.reduceMotion)} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(reduceMotion) => patch({ reduceMotion })} />
            <h2>{t("settings.behavior")}</h2>
            <Slider label={t("settings.away")} min={0} max={60} step={1} value={settings.awayMinutes ?? 10} text={(settings.awayMinutes ?? 10) === 0 ? t("settings.awayOff") : `${settings.awayMinutes ?? 10} ${t("settings.minutes")}`} onChange={(awayMinutes) => patch({ awayMinutes })} />
            <p className="hint">{t("settings.awayHint")}</p>
            <h2>{t("settings.layout")}</h2>
            <p className="hint">{t("settings.layoutHint")}</p>
            <Slider label={t("settings.layoutList")} min={LIST_MIN} max={560} step={10} value={Math.max(LIST_MIN, settings.layoutList || 400)} text={`${Math.round(Math.max(LIST_MIN, settings.layoutList || 400))}`} onChange={(layoutList) => patch({ layoutList })} />
            <Slider label={t("settings.layoutRail")} min={150} max={320} step={10} value={settings.layoutRail || 220} text={`${Math.round(settings.layoutRail || 220)}`} onChange={(layoutRail) => patch({ layoutRail })} />
            <Slider label={t("settings.layoutChat")} min={CHAT_MIN} max={520} step={10} value={Math.max(CHAT_MIN, settings.layoutChat || CHAT_MIN)} text={`${Math.round(Math.max(CHAT_MIN, settings.layoutChat || CHAT_MIN))}`} onChange={(layoutChat) => patch({ layoutChat })} />
          </div>
        )}
        {group === "chat" && (
          <div className="settings-card">
            <h2>{t("settings.chatSize")}</h2>
            <p className="hint">{t("settings.chatSizeHint")}</p>
            <div className="row chat-size-row">
              {(["s", "m", "l"] as const).map((item) => (
                <button key={item} type="button" className={(settings.chatSize || "m") === item ? "btn" : "btn ghost"} onClick={() => patch({ chatSize: item })}>{t(`settings.chatSize.${item}` as Key)}</button>
              ))}
            </div>
            <h2>{t("settings.chatPreview")}</h2>
            <ChatPreview t={t} name={snap.profile.name || "LokaMeet"} />
            <h2>{t("settings.chatLook")}</h2>
            <Toggle label={t("settings.chatDense")} on={Boolean(settings.chatDense)} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(chatDense) => patch({ chatDense })} />
            <Toggle label={t("settings.chatAvatars")} on={settings.chatAvatars !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(chatAvatars) => patch({ chatAvatars })} />
            <Toggle label={t("settings.enterToSend")} on={settings.enterToSend !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(enterToSend) => patch({ enterToSend })} />
          </div>
        )}
        {group === "notifications" && (
          <div className="settings-card">
            <h2>{t("settings.group.notifications")}</h2>
            <Toggle label={t("settings.callSound")} on={settings.callSound} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(callSound) => patch({ callSound })} />
            <Toggle label={t("settings.messageSound")} on={settings.messageSound} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(messageSound) => patch({ messageSound })} />
            <Toggle label={t("settings.notifyJoin")} on={settings.notifyJoin !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(notifyJoin) => patch({ notifyJoin })} />
            <Toggle label={t("settings.notifyRecord")} on={settings.notifyRecord !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(notifyRecord) => patch({ notifyRecord })} />
            <SoundPick kind="call" label={t("settings.tone.call")} value={settings.toneCall || "default"} volume={settings.volumeCall ?? settings.notifyVolume ?? 0.7} t={t} onChange={(toneCall) => patch({ toneCall })} onVolume={(volumeCall) => patch({ volumeCall })} />
            <SoundPick kind="message" label={t("settings.tone.message")} value={settings.toneMessage || "default"} volume={settings.volumeMessage ?? settings.notifyVolume ?? 0.7} t={t} onChange={(toneMessage) => patch({ toneMessage })} onVolume={(volumeMessage) => patch({ volumeMessage })} />
            <SoundPick kind="join" label={t("settings.tone.join")} value={settings.toneJoin || "default"} volume={settings.volumeJoin ?? settings.notifyVolume ?? 0.7} t={t} onChange={(toneJoin) => patch({ toneJoin })} onVolume={(volumeJoin) => patch({ volumeJoin })} />
            <SoundPick kind="record" label={t("settings.tone.record")} value={settings.toneRecord || "default"} volume={settings.volumeRecord ?? settings.notifyVolume ?? 0.7} t={t} onChange={(toneRecord) => patch({ toneRecord })} onVolume={(volumeRecord) => patch({ volumeRecord })} />
          </div>
        )}
        {group === "audio" && <AudioSettings settings={settings} t={t} patch={patch} />}
        {group === "video" && <VideoSettings settings={settings} t={t} patch={patch} />}
        {group === "files" && (
          <div className="settings-card">
            <h2>{t("settings.files")}</h2>
            <label className="field">{t("settings.retention")}<select className="select" value={settings.retentionDays} onChange={(event) => patch({ retentionDays: Number(event.target.value) as 0 | 7 | 30 | 90 })}>
              <option value={0}>{t("settings.never")}</option>
              <option value={7}>7 {t("settings.days")}</option>
              <option value={30}>30 {t("settings.days")}</option>
              <option value={90}>90 {t("settings.days")}</option>
            </select></label>
            <button className="btn ghost" onClick={() => {
              void (async () => {
                const all = settings.retentionDays === 0;
                if (all && !await askConfirm(t("settings.clearAll"), t("common.ok"), t("composer.cancel"))) return;
                void api.invoke("cleanup", { all });
              })();
            }}>{t("settings.clear")}</button>
            <h2>{t("settings.recordDir")}</h2>
            <div className="row"><span className="sub">{settings.recordDir}</span><span><button className="btn ghost" onClick={() => void api.invoke("openPath", { path: settings.recordDir })}>{t("settings.openFolder")}</button> <button className="btn ghost" onClick={() => void api.invoke("pickRecordDir")}>{t("settings.choose")}</button></span></div>
          </div>
        )}
        {group === "games" && (
          <div className="settings-card">
            <h2>{t("games.difficulty")}</h2>
            <p className="hint">{t("games.settingsText")}</p>
            <div className="skill-row settings-skill">
              {(["easy", "normal", "hard"] as const).map((item) => (
                <button key={item} type="button" className={(settings.gameDifficulty || "normal") === item ? `skill-card ${item} on` : `skill-card ${item}`} onClick={() => patch({ gameDifficulty: item })}>
                  <strong>{t(item === "easy" ? "games.easy" : item === "hard" ? "games.hard" : "games.normal")}</strong>
                  <small>{t(item === "easy" ? "games.easyBlurb" : item === "hard" ? "games.hardBlurb" : "games.normalBlurb")}</small>
                </button>
              ))}
            </div>
            <Toggle label={t("games.hints")} on={settings.gameHints !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(gameHints) => patch({ gameHints })} />
            <h2>{t("games.notify")}</h2>
            <p className="hint">{t("games.notifyText")}</p>
            <Toggle label={t("games.inviteSound")} on={settings.gameInviteSound !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(gameInviteSound) => patch({ gameInviteSound })} />
            <SoundPick kind="join" label={t("settings.tone.game")} value={settings.toneJoin || "default"} volume={settings.gameInviteVolume ?? settings.volumeJoin ?? 0.7} t={t} onChange={(toneJoin) => patch({ toneJoin })} onVolume={(gameInviteVolume) => patch({ gameInviteVolume })} />
          </div>
        )}
        {group === "about" && (
          <div className="settings-card about-card">
            <AboutPanel locale={settings.locale} />
          </div>
        )}
      </div>
    </section>
  );
}

function AudioSettings({ settings, t, patch }: { settings: Settings; t: (key: Key) => string; patch: (partial: Partial<Settings>) => void }) {
  const devices = useDevices(true, false);
  const mics = devices.filter((device) => device.kind === "audioinput");
  const speakers = devices.filter((device) => device.kind === "audiooutput");
  return (
    <div className="settings-card">
      <h2>{t("settings.audio")}</h2>
      <p className="hint">{t("settings.devicesHint")}</p>
      <DeviceField label={t("settings.mic")} value={settings.micId} devices={mics} fallback={t("settings.defaultDevice")} onChange={(micId) => patch({ micId })} />
      <div className="field">{t("settings.level")}<MicMeter deviceId={settings.micId} /></div>
      <DeviceField label={t("settings.speaker")} value={settings.speakerId} devices={speakers} fallback={t("settings.defaultDevice")} onChange={(speakerId) => patch({ speakerId })} />
      <button className="btn ghost" type="button" onClick={() => playTone(settings.toneMessage || "message", settings.notifyVolume ?? 0.7)}>{t("settings.testSound")}</button>
      <Toggle label={t("settings.noise")} on={settings.noiseSuppression} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(noiseSuppression) => patch({ noiseSuppression })} />
      <Toggle label={t("settings.echo")} on={settings.echoCancellation !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(echoCancellation) => patch({ echoCancellation })} />
      <Toggle label={t("settings.autoGain")} on={settings.autoGain !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(autoGain) => patch({ autoGain })} />
      <Toggle label={t("settings.joinMuted")} on={Boolean(settings.joinMuted)} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(joinMuted) => patch({ joinMuted })} />
      <Slider label={t("settings.micGain")} min={0} max={2} step={0.05} value={settings.micGain ?? 1} text={`${Math.round((settings.micGain ?? 1) * 100)}%`} onChange={(micGain) => patch({ micGain })} />
      <Toggle label={t("settings.vad")} on={settings.vad} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(vad) => patch({ vad })} />
      <Slider label={t("settings.sensitivity")} min={0} max={100} step={1} value={settings.vadSensitivity} text={String(settings.vadSensitivity)} onChange={(vadSensitivity) => patch({ vadSensitivity })} />
      <Slider label={t("settings.peerVol")} min={0} max={1} step={0.05} value={settings.peerVolume} text={`${Math.round(settings.peerVolume * 100)}%`} onChange={(peerVolume) => patch({ peerVolume })} />
      <Slider label={t("settings.shareVol")} min={0} max={1} step={0.05} value={settings.shareVolume} text={`${Math.round(settings.shareVolume * 100)}%`} onChange={(shareVolume) => patch({ shareVolume })} />
    </div>
  );
}

function VideoSettings({ settings, t, patch }: { settings: Settings; t: (key: Key) => string; patch: (partial: Partial<Settings>) => void }) {
  const devices = useDevices(false, false);
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [actual, setActual] = useState("");
  const presets = ["office", "meeting", "shelf", "loft", "abstract", "solid"];
  const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const resolutions = cameraSizes(caps);
  const rates = cameraRates(caps);
  const facing = Array.isArray(caps.facingMode) ? caps.facingMode.map(String) : [];
  return (
    <div className="settings-card">
      <h2>{t("settings.cameraDevice")}</h2>
      <div className="cam-layout">
        <div>
          <CameraPreview settings={settings} onTrack={(next, info) => { setTrack(next); setActual(info); }} />
          <div className="sub">{actual ? `${t("settings.cameraActual")}: ${actual}` : t("settings.cameraWait")}</div>
        </div>
        <div>
          <DeviceField label={t("settings.cameraDevice")} value={settings.cameraId} devices={cameras} fallback={t("settings.defaultDevice")} onChange={(cameraId) => patch({ cameraId })} />
          <label className="field">{t("settings.resolution")}
            <select className="select" value={`${settings.camWidth || 0}x${settings.camHeight || 0}`} onChange={(event) => {
              const [width, height] = event.target.value.split("x").map(Number);
              patch({ camWidth: width, camHeight: height });
            }}>
              <option value="0x0">{t("settings.auto")}</option>
              {resolutions.map((size) => <option key={`${size.w}x${size.h}`} value={`${size.w}x${size.h}`}>{size.w}×{size.h}</option>)}
            </select>
          </label>
          <label className="field">{t("settings.fps")}
            <select className="select" value={settings.camFps || 0} onChange={(event) => patch({ camFps: Number(event.target.value) })}>
              <option value={0}>{t("settings.auto")}</option>
              {rates.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
            </select>
          </label>
          {facing.length > 0 && (
            <label className="field">{t("settings.facing")}
              <select className="select" value={settings.camFacing || ""} onChange={(event) => patch({ camFacing: event.target.value as Settings["camFacing"] })}>
                <option value="">{t("settings.auto")}</option>
                {facing.includes("user") && <option value="user">{t("settings.facingUser")}</option>}
                {facing.includes("environment") && <option value="environment">{t("settings.facingEnv")}</option>}
              </select>
            </label>
          )}
          <Toggle label={t("settings.mirror")} on={settings.camMirror !== false} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(camMirror) => patch({ camMirror })} />
          <button className="btn ghost" type="button" onClick={() => patch({ camTune: {} })}>{t("settings.camReset")}</button>
        </div>
      </div>
      <h2>{t("settings.camPicture")}</h2>
      <p className="hint">{t("settings.cameraTuneHint")}</p>
      <CameraCaps caps={caps} live={(track?.getSettings?.() ?? {}) as Record<string, unknown>} settings={settings} patch={patch} t={t} />
      <h2>{t("settings.background")}</h2>
      <div className="row">
        <button className={settings.bgMode === "off" ? "btn" : "btn ghost"} onClick={() => patch({ bgMode: "off" })}>{t("settings.bgOff")}</button>
        <button className={settings.bgMode === "blur" ? "btn" : "btn ghost"} onClick={() => patch({ bgMode: "blur" })}>{t("settings.bgBlur")}</button>
        <button className={settings.bgMode === "image" ? "btn" : "btn ghost"} onClick={() => patch({ bgMode: "image" })}>{t("settings.bgImage")}</button>
      </div>
      {settings.bgMode === "blur" && <Slider label={t("settings.blur")} min={4} max={28} step={1} value={settings.bgBlur} text={String(settings.bgBlur)} onChange={(bgBlur) => patch({ bgBlur })} />}
      {settings.bgMode === "image" && (
        <>
          <div className="row">{presets.map((preset) => <button key={preset} className="icon-btn" onClick={() => patch({ bgPreset: preset, bgCustom: "" })}><img alt="" src={`${import.meta.env.BASE_URL}backgrounds/${preset}.svg`} width={64} height={36} /></button>)}</div>
          <label className="btn ghost">{t("settings.bgOwn")}<input hidden type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => patch({ bgMode: "image", bgCustom: String(reader.result || "") });
            reader.readAsDataURL(file);
          }} /></label>
        </>
      )}
    </div>
  );
}

function DeviceField({ label, value, devices, fallback, onChange }: { label: string; value: string; devices: MediaDeviceInfo[]; fallback: string; onChange: (id: string) => void }) {
  return (
    <label className="field">{label}
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{fallback}</option>
        {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}
      </select>
    </label>
  );
}

function useDevices(audio: boolean, video: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let cancel = false;
    const load = async () => {
      if (audio || video) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          /* labels stay empty until permission */
        }
      }
      const found = await navigator.mediaDevices.enumerateDevices();
      if (!cancel) setDevices(found);
    };
    void load();
    const onChange = () => void load();
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      cancel = true;
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, [audio, video]);
  return devices;
}

function MicMeter({ deviceId }: { deviceId: string }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    let ctx: AudioContext | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      } catch {
        return;
      }
      if (stop) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const x = (value - 128) / 128;
          sum += x * x;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 5));
      }, 80);
    })();
    return () => {
      stop = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close();
    };
  }, [deviceId]);
  return <div className="meter"><i style={{ width: `${Math.round(level * 100)}%` }} /></div>;
}

function CameraPreview({ settings, onTrack }: { settings: Settings; onTrack: (track: MediaStreamTrack | null, info: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onTrackRef = useRef(onTrack);
  onTrackRef.current = onTrack;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancel = false;
    void navigator.mediaDevices.getUserMedia({ audio: false, video: cameraConstraints(settings) }).then(async (media) => {
      if (cancel) {
        media.getTracks().forEach((item) => item.stop());
        return;
      }
      stream = media;
      const next = media.getVideoTracks()[0] ?? null;
      trackRef.current = next;
      if (next) await applyCameraTune(next, settings);
      if (ref.current) ref.current.srcObject = media;
      const got = next?.getSettings();
      onTrackRef.current(next, got?.width ? `${got.width}×${got.height ?? "?"} · ${got.frameRate ? Math.round(got.frameRate) : "?"} fps` : "");
    }).catch(() => onTrackRef.current(null, ""));
    return () => {
      cancel = true;
      trackRef.current = null;
      stream?.getTracks().forEach((item) => item.stop());
      onTrackRef.current(null, "");
    };
  }, [settings.cameraId, settings.camWidth, settings.camHeight, settings.camFps, settings.camFacing]);
  useEffect(() => {
    const next = trackRef.current;
    if (next) void applyCameraTune(next, settings);
  }, [settings.camTune, settings]);
  return (
    <div className="cam-frame">
      <video ref={ref} className={settings.camMirror === false ? "cam-preview" : "cam-preview mirror"} autoPlay muted playsInline />
    </div>
  );
}

function Slider({ label, min, max, step, value, text, onChange }: { label: string; min: number; max: number; step: number; value: number; text: string; onChange: (value: number) => void }) {
  return (
    <label className="field slider-field">
      <span className="slider-top"><span>{label}</span><b>{text}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function SoundPick({ kind, label, value, volume, t, onChange, onVolume }: { kind: "call" | "message" | "join" | "record"; label: string; value: string; volume: number; t: (key: Key) => string; onChange: (value: string) => void; onVolume: (value: number) => void }) {
  const custom = value.startsWith("file:");
  return (
    <div className="sound-pick">
      <div className="slider-top">
        <span>{label}</span>
        <button className="btn ghost" type="button" onClick={() => playTone(custom ? value : `pack-${kind}`, volume)}>{t("settings.soundPreview")}</button>
      </div>
      <Slider label={t("settings.tone.volume")} min={0} max={1} step={0.05} value={volume} text={`${Math.round(volume * 100)}%`} onChange={onVolume} />
      <div className="choice-row">
        <button type="button" className={!custom ? "btn" : "btn ghost"} onClick={() => onChange("default")}>{t("settings.tone.default")}</button>
        <label className={custom ? "btn" : "btn ghost"}>
          {t("settings.tone.custom")}
          <input hidden type="file" accept="audio/*" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.arrayBuffer().then((buffer) => api.invoke<string>("storeFile", { name: file.name, bytes: new Uint8Array(buffer) })).then((path) => onChange(`file:${path}`));
          }} />
        </label>
      </div>
      {custom && <div className="sub">{value.slice(5).split(/[\\/]/).pop()}</div>}
    </div>
  );
}

function Toggle({ label, on, set, onLabel, offLabel }: { label: string; on: boolean; set: (value: boolean) => void; onLabel: string; offLabel: string }) {
  return <div className="row"><span>{label}</span><button className="btn ghost" onClick={() => set(!on)}>{on ? onLabel : offLabel}</button></div>;
}

function presenceKey(status: Presence | undefined): Key {
  if (status === "invisible") return "status.invisible";
  if (status === "busy") return "status.busy";
  if (status === "away") return "status.away";
  return "status.online";
}

function statusHint(status: Presence): Key {
  if (status === "invisible") return "status.hint.invisible";
  if (status === "busy") return "status.hint.busy";
  if (status === "away") return "status.hint.away";
  return "status.hint.online";
}

function faceOf(snap: Snapshot, peerId: string, self: boolean, fallback: string): { name: string; color: string; photo?: string; focus?: AvatarFocus; status?: string } {
  if (self || peerId === snap.profile.id) {
    return { name: snap.profile.name, color: snap.selfColor, photo: snap.profile.avatar, focus: snap.profile.avatarFocus, status: snap.profile.status };
  }
  const peer = snap.peers.find((item) => item.id === peerId);
  return {
    name: fallback || peer?.name || "",
    color: peer?.color || "#4c8dff",
    photo: peer?.avatar,
    focus: peer?.avatarFocus,
    status: peer?.inCall ? (peer.callKind === "conf" ? "conf" : "call") : peer?.status,
  };
}

function recPeerClock(live: { recTimes: Record<string, number> }): ReactNode {
  const started = Object.values(live.recTimes)[0];
  if (!started) return null;
  return <Clock started={started} />;
}

function ChatRecStrip({ chatId, t }: { chatId: string; t: (key: Key) => string }) {
  const live = useSyncExternalStore(engine.subscribe, () => engine.state);
  const dm = chatId.startsWith("dm:") ? chatId.slice(3) : "";
  const room = chatId.startsWith("room:") ? chatId.slice(5) : "";
  let started = 0;
  if (live.recording && live.recStarted) {
    if (live.mode === "p2p" && live.peerId && dm === live.peerId) started = live.recStarted;
    if (live.mode === "conf" && live.roomId && room === live.roomId) started = live.recStarted;
  }
  if (!started && dm && live.recTimes[dm]) started = live.recTimes[dm];
  if (!started && room) {
    const times = Object.values(live.recTimes);
    if (times.length) started = Math.min(...times);
  }
  if (!started) return null;
  return (
    <div className="chat-rec-strip">
      <span className="rec-dot" />
      <strong>{t("conf.rec")}</strong>
      <Clock started={started} />
    </div>
  );
}

function Clock({ started }: { started: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{duration(started, now)}</>;
}

function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const node = root.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, root]);
}

function chatFaces(snap: Snapshot, chatId: string): Array<{ id: string; name: string; color: string; photo?: string; focus?: AvatarFocus }> {
  if (chatId.startsWith("dm:")) {
    const peer = personById(snap, chatId.slice(3));
    return peer ? [{ id: peer.id, name: peer.name, color: peer.color, photo: peer.avatar, focus: peer.avatarFocus }] : [];
  }
  const room = snap.rooms.find((item) => item.id === chatId.slice(5));
  if (!room) return [];
  const ids = room.members.length ? room.members : [room.createdBy, snap.profile.id];
  const faces: Array<{ id: string; name: string; color: string; photo?: string; focus?: AvatarFocus }> = [];
  for (const id of ids) {
    if (faces.length >= 4) break;
    if (id === snap.profile.id) faces.push({ id, name: snap.profile.name, color: snap.selfColor, photo: snap.profile.avatar, focus: snap.profile.avatarFocus });
    else {
      const peer = personById(snap, id);
      if (peer) faces.push({ id, name: peer.name, color: peer.color, photo: peer.avatar, focus: peer.avatarFocus });
    }
  }
  return faces;
}

function personById(snap: Snapshot, id: string): PeerInfo | undefined {
  const live = snap.peers.find((peer) => peer.id === id);
  if (live) return live;
  const contact = snap.contacts?.[id];
  if (!contact) return undefined;
  return {
    id: contact.id,
    name: contact.name,
    color: contact.color,
    ip: "",
    port: 0,
    avatar: contact.avatar,
    avatarFocus: contact.avatarFocus,
    inCall: false,
    recording: false,
    sharing: false,
    online: false,
    status: "offline",
    firstSeen: contact.ts,
    lastSeen: contact.ts,
  };
}

function activityOf(snap: Snapshot, id: string, self: boolean): { recording: boolean; sharing: boolean } {
  const live = engine.state;
  const peer = snap.peers.find((item) => item.id === id);
  return {
    recording: (self && live.recording) || live.recorders.includes(id) || Boolean(peer?.recording),
    sharing: (self && live.shareOn) || live.tiles.some((tile) => tile.source === "screen" && tile.peerId === id) || Boolean(peer?.sharing),
  };
}

function NickMarks({ recording, sharing, muted = false, t }: { recording: boolean; sharing: boolean; muted?: boolean; t: (key: Key) => string }) {
  if (!recording && !sharing && !muted) return null;
  return (
    <span className="nick-marks">
      {muted && <span className="mark-mute"><MicOff size={11} />{t("call.micOffShort")}</span>}
      {recording && <span className="mark-rec">REC</span>}
      {sharing && <span className="mark-live"><Monitor size={11} strokeWidth={2.4} />{t("status.sharing")}</span>}
    </span>
  );
}

function titleOf(snap: Snapshot, chatId: string, t: (key: Key) => string): { name: string; color: string; photo?: string; focus?: AvatarFocus } {
  const meta = snap.threads?.[chatId];
  if (chatId.startsWith("dm:")) {
    const peer = personById(snap, chatId.slice(3));
    return {
      name: peer?.name || meta?.title || t("chats.direct"),
      color: peer?.color || meta?.color || "#4c8dff",
      photo: peer?.avatar || meta?.photo,
      focus: peer?.avatarFocus || meta?.avatarFocus,
    };
  }
  if (chatId.startsWith("room:")) {
    const room = snap.rooms.find((item) => item.id === chatId.slice(5));
    const fromSys = roomNameFromMessages(snap.messages[chatId] ?? []);
    return {
      name: room?.name || meta?.title || fromSys || t("chats.group"),
      color: meta?.color || "#2f6fed",
      photo: meta?.photo,
      focus: meta?.avatarFocus,
    };
  }
  return { name: meta?.title || t("chats.pick"), color: meta?.color || "#2f6fed", photo: meta?.photo, focus: meta?.avatarFocus };
}

function roomNameFromMessages(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index].text || "";
    if (!text.startsWith("sys:")) continue;
    const name = text.split("\t")[2]?.trim();
    if (name) return name;
    const quoted = text.match(/[«"]([^»"]+)[»"]/);
    if (quoted?.[1]) return quoted[1];
  }
  return "";
}

function peerOf(snap: Snapshot, chatId: string): PeerInfo | undefined {
  if (!chatId.startsWith("dm:")) return undefined;
  return personById(snap, chatId.slice(3));
}

async function sniffFile(file: File): Promise<"photo" | "anim" | "video" | "file"> {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = String.fromCharCode(...head.slice(0, 16));
  if (ascii.startsWith("GIF8")) return "anim";
  if (head[0] === 0x89 && head[1] === 0x50) {
    const sample = new TextDecoder("latin1").decode(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    return sample.includes("acTL") ? "anim" : "photo";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    const sample = new TextDecoder("latin1").decode(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    return sample.includes("ANIM") || sample.includes("ANMF") ? "anim" : "photo";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "AVI ") return "video";
  if (head[0] === 0xff && head[1] === 0xd8) return "photo";
  if (head[0] === 0x42 && head[1] === 0x4d) return "photo";
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12).toLowerCase();
    if (brand.startsWith("hei") || brand === "avif" || brand === "avis" || brand === "mif1") return "photo";
    return "video";
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v|ogv|qt)$/.test(name)) return "video";
  if (type === "image/gif" || name.endsWith(".gif") || name.endsWith(".apng")) return "anim";
  if (type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|avif|heic|heif)$/.test(name)) return "photo";
  return "file";
}

function sightKind(sight: "photo" | "anim" | "video" | "file"): ChatMessage["kind"] {
  if (sight === "photo") return "image";
  if (sight === "anim") return "gif";
  if (sight === "video") return "video";
  return "file";
}

function looksVideo(file: { mime?: string; name?: string }): boolean {
  const mime = (file.mime || "").toLowerCase();
  if (mime.startsWith("audio/")) return false;
  if (mime.startsWith("video/")) return true;
  const name = (file.name || "").toLowerCase();
  return /\.(mp4|m4v|mov|mkv|avi|ogv|qt)$/.test(name) || (name.endsWith(".webm") && mime.length > 0);
}

function mimeOf(file: File): string {
  const type = file.type.toLowerCase();
  if (type && type !== "application/octet-stream") return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mov") || name.endsWith(".qt")) return "video/quicktime";
  if (name.endsWith(".mkv")) return "video/x-matroska";
  if (name.endsWith(".avi")) return "video/x-msvideo";
  if (name.endsWith(".ogv")) return "video/ogg";
  return file.type || "application/octet-stream";
}

function videoPoster(file: File): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(""), 4000);
    const paint = () => {
      window.clearTimeout(timer);
      if (!video.videoWidth) {
        finish("");
        return;
      }
      const scale = Math.min(1, 480 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL("image/jpeg", 0.72));
    };
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = () => {
      if (video.duration > 0.3) video.currentTime = Math.min(0.4, video.duration / 4);
      else paint();
    };
    video.onseeked = paint;
    video.onerror = () => {
      window.clearTimeout(timer);
      finish("");
    };
    video.src = url;
  });
}

function Splitter({ className, onStart, onDelta, onDone }: { className: string; onStart: () => void; onDelta: (dx: number) => void; onDone: () => void }) {
  const down = useRef(false);
  return (
    <div
      className={`splitter ${className}`}
      onPointerDown={(event) => {
        down.current = true;
        onStart();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => { if (down.current) onDelta(event.movementX); }}
      onPointerUp={() => { if (!down.current) return; down.current = false; onDone(); }}
      onPointerCancel={() => { if (!down.current) return; down.current = false; onDone(); }}
    />
  );
}

function imagePreview(file: File): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    const done = (value: string) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    image.onload = () => {
      const scale = Math.min(1, 480 / Math.max(1, image.width));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      done(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => done("");
    image.src = url;
  });
}

function fileUrl(filePath: string): string {
  return `loka://media/?path=${encodeURIComponent(filePath)}`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ts: number, locale: string, t: (key: Key) => string): string {
  const date = new Date(ts);
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return t("chats.today");
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(y.getTime())) return t("chats.yesterday");
  return date.toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long" });
}

function stamp(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function duration(started: number, now = Date.now()): string {
  if (!started) return "00:00";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function when(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isMotion(src?: string): boolean {
  return Boolean(src?.startsWith("data:video/"));
}

function focusStyle(focus?: AvatarFocus): CSSProperties {
  const zoom = Math.max(1, focus?.zoom || 1);
  const x = clamp(focus?.x ?? 50, 0, 100);
  const y = clamp(focus?.y ?? 50, 0, 100);
  return {
    objectFit: "cover",
    objectPosition: `${x}% ${y}%`,
    transform: `scale(${zoom})`,
    transformOrigin: `${x}% ${y}%`,
  };
}

function peerView(peer: PeerInfo, t: (key: Key) => string): { kind: string; label: string } {
  if (peer.inCall) return peer.callKind === "conf" ? { kind: "conf", label: t("status.inConf") } : { kind: "call", label: t("status.inCall") };
  if (peer.status === "busy") return { kind: "busy", label: t("status.busy") };
  if (peer.status === "away") return { kind: "away", label: t("status.away") };
  if (!peer.online || peer.status === "offline") return { kind: "offline", label: t("status.offline") };
  return { kind: "online", label: t("status.online") };
}

function selfView(status: Presence | undefined, inCall: boolean, mode: "p2p" | "conf" | null, t: (key: Key) => string): { kind: string; label: string } {
  if (inCall) return mode === "conf" ? { kind: "conf", label: t("status.inConf") } : { kind: "call", label: t("status.inCall") };
  if (status === "busy") return { kind: "busy", label: t("status.busy") };
  if (status === "invisible") return { kind: "invisible", label: t("status.invisible") };
  if (status === "away") return { kind: "away", label: t("status.away") };
  return { kind: "online", label: t("status.online") };
}

function formatSystem(text: string, t: (key: Key) => string, ts = 0): string {
  if (!text.startsWith("sys:")) return text;
  const [code, name = "", room = ""] = text.split("\t");
  const key = ({
    "sys:join-room": "sys.joinRoom",
    "sys:join-conf": "sys.joinConf",
    "sys:start-conf": "sys.startConf",
    "sys:leave-conf": "sys.leaveConf",
    "sys:end-conf": "sys.endConf",
    "sys:join-call": "sys.joinCall",
    "sys:leave-call": "sys.leaveCall",
    "sys:rec-on": "sys.recOn",
    "sys:rec-off": "sys.recOff",
    "sys:rec-saved": "sys.recSaved",
    "sys:control-ask": "sys.controlAsk",
    "sys:control-ok": "sys.controlOk",
    "sys:control-no": "sys.controlNo",
    "sys:control-end": "sys.controlEnd",
  } as Record<string, Key>)[code];
  if (!key) return text;
  const time = ts ? clock(ts) : clock(Date.now());
  return t(key).replaceAll("{name}", name).replaceAll("{room}", room).replaceAll("{time}", time);
}

function desktopNotice(_text: string, _enabled: boolean): void {
  /* Windows toast popups stay off while the app is running */
}

function PeerCard({ peer, t, onClose }: { peer: PeerInfo; t: (key: Key) => string; onClose: () => void }) {
  const view = peerView(peer, t);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal peer-card" onClick={(event) => event.stopPropagation()}>
        <Avatar name={peer.name} color={peer.color} photo={peer.avatar} focus={peer.avatarFocus} large status={view.kind} />
        <h2>{peer.name} <NickMarks recording={Boolean(peer.recording) || engine.state.recorders.includes(peer.id)} sharing={Boolean(peer.sharing) || engine.state.tiles.some((tile) => tile.source === "screen" && tile.peerId === peer.id)} t={t} /></h2>
        <div className={`status-word ${view.kind}`}>{view.label}</div>
        <div className="peer-meta">
          <div><span>{t("profile.connected")}</span><b>{when(peer.firstSeen)}</b></div>
          <div><span>{t("profile.lastSeen")}</span><b>{when(peer.lastSeen)}</b></div>
          <div><span>{t("profile.address")}</span><b>{peer.ip}:{peer.port}</b></div>
        </div>
        <button className="btn ghost" type="button" onClick={onClose}>{t("composer.cancel")}</button>
      </div>
    </div>
  );
}

function AvatarStudio({ profile, color, t }: { profile: Profile; color: string; t: (key: Key) => string }) {
  const [src, setSrc] = useState(profile.avatar || "");
  const [focus, setFocus] = useState<AvatarFocus>(profile.avatarFocus || { x: 50, y: 50, zoom: 1 });
  const [error, setError] = useState("");
  const focusRef = useRef(focus);
  const drag = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef(0);
  focusRef.current = focus;
  useEffect(() => {
    if (drag.current) return;
    setSrc(profile.avatar || "");
    const next = profile.avatarFocus || { x: 50, y: 50, zoom: 1 };
    setFocus(next);
    focusRef.current = next;
  }, [profile.avatar, profile.avatarFocus?.x, profile.avatarFocus?.y, profile.avatarFocus?.zoom]);
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = focusRef.current;
      commit({ ...current, zoom: clamp(current.zoom + (event.deltaY < 0 ? 0.08 : -0.08), 1, 3) });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [src]);
  function commit(next: AvatarFocus, avatar?: string) {
    focusRef.current = next;
    setFocus(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.invoke("setProfile", avatar !== undefined ? { avatar, avatarFocus: next } : { avatarFocus: next });
    }, 160);
  }
  function onFile(file?: File) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError(t("profile.tooBig"));
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      setSrc(url);
      commit({ x: 50, y: 50, zoom: 1 }, url);
    };
    reader.readAsDataURL(file);
  }
  const motion = isMotion(src);
  return (
    <div>
      <div className="profile-hero">
        <div
          className="crop-stage"
          ref={stageRef}
          style={{ background: color }}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY, fx: focusRef.current.x, fy: focusRef.current.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const origin = drag.current;
            if (!origin) return;
            const box = event.currentTarget.getBoundingClientRect();
            const next = {
              ...focusRef.current,
              x: clamp(origin.fx - ((event.clientX - origin.x) / box.width) * 100, 0, 100),
              y: clamp(origin.fy - ((event.clientY - origin.y) / box.height) * 100, 0, 100),
            };
            focusRef.current = next;
            setFocus(next);
          }}
          onPointerUp={() => {
            if (!drag.current) return;
            drag.current = null;
            commit(focusRef.current);
          }}
        >
          {src && motion ? <video src={src} autoPlay muted loop playsInline style={focusStyle(focus)} /> : src ? <img src={src} alt="" style={focusStyle(focus)} /> : <span style={{ fontSize: 48, position: "relative" }}>{profile.name.slice(0, 1).toUpperCase() || "L"}</span>}
        </div>
        <div>
          <div className="name">{profile.name || t("welcome.name")}</div>
          <p className="hint">{t("profile.cropHint")}</p>
        </div>
      </div>
      <label className="field">{t("profile.zoom")}<input type="range" min={1} max={3} step={0.05} value={focus.zoom} onChange={(event) => commit({ ...focusRef.current, zoom: Number(event.target.value) })} /></label>
      <div className="row">
        <label className="btn ghost">{t("settings.photo")}<input hidden type="file" accept="image/*,video/webm,video/mp4,.gif,.webp" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
        <button className="btn ghost" type="button" onClick={() => commit({ x: 50, y: 50, zoom: 1 })}>{t("profile.resetCrop")}</button>
        {src && <button className="btn ghost" type="button" onClick={() => { setSrc(""); void api.invoke("setProfile", { avatar: "" }); }}>{t("settings.clearPhoto")}</button>}
      </div>
      {error && <p className="hint">{error}</p>}
    </div>
  );
}

const CAMERA_SKIP = new Set(["deviceId", "groupId", "width", "height", "frameRate", "aspectRatio", "facingMode", "resizeMode", "latency"]);
const CAP_LABEL: Record<string, Key> = {
  zoom: "cam.zoom",
  brightness: "cam.brightness",
  contrast: "cam.contrast",
  saturation: "cam.saturation",
  sharpness: "cam.sharpness",
  exposureCompensation: "cam.exposureCompensation",
  colorTemperature: "cam.colorTemperature",
  focusDistance: "cam.focusDistance",
  iso: "cam.iso",
  exposureTime: "cam.exposureTime",
  pan: "cam.pan",
  tilt: "cam.tilt",
  torch: "cam.torch",
  focusMode: "cam.focusMode",
  exposureMode: "cam.exposureMode",
  whiteBalanceMode: "cam.whiteBalanceMode",
};

function cameraSizes(caps: Record<string, unknown>): Array<{ w: number; h: number }> {
  const width = caps.width as { max?: number } | undefined;
  const max = width?.max ?? 1920;
  return [{ w: 640, h: 480 }, { w: 1280, h: 720 }, { w: 1920, h: 1080 }].filter((size) => size.w <= max + 16);
}

function cameraRates(caps: Record<string, unknown>): number[] {
  const frame = caps.frameRate as { max?: number } | undefined;
  const max = frame?.max ?? 30;
  return [15, 24, 30, 60].filter((rate) => rate <= max + 1);
}

function modeLabel(item: unknown, t: (key: Key) => string): string {
  const value = String(item);
  if (value === "continuous" || value === "auto") return t("settings.auto");
  if (value === "manual") return t("settings.camManual");
  return value;
}

function CameraCaps({ caps, live, settings, patch, t }: { caps: Record<string, unknown>; live: Record<string, unknown>; settings: Settings; patch: (partial: Partial<Settings>) => void; t: (key: Key) => string }) {
  const keys = Object.keys(caps).filter((key) => !CAMERA_SKIP.has(key));
  if (!keys.length) return <p className="hint">{t("settings.cameraPlain")}</p>;
  const tune = settings.camTune ?? {};
  const write = (key: string, value: number | string | boolean) => patch({ camTune: { ...tune, [key]: value } });
  const picture = ["brightness", "contrast", "saturation", "sharpness", "exposureCompensation"];
  const modes = ["focusMode", "exposureMode", "whiteBalanceMode"];
  const rest = keys.filter((key) => !picture.includes(key) && !modes.includes(key));
  const draw = (key: string) => {
    const cap = caps[key];
    if (cap == null) return null;
    const label = CAP_LABEL[key] ? t(CAP_LABEL[key]) : key;
    if (Array.isArray(cap)) {
      return (
        <label className="field" key={key}>{label}
          <select className="select" value={String(tune[key] ?? live[key] ?? "")} onChange={(event) => write(key, event.target.value)}>
            <option value="">{t("settings.auto")}</option>
            {cap.map((item) => <option key={String(item)} value={String(item)}>{modeLabel(item, t)}</option>)}
          </select>
        </label>
      );
    }
    if (cap && typeof cap === "object" && "min" in cap && "max" in cap) {
      const range = cap as { min: number; max: number; step?: number };
      const min = Number(range.min);
      const max = Number(range.max);
      const span = max - min || 1;
      const stored = tune[key];
      const hardware = Number(live[key]);
      const colorDefault = min + span * 0.62;
      let current = Number(stored);
      if (stored == null || stored === "") current = Number.isFinite(hardware) ? hardware : key === "saturation" ? colorDefault : min + span * 0.5;
      if (key === "saturation" && (!Number.isFinite(current) || current <= min + span * 0.08)) current = colorDefault;
      const pct = Math.round(((current - min) / span) * 100);
      return (
        <label className="field slider-field" key={key}>
          <span className="slider-top"><span>{label}</span><b>{pct}%</b></span>
          <input type="range" min={min} max={max} step={Number(range.step) || span / 100} value={current} onChange={(event) => {
            const next = Number(event.target.value);
            write(key, key === "saturation" ? Math.max(next, min + span * 0.12) : next);
          }} />
        </label>
      );
    }
    if (typeof cap === "boolean" || key === "torch") {
      return <Toggle key={key} label={label} on={Boolean(tune[key] ?? live[key])} onLabel={t("settings.on")} offLabel={t("settings.off")} set={(value) => write(key, value)} />;
    }
    return null;
  };
  return (
    <>
      {picture.map(draw)}
      {modes.some((key) => caps[key] != null) && <h2>{t("settings.camModes")}</h2>}
      {modes.map(draw)}
      {rest.length > 0 && (
        <details className="cam-more">
          <summary>{t("settings.camMore")}</summary>
          {rest.map(draw)}
        </details>
      )}
    </>
  );
}
