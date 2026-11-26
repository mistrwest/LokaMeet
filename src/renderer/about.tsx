import { api } from "./api";
import { APP_REPO, APP_VERSION } from "../shared/version";
import { THIRD_PARTY_LICENSES } from "./third-party-licenses";

const logoUrl = `${import.meta.env.BASE_URL}icon.png`;

type Release = { version: string; added: string[]; fixed: string[] };

function copyFor(ru: boolean) {
  const releases: Release[] = ru
    ? [
        {
          version: "2.0.0",
          added: [
            "Единое окно: чаты, LAN, комнаты, журнал звонков, игры и настройки.",
            "Конференции до 15 человек через хост комнаты (mediasoup); личные звонки — WebRTC P2P без интернета.",
            "Комнаты с именем и паролем, приглашения из LAN, групповой чат конференции.",
            "Чаты: текст, картинки, GIF, видео, файлы, голосовые, цитаты, правка, удаление, превью ссылок.",
            "Анимированные смайлы Noto в панели над полем ввода.",
            "Передача файлов отдельным WebRTC DataChannel; перетаскивание и вставка из буфера.",
            "Статусы онлайн / отошёл / занят / невидимка, авто‑«отошёл», фото или видео‑аватар с кадрированием.",
            "Демонстрация экрана: мониторы, окна, все экраны сразу, звук компьютера, камера докладчика в углу.",
            "Управление рабочим столом: запрос с миганием кнопки, выбор монитора тем, кем управляют, мышь и клавиатура, полный экран картинки, приоритет хозяина стола.",
            "Запись сцены в MP4, микрофон по голосу, виртуальный фон камеры, полноэкранный звонок и свёртка в плашку.",
            "Игры в звонке и отдельно: шахматы, русские шашки, морской бой — с человеком, комнатой или компьютером.",
            "Темы, масштаб шрифта, RU/EN, звуки событий, журнал в logs, установщик и portable‑сборка.",
          ],
          fixed: [
            "После соединения голос больше не пропадает через пару секунд: удалённый звук идёт так, чтобы эхоподавление не глушило микрофон.",
            "Собеседники слышат друг друга громче: компрессия и усиление на отправке.",
            "Микрофон по голосу открывается от речи, не глотает начало слова и держит паузы между словами. Настройка действует сразу в звонке.",
            "Вертикальная линия между списком чатов и перепиской выровнена по шапке.",
          ],
        },
        {
          version: "1.4.0",
          added: [
            "Демонстрация экрана идёт с частотой монитора: не ниже 60 и не выше 120 кадров/с. Значение видно в «Медиа», под качеством видео. Разрешение совпадает с экраном, кадр не обрезается.",
            "Микрофон по голосу: ползунок чувствительности во вкладке «Аудио». Выше — микрофон открывается от более тихого голоса. Пока вы молчите, звук собеседнику не уходит.",
            "В шашках, шахматах и морском бое можно играть с компьютером: легко, средне и сложно.",
            "Настройки камеры (фокус, экспозиция, яркость и остальные) показываются только если устройство их поддерживает.",
            "Папка логов и очистка истории чата находятся во вкладке «Интерфейс».",
          ],
          fixed: [
            "При демонстрации видео кадры больше не режутся и не пропадают: картинка ближе к оригиналу, движение остаётся плавным.",
            "Микрофон по голосу больше не глотает начало слова и паузы между словами. Чувствительность не портит звук собеседника.",
            "Собеседник снова слышит вас с нормальной громкостью: шумоподавление не уводит уровень вниз и не затрагивает чужой микрофон.",
            "Размытие и замена фона держат контур. Силуэт не мигает, комната не остаётся каймой, закрытое лицо не выедает голову.",
            "Автофокус наводится и когда лицо в кадре, и когда его закрывают. Камера не остаётся размытой, фон ложится по силуэту.",
          ],
        },
        {
          version: "1.3.0",
          added: [
            "Сообщение со скриншотом, ссылкой или GIF уходит одним пузырём: подпись и вложение вместе.",
            "Сообщения можно цитировать — кнопка ответа или правый клик.",
            "В играх отдельная кнопка «Играть с собеседником».",
            "Превью в чате открываются по клику: картинки, анимация, видео и ролики VK.",
            "Вставка из буфера остаётся в поле сообщения: можно дописать текст и отправить вместе.",
            "Начало и конец записи подсвечиваются в чате.",
            "Если окно не активно, кнопка LokaMeet на панели задач мигает при сообщении или событии звонка.",
          ],
          fixed: [
            "Микрофон больше не пропадает при выключении камеры — ни в обычном разговоре, ни во время демонстрации со звуком.",
            "Статичная картинка при демонстрации экрана больше не моргает.",
          ],
        },
        {
          version: "1.2.0",
          added: [
            "Игры во время личного звонка или конференции: русские шашки, шахматы и морской бой. Партия идёт по локальному каналу.",
            "Приглашение соперника; в конференции остальные могут смотреть партию.",
            "Сдача, ничья, реванш, счёт партий; полноэкранная доска или возврат к видеоплиткам.",
            "Шахматы: полные правила (рокировка, взятие на проходе, превращение, мат, пат, ничьи).",
            "Русские шашки: дамки, обязательное взятие.",
            "Морской бой: поле 10×10, туман войны, попадания и потопления.",
          ],
          fixed: [],
        },
        {
          version: "1.1.0",
          added: [
            "Вкладка «Камера»: зум и сдвиг кадра, виртуальный фон (размытие, пресеты, свои картинки), ручные параметры камеры.",
            "Запись звонка или конференции в MP4 / AVI.",
            "Качество исходящего видео: Авто / 360p–4K; камера докладчика поверх демонстрации экрана.",
            "Подтверждение выхода из звонка; отмена передачи файла.",
          ],
          fixed: [
            "Чёрные ореолы вокруг рук и движущихся объектов при замене фона.",
          ],
        },
        {
          version: "1.0.2",
          added: [
            "Установщик Windows в Program Files с выбором папки; перед копированием файлов приложение закрывается.",
            "Полная локализация RU/EN; индикаторы речи и статусов в списке LAN.",
          ],
          fixed: [
            "Ошибка «Failed to close LokaMeet» при установке поверх запущенной программы.",
          ],
        },
        {
          version: "1.0.1",
          added: ["Первый публичный выпуск: LAN‑обнаружение, личные звонки, чат и файлы без интернета."],
          fixed: [],
        },
      ]
    : [
        {
          version: "2.0.0",
          added: [
            "One window: chats, LAN, rooms, call log, games and settings.",
            "Conferences of up to 15 people through the room host (mediasoup); one-to-one calls stay WebRTC P2P with no internet.",
            "Named rooms with optional password, LAN invites, conference group chat.",
            "Chats: text, pictures, GIFs, video, files, voice notes, quotes, edit, delete, link previews.",
            "Animated Noto smileys in a picker above the message field.",
            "File transfer on a separate WebRTC DataChannel; drag-and-drop and paste from the clipboard.",
            "Statuses online / away / busy / invisible, auto-away, photo or video avatar with crop.",
            "Screen share: monitors, windows, all screens, computer audio, presenter camera in the corner.",
            "Desktop control: blinking request, the host picks the monitor, mouse and keyboard, full-screen picture, local mouse wins while it moves.",
            "MP4 recording, voice-activated microphone, virtual camera background, full-screen call and a compact dock.",
            "Games in a call or on their own: chess, Russian checkers, sea battle — with a person, a room, or the computer.",
            "Themes, font scale, RU/EN, event sounds, logs folder, installer and portable build.",
          ],
          fixed: [
            "Voice no longer dies a couple of seconds after connect: remote audio is played so echo cancellation does not mute the microphone.",
            "Peers hear each other louder: send-side compression and makeup gain.",
            "Voice-activated microphone opens on speech, keeps the start of a word and the pause between words, and applies during an active call.",
            "The divider between the chat list and the thread lines up with the header.",
          ],
        },
        {
          version: "1.4.0",
          added: [
            "Screen share follows the monitor rate: at least 60 fps and at most 120. The value is shown in Media, under video quality. Resolution matches the screen and the frame is not cropped.",
            "Voice-activated microphone: a sensitivity slider on the Audio tab. Higher opens the mic on a quieter voice. While you are silent, nothing is sent.",
            "Checkers, chess and battleship can be played against the computer: easy, medium and hard.",
            "Camera controls (focus, exposure, brightness and the rest) appear only when the device supports them.",
            "The logs folder and chat history clearing are on the Interface tab.",
          ],
          fixed: [
            "Screen-share video is no longer cropped or dropped. The picture stays close to the original and motion stays smooth.",
            "Voice activation no longer cuts off the start of a word or the pause between words. The slider does not spoil the other person's audio.",
            "The other person hears you at a normal level again. Noise suppression no longer ducks your voice or touches their microphone.",
            "Blur and background replacement hold the outline. The silhouette does not flicker, the room does not leave a rim, and a covered face does not eat into the head.",
            "Autofocus locks on whether the face is visible or covered. The camera no longer stays soft, and the background follows the silhouette.",
          ],
        },
        {
          version: "1.3.0",
          added: [
            "A screenshot, link or GIF is sent as one bubble with the caption.",
            "Messages can be quoted.",
            "Games: a separate “Play with them” button.",
            "Chat previews open on click: pictures, animation, video and VK clips.",
            "Paste stays in the composer until you send.",
            "Recording start and stop are highlighted in chat.",
            "The taskbar button flashes on a message or call event when the window is not focused.",
          ],
          fixed: [
            "Turning the camera off no longer silences the microphone, with or without a screen share that includes audio.",
            "A still image during screen share no longer flickers.",
          ],
        },
        {
          version: "1.2.0",
          added: [
            "Play during a 1:1 call or conference: Russian draughts, chess and battleship on the local channel.",
            "Invite an opponent; other conference participants can spectate.",
            "Resign, draw, rematch, match score; fullscreen board or back to video tiles.",
            "Chess: full rules (castling, en passant, promotion, mate, stalemate, draws).",
            "Russian draughts: flying kings, mandatory captures.",
            "Battleship: 10×10, fog of war, hits and sunk ships.",
          ],
          fixed: [],
        },
        {
          version: "1.1.0",
          added: [
            "Camera tab: crop and pan, virtual background (blur, presets, custom images), manual camera controls.",
            "Record 1:1 calls and conferences to MP4 / AVI.",
            "Outgoing camera quality: Auto / 360p–4K; presenter camera overlay on screen share.",
            "Confirm before leaving a call; cancel an in-progress file transfer.",
          ],
          fixed: ["Black halos around hands and moving objects with a replaced background."],
        },
        {
          version: "1.0.2",
          added: [
            "Windows installer into Program Files with folder choice; running app is closed before copy.",
            "Full RU/EN localization; speaking and status indicators in the LAN list.",
          ],
          fixed: ["“Failed to close LokaMeet” when installing over a running copy."],
        },
        {
          version: "1.0.1",
          added: ["First public release: LAN discovery, direct calls, chat and files with no internet."],
          fixed: [],
        },
      ];

  return ru
    ? {
        heroLead: "Видеосвязь, звонки и чат в локальной сети — без интернета и без облака.",
        engineLine: "Движок: Electron 33 (Chromium), Node.js. Конференции — mediasoup на хосте комнаты.",
        aboutTitle: "Для чего программа",
        aboutBody:
          "LokaMeet 2.0.0 — мессенджер и видеосвязь внутри одной локальной сети (офис, дом, класс). Интернет, облако и аккаунт не нужны. Личные звонки идут напрямую (P2P WebRTC). Конференцию до 15 человек ведёт хост комнаты (mediasoup). Чаты, файлы, голос, экран, управление столом, запись и игры остаются на ваших компьютерах.",
        featuresTitle: "Что уже есть в версии 2.0.0",
        features: [
          "Автопоиск соседей в LAN (mDNS и UDP) и ручное подключение по IP и порту.",
          "Личные чаты и чат комнаты: текст, картинки, GIF, видео, файлы, голосовые, анимированные смайлы, цитаты, правка и удаление.",
          "Превью ссылок (в том числе видеоплощадки), перетаскивание файлов и вставка из буфера.",
          "Файлы идут отдельным WebRTC-каналом. История и файлы лежат на этом компьютере, срок хранения задаётся в настройках.",
          "Профиль: имя, фото или видео‑аватар с кадрированием, статусы онлайн / отошёл / занят / невидимка, авто‑«отошёл».",
          "Журнал входящих, исходящих и пропущенных. Входящий вызов — отдельное окно ответа.",
          "Личный аудио/видеозвонок точка‑точка. Конференция до 15 человек через организатора комнаты.",
          "Микрофон с выбором устройства, усилением, шумо- и эхоподавлением и режимом «по голосу». Хост конференции может выключить чужой микрофон.",
          "Камера: устройство, зеркало, виртуальный фон (размытие, пресеты или своя картинка), ручные параметры если их отдаёт устройство.",
          "Демонстрация: один монитор, окно, все экраны сеткой, звук компьютера; при включённой камере она рисуется в углу кадра экрана.",
          "Управление рабочим столом: мигающий запрос, выбор монитора тем, кем управляют, мышь и клавиатура, полный экран картинки; пока хозяин водит свою мышь — она главная.",
          "Запись сцены и общего звука в MP4, метки в чате, папка записей из настроек.",
          "Игры: шахматы, русские шашки, морской бой — с собеседником, зрителями в комнате или с компьютером (легко / средне / сложно).",
          "Полный экран звонка, свёртка в плашку, чат рядом со сценой, колонка камер, закрепление на сцене, громкость трансляции.",
          "Темы оформления, масштаб шрифта, меньше движения, ширина колонок, RU/EN, звуки событий.",
          "Установщик Windows и portable‑сборка. Журнал запуска — папка logs рядом с программой, текст на английском.",
        ],
        howTitle: "Как это работает",
        howItems: [
          "При запуске приложение объявляет себя в LAN через mDNS (Bonjour) и UDP‑broadcast и поднимает локальный WebSocket.",
          "В разделе «LAN» появляются другие запущенные клиенты в той же сети.",
          "Личный звонок — WebRTC peer‑to‑peer между двумя участниками.",
          "Конференция: хост поднимает mediasoup, участники публикуют микрофон, камеру и экран и подписываются на чужие дорожки (до 15 человек).",
          "Чат и статусы идут по тому же локальному каналу; история хранится на вашем компьютере.",
        ],
        needTitle: "Что нужно для корректной работы",
        needItems: [
          "Все участники в одной локальной сети (один сегмент LAN / Wi‑Fi).",
          "Разрешения Windows на камеру и микрофон для LokaMeet.",
          "В брандмауэре Windows разрешены входящие и исходящие соединения для приложения (частные сети).",
          "Для автообнаружения желателен mDNS. Если он блокируется, сработает UDP‑объявление.",
          "Антивирус не должен резать локальный UDP и WebRTC.",
          "Для демонстрации экрана — доступ к захвату экрана в системе.",
        ],
        softwareTitle: "Какие программы нужны",
        softwareIntro:
          "Для обычного использования LokaMeet почти ничего дополнительно устанавливать не нужно — это самостоятельное приложение.",
        softwareRequiredTitle: "Обязательно",
        softwareRequired: [
          "Windows и сама программа LokaMeet (установщик или portable‑сборка).",
          "Камера и/или микрофон (и разрешения Windows для LokaMeet).",
          "Общая локальная сеть с другими участниками.",
        ],
        softwareOptionalTitle: "Желательно для стабильного автопоиска",
        softwareOptional: [
          "Bonjour Print Services (Apple) — улучшает mDNS‑обнаружение в Windows.",
          "Правила брандмауэра Windows: разрешить LokaMeet в частных сетях.",
        ],
        softwareDevTitle: "Только для сборки из исходников",
        softwareDev: ["Node.js (npm)", "Зависимости проекта через npm install."],
        softwareNotNeededTitle: "Не требуется",
        softwareNotNeeded: "Интернет, Zoom, браузер, отдельный медиа‑сервер или облачный аккаунт — для работы в LAN не нужны.",
        linksTitle: "Полезные ссылки и программы",
        sectionsTitle: "Разделы программы",
        sections: [
          { title: "Чаты", body: "Личные переписки и чаты комнат. Текст, картинки, GIF, видео, файлы, голосовые и анимированные смайлы над полем ввода. Сообщение можно цитировать, править и удалять. Превью ссылок открывается в пузыре. Файлы идут отдельным WebRTC-каналом. История лежит на этом компьютере." },
          { title: "LAN", body: "Живые соседи в сети. Можно написать, позвонить или подключиться вручную по IP и порту, если автопоиск их не показал." },
          { title: "Звонки", body: "Журнал входящих, исходящих и пропущенных. Личный разговор — WebRTC без сервера в интернете: микрофон, камера, демонстрация, управление столом, запись, игры, полный экран и свёртка в плашку." },
          { title: "Комнаты", body: "Временная комната с именем и необязательным паролем. Организатор начинает конференцию до 15 человек. Если он выходит, комната закрывается у всех. Чат комнаты хранит вход, выход и запись." },
          { title: "Управление рабочим столом", body: "В звонке можно запросить мышь и клавиатуру собеседника. Он видит имя, сам выбирает монитор и разрешает или отклоняет. После согласия вы видите ровно этот монитор, и курсор на картинке двигает мышь только на нём. Кнопка «На весь экран» на панели управления разворачивает стол на весь экран. Пока хозяин стола водит свою мышь, она главная. Как только он остановился, удалённое управление продолжается само. Сессия из-за этого не рвётся. Кто бы ни нажал «Остановить управление», демонстрация этого стола сразу выключается." },
          { title: "Запись", body: "Кнопка в звонке пишет картинку сцены и общий звук в MP4. В чате видно, кто включил запись и сколько она длится." },
          { title: "Игры", body: "Шахматы, русские шашки и морской бой: с человеком в звонке, компанией в комнате или с компьютером. Ходы не уходят в интернет." },
          { title: "Настройки", body: "Профиль и статусы, темы и язык, звуки, микрофон и камера, виртуальный фон, папка записей, срок хранения файлов, сложность игр, лицензии сторонних компонентов. Журнал программы пишется в папку logs рядом с программой." },
        ],
        faqTitle: "Частые вопросы",
        faq: [
          { q: "Нужен ли интернет?", a: "Нет. Достаточно общей локальной сети. Облако и учётная запись не используются." },
          { q: "Собеседника нет в списке LAN.", a: "Проверьте, что оба в одной сети и брандмауэр пускает LokaMeet в частных сетях. Если mDNS молчит, подключитесь по IP и порту из шапки его окна." },
          { q: "Звонок есть, а звука нет.", a: "Включите микрофон кнопкой внизу звонка и проверьте устройство в настройках звука. «Микрофон по голосу» молчит, пока вы не говорите." },
          { q: "Я вижу синий курсор, но мышь собеседника не едет.", a: "Синий курсор — ваш указатель на картинке. Настоящая мышь едет по монитору, который собеседник выбрал, когда разрешал управление. Картинка и клики относятся к одному и тому же экрану." },
          { q: "Кто главнее, если оба двигают мышь?", a: "Хозяин компьютера. Пока он водит свою мышь, удалённые движения ждут. Сессия не отключается. Как только его курсор замер, ваш снова двигает его стол." },
          { q: "Когда гаснет демонстрация?", a: "Сразу, когда любой из двоих останавливает управление рабочим столом. Обычную демонстрацию без управления по-прежнему выключает кнопка «Экран»." },
          { q: "Сколько человек в конференции?", a: "До 15, включая организатора. Личный звонок — всегда двое и идёт напрямую." },
          { q: "Где файлы, записи и журнал?", a: "Профиль и чаты — в каталоге данных приложения. Записи — в папке из настроек. Журнал каждого запуска — в logs рядом с программой, на английском." },
        ],
        licensesTitle: "Лицензии сторонних компонентов",
        licensesIntro:
          "Ниже — обязательные уведомления об авторских правах и полные тексты лицензий на языке оригинала. Их нельзя убирать из копий программы.",
        licenseOpen: "Показать полный текст",
        tip: "Если пользователи не видят друг друга: проверьте сеть, брандмауэр и попробуйте ручное подключение по IP и порту во вкладке LAN.",
        addedTitle: "Добавлено",
        fixedTitle: "Исправлено",
        changesHead: (version: string) => `Что нового в ${version}`,
        releases,
      }
    : {
        heroLead: "Video calls and chat on your local network — no internet and no cloud.",
        engineLine: "Runtime: Electron 33 (Chromium), Node.js. Conferences use mediasoup on the room host.",
        aboutTitle: "What the app is for",
        aboutBody:
          "LokaMeet 2.0.0 is a messenger and video app for one local network (office, home, classroom). There is no internet, cloud or account. One-to-one calls are peer-to-peer WebRTC. A conference of up to 15 people is hosted by the room owner (mediasoup). Chats, files, voice, screen, desktop control, recording and games stay on your PCs.",
        featuresTitle: "What version 2.0.0 already includes",
        features: [
          "LAN discovery (mDNS and UDP) and manual connect by IP and port.",
          "Direct chats and room chats: text, pictures, GIFs, video, files, voice notes, animated smileys, quotes, edit and delete.",
          "Link previews (including video hosts), drag-and-drop and paste from the clipboard.",
          "Files use a separate WebRTC channel. History and files stay on this PC; retention is set in Settings.",
          "Profile: name, photo or video avatar with crop, statuses online / away / busy / invisible, auto-away.",
          "Log of incoming, outgoing and missed calls. Incoming calls open a dedicated answer window.",
          "One-to-one audio/video peer-to-peer. Conferences of up to 15 people through the room host.",
          "Microphone: device, gain, noise and echo cancellation, voice activation. The conference host can mute someone else.",
          "Camera: device, mirror, virtual background (blur, presets or your picture), manual controls when the device exposes them.",
          "Screen share: one monitor, a window, all screens in a grid, computer audio; a live camera is drawn in the corner of the shared frame.",
          "Desktop control: blinking request, the host picks the monitor, mouse and keyboard, full-screen picture; while they move their own mouse it stays in front.",
          "MP4 recording of the stage and mixed audio, chat marks, recordings folder from Settings.",
          "Games: chess, Russian checkers, sea battle — with a person, room spectators, or the computer (easy / medium / hard).",
          "Full-screen call, compact dock, in-call chat, camera rail, pin to stage, share volume.",
          "Themes, font scale, reduced motion, column widths, RU/EN, event sounds.",
          "Windows installer and portable build. Each launch writes an English log in the logs folder next to the program.",
        ],
        howTitle: "How it works",
        howItems: [
          "On start the app announces itself on the LAN via mDNS (Bonjour) and UDP broadcast and opens a local WebSocket.",
          "Other running clients on the same network appear under LAN.",
          "A direct call is a WebRTC peer-to-peer session between two people.",
          "A conference: the host runs mediasoup; others publish mic, camera and screen and subscribe (up to 15 people).",
          "Chat and status use the same local channel; history is stored on your PC.",
        ],
        needTitle: "What you need for reliable operation",
        needItems: [
          "Everyone on the same local network segment (LAN / Wi‑Fi).",
          "Camera and microphone permissions for LokaMeet in Windows.",
          "Windows Firewall allowing the app on private networks.",
          "mDNS helps discovery; if blocked, UDP announce is used.",
          "Security software must not block local UDP/WebRTC traffic.",
          "Screen capture permission for screen sharing.",
        ],
        softwareTitle: "What software do you need",
        softwareIntro: "For normal use you barely need anything else — LokaMeet is a standalone app.",
        softwareRequiredTitle: "Required",
        softwareRequired: [
          "Windows and LokaMeet itself (installer or portable build).",
          "Camera and/or microphone (plus Windows permissions for LokaMeet).",
          "A shared local network with the other participants.",
        ],
        softwareOptionalTitle: "Recommended for stable discovery",
        softwareOptional: [
          "Bonjour Print Services (Apple) — improves mDNS discovery on Windows.",
          "Windows Firewall rules allowing LokaMeet on private networks.",
        ],
        softwareDevTitle: "Only when building from source",
        softwareDev: ["Node.js (npm)", "Project dependencies via npm install."],
        softwareNotNeededTitle: "Not required",
        softwareNotNeeded: "Internet, Zoom, a browser, a separate media server, or a cloud account are not needed for LAN calls.",
        linksTitle: "Useful links & software",
        sectionsTitle: "Sections",
        sections: [
          { title: "Chats", body: "Direct threads and room threads. Text, pictures, GIFs, video, files, voice notes and animated smileys above the composer. Quote, edit and delete. Link previews open in the bubble. Files use their own WebRTC channel. History stays on this PC." },
          { title: "LAN", body: "People currently on the network. Message them, call them, or connect by IP and port when discovery does not list them." },
          { title: "Calls", body: "Missed, outgoing and incoming history. A live call is one-to-one WebRTC with no internet server: microphone, camera, screen, desktop control, recording, games, full screen and a compact dock." },
          { title: "Rooms", body: "A temporary room with a name and optional password. The host starts a conference of up to 15 people. When the host leaves, the room closes for everyone." },
          { title: "Desktop control", body: "During a call you can ask for the other person's mouse and keyboard. They see your name, choose which monitor to share, and accept or deny. On accept you see exactly that monitor, and the pointer on the picture moves the real mouse only there. Full screen on the control bar fills the display with that desktop. While they move their own mouse, it stays in front. The session does not end. As soon as their cursor stops, yours drives the desktop again. Whoever stops control also stops that screen share immediately." },
          { title: "Recording", body: "The call button writes the stage picture and the mixed audio to MP4. The chat shows who is recording and for how long." },
          { title: "Games", body: "Chess, Russian checkers and sea battle: with the person on the call, with the room, or against the computer. Moves stay on the LAN." },
          { title: "Settings", body: "Profile and status, themes and language, sounds, microphone and camera, virtual background, recordings folder, file retention, game difficulty, third-party licenses. Each launch writes an English log under logs next to the program." },
        ],
        faqTitle: "FAQ",
        faq: [
          { q: "Do I need the internet?", a: "No. A shared local network is enough. There is no cloud account." },
          { q: "Someone is missing from LAN.", a: "Both PCs must be on the same network, and the firewall must allow LokaMeet on private networks. If mDNS is blocked, connect by the IP and port shown in their window." },
          { q: "The call connects but there is no audio.", a: "Turn the microphone on with the call button and check the device in sound settings. Voice activation stays quiet until you speak." },
          { q: "I see a blue cursor, but their mouse does not move.", a: "The blue cursor is your pointer on the picture. The real mouse moves on the monitor they picked when they allowed control. The picture and the clicks are the same screen." },
          { q: "Whose mouse wins?", a: "The person sitting at that computer. While they move it, remote moves wait. Control stays on. When their cursor stops, yours moves the desktop again." },
          { q: "When does the screen share stop?", a: "As soon as either person stops desktop control. A normal share without control still stops from the Screen button." },
          { q: "How many people fit in a conference?", a: "Up to 15, including the host. A direct call is always two people and stays peer-to-peer." },
          { q: "Where are files, recordings and logs?", a: "Profile and chats live in the app data folder. Recordings use the folder from settings. Each launch writes an English log in the logs folder next to the program." },
        ],
        licensesTitle: "Third-party licenses",
        licensesIntro:
          "The copyright notices and full original license texts below must stay with copies of this program.",
        licenseOpen: "Show full license text",
        tip: "If peers do not appear: check the network and firewall, then try manual connect by IP/port on the LAN tab.",
        addedTitle: "Added",
        fixedTitle: "Fixed",
        changesHead: (version: string) => `What's new in ${version}`,
        releases,
      };
}

