import noto from "../../public/licenses/noto-emoji-OFL.txt?raw";
import lucide from "../../public/licenses/lucide-ISC.txt?raw";
import lottie from "../../public/licenses/lottie-web-MIT.txt?raw";
import mediasoup from "../../public/licenses/mediasoup-ISC.txt?raw";

export const THIRD_PARTY_LICENSES = [
  {
    id: "noto",
    title: "Noto Emoji Animation",
    useRu: "Анимированные смайлы в чате",
    useEn: "Animated smileys in chat",
    spdx: "OFL-1.1",
    url: "https://github.com/googlefonts/noto-emoji",
    notice: "Copyright 2013 Google LLC",
    text: noto.trim(),
  },
  {
    id: "lucide",
    title: "Lucide",
    useRu: "Значки кнопок и интерфейса",
    useEn: "Button and interface icons",
    spdx: "ISC",
    url: "https://lucide.dev",
    notice: "Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.",
    text: lucide.trim(),
  },
  {
    id: "lottie",
    title: "lottie-web",
    useRu: "Проигрыватель анимации смайлов",
    useEn: "Smiley animation player",
    spdx: "MIT",
    url: "https://github.com/airbnb/lottie-web",
    notice: "Copyright (c) 2015 Bodymovin",
    text: lottie.trim(),
  },
  {
    id: "mediasoup",
    title: "mediasoup",
    useRu: "Медиаконференции в комнатах",
    useEn: "Room conference media",
    spdx: "ISC",
    url: "https://mediasoup.org",
    notice: "Copyright © 2015, Iñaki Baz Castillo <ibc@aliax.net>",
    text: mediasoup.trim(),
  },
] as const;