export function AboutPanel({ locale }: { locale: "ru" | "en" }) {
  const ru = locale !== "en";
  const copy = copyFor(ru);
  const open = (url: string) => void api.invoke("openExternal", { url });
  const links = [
    {
      title: "GitHub",
      desc: ru ? "Исходный код и страница проекта LokaMeet." : "Source code and the LokaMeet project page.",
      url: APP_REPO,
    },
    {
      title: ru ? "Bonjour Print Services (Windows)" : "Bonjour Print Services (Windows)",
      desc: ru ? "Рекомендуется для надёжного mDNS‑обнаружения в LAN." : "Recommended for reliable mDNS discovery on the LAN.",
      url: "https://support.apple.com/kb/DL999",
    },
    {
      title: ru ? "Брандмауэр Windows" : "Windows Firewall",
      desc: ru ? "Разрешите LokaMeet для частных сетей." : "Allow LokaMeet on private networks.",
      url: "https://support.microsoft.com/windows/firewall-and-network-protection-in-the-windows-security-app-ec0844f7-aebd-0583-67fe-601ecf5d774f",
    },
    {
      title: ru ? "Node.js (только для разработки)" : "Node.js (development only)",
      desc: ru ? "Нужен, если собираете LokaMeet из исходников." : "Needed only if you build LokaMeet from source.",
      url: "https://nodejs.org/",
    },
    {
      title: "WebRTC",
      desc: ru ? "Технология P2P‑аудио/видео, на которой построены звонки." : "The P2P audio/video technology behind the calls.",
      url: "https://webrtc.org/",
    },
    {
      title: "Electron",
      desc: ru ? "Движок десктоп‑приложения." : "Desktop runtime.",
      url: "https://www.electronjs.org/",
    },
  ];

  return (
    <div className="helpPanel">
      <div className="helpHero">
        <div className="helpHeroTitleRow">
          <button type="button" className="logo-link" onClick={() => open(APP_REPO)}>
            <img className="logo helpHeroLogo" src={logoUrl} alt="" />
          </button>
          <div className="helpHeroTitle">LokaMeet</div>
          <span className="appVersionBadge">v{APP_VERSION}</span>
        </div>
        <p className="helpHeroLead">{copy.heroLead}</p>
        <p className="helpHeroLead">{copy.engineLine}</p>
      </div>

      {copy.releases.map((release) => (
        <section key={release.version} className="helpSection">
          <h3>{copy.changesHead(release.version)}</h3>
          {release.added.length > 0 && (
            <>
              <p><b>{copy.addedTitle}</b></p>
              <ul className="helpList">
                {release.added.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </>
          )}
          {release.fixed.length > 0 && (
            <>
              <p><b>{copy.fixedTitle}</b></p>
              <ul className="helpList">
                {release.fixed.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </>
          )}
        </section>
      ))}

      <section className="helpSection">
        <h3>{copy.aboutTitle}</h3>
        <p>{copy.aboutBody}</p>
      </section>
      <section className="helpSection">
        <h3>{copy.featuresTitle}</h3>
        <ul className="helpList">{copy.features.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
      <section className="helpSection">
        <h3>{copy.howTitle}</h3>
        <ul className="helpList">{copy.howItems.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
      <section className="helpSection">
        <h3>{copy.sectionsTitle}</h3>
        {copy.sections.map((item) => (
          <p key={item.title}><b>{item.title}.</b> {item.body}</p>
        ))}
      </section>
      <section className="helpSection">
        <h3>{copy.faqTitle}</h3>
        {copy.faq.map((item) => (
          <p key={item.q}><b>{item.q}</b> {item.a}</p>
        ))}
      </section>
      <section className="helpSection">
        <h3>{copy.needTitle}</h3>
        <ul className="helpList">{copy.needItems.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
      <section className="helpSection helpSoftware">
        <h3>{copy.softwareTitle}</h3>
        <p>{copy.softwareIntro}</p>
        <div className="helpSoftGrid">
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareRequiredTitle}</div>
            <ul className="helpList">{copy.softwareRequired.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareOptionalTitle}</div>
            <ul className="helpList">{copy.softwareOptional.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="helpSoftCard">
            <div className="helpSoftCardTitle">{copy.softwareDevTitle}</div>
            <ul className="helpList">{copy.softwareDev.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
        <div className="helpSoftNote">{copy.softwareNotNeededTitle}: {copy.softwareNotNeeded}</div>
      </section>
      <section className="helpSection">
        <h3>{copy.linksTitle}</h3>
        <div className="helpLinks">
          {links.map((link) => (
            <button key={link.url} type="button" className="helpLinkCard" onClick={() => open(link.url)} title={link.url}>
              <span className="helpLinkTitle">{link.title}</span>
              <span className="helpLinkDesc">{link.desc}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="helpSection licenses-block">
        <h3>{copy.licensesTitle}</h3>
        <p>{copy.licensesIntro}</p>
        {THIRD_PARTY_LICENSES.map((item) => (
          <details key={item.id} className="license-card">
            <summary>
              <span className="license-name">{item.title}</span>
              <span className="license-spdx">{item.spdx}</span>
              <span className="license-use">{ru ? item.useRu : item.useEn}</span>
            </summary>
            <p className="license-notice">{item.notice}</p>
            <button type="button" className="helpLinkTitle license-url" onClick={() => open(item.url)}>{item.url}</button>
            <p className="hint">{copy.licenseOpen}</p>
            <pre className="license-text">{item.text}</pre>
          </details>
        ))}
      </section>
      <div className="helpTip">{copy.tip}</div>
    </div>
  );
}
