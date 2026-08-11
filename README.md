# LokaMeet

Десктоп‑приложение для видеосвязи в **локальной сети без интернета** (LAN‑only). Медиа идёт через WebRTC (P2P), сигналинг — по локальным WebSocket.

![Интерфейс LokaMeet](https://raw.githubusercontent.com/mistrwest/LokaMeet/main/img1.PNG)

## Что нового в 1.0.2

- **Установщик Windows:** установка по умолчанию в `C:\Program Files` с сохранением выбора папки; перед копированием файлов приложение принудительно закрывается (исправлена ошибка «Не удалось закрыть LokaMeet»).
- **Старт:** в диалоге имени «Отмена» и × завершают программу.
- **Локализация:** при переключении RU/EN переводится весь интерфейс (меню, настройки, чат, статусы).
- **Индикаторы речи:** ярче кольцо вокруг аватара и маркер у ника в звонке.
- **Статусы в списке LAN:** цветная рамка вокруг аватара (онлайн / отошёл / в звонке / конференция / не беспокоить / офлайн); бейджи «В звонке» и «На конференции» читаемее на тёмных темах.

## Возможности

### Сеть и обнаружение

- Работа без интернета (LAN‑only)
- Каждый клиент поднимает свой signaling‑сервер и может быть хостом комнаты
- Автообнаружение пользователей: mDNS/Bonjour + UDP‑broadcast (фолбэк)
- Ручное подключение по IP/порту
- Список пользователей и комнат обновляется в реальном времени

### Звонки и конференции

- Индивидуальные аудио/видеозвонки (WebRTC)
- Групповые конференции (mesh P2P)
- Вкл/выкл микрофона и камеры
- Выбор качества видео: low / medium / high
- Демонстрация экрана
- Таймер длительности звонка

### Чат

- Приватный чат между двумя пользователями
- Групповой чат в конференции
- Локальная история сообщений
- Поиск по сообщениям
- Смайлы (вставка в поле ввода)
- Передача файлов через WebRTC DataChannel
- Предпросмотр изображений и видео
- Подсветка непрочитанных чатов
- Звуковые уведомления (переключатель, громкость, файлы событий)

### Статусы

- Статусы: online / away / dnd / offline / in_call / in_conference
- Цветовые индикаторы в списке пользователей
- Авто‑переключение на `in_call` / `in_conference` во время звонка

### Интерфейс

- 9 тем оформления (светлые и тёмные)
- Локализация RU / EN
- Настройки: высота чата, ширина сайдбара, масштаб текста, компактный режим, секунды в часах, автопереход в чат при звонке, автопрокрутка, размер смайлов, лимит отображаемых сообщений

### Диагностика

- Подробные логи main и renderer (сеть, WebRTC)
- Обработка `uncaughtException` / `unhandledRejection`

## Быстрый старт (Windows)

Требования: [Node.js](https://nodejs.org/) (LTS).

```powershell
npm install
npm run dev
```

## Два экземпляра на одной машине

Полезно для локальной проверки звонков и чата.

**Окно 1**

```powershell
$env:LOKAMEET_PROFILE="A"
npm run dev
```

**Окно 2**

```powershell
$env:LOKAMEET_PROFILE="B"
npm run dev
```

Или через bat‑файлы:

| Файл | Назначение |
|------|------------|
| `build_app.bat` | Сборка |
| `run_app.bat` | Запуск (профиль A) |
| `run_app_2.bat` | Запуск (профиль B) |
| `run_two_instances.bat` | Два экземпляра сразу |

Данные профилей хранятся отдельно: `%AppData%\LokaMeet-A` и `%AppData%\LokaMeet-B` (обычный запуск — `%AppData%\LokaMeet`).

## Сборка

```powershell
npm run dist
```

или `build_app.bat`.

В `release/` появятся:

| Файл | Описание |
|------|----------|
| `LokaMeet-Setup-*.exe` | Полноценный NSIS‑установщик: выбор папки, описание, ярлыки, лицензия |
| `LokaMeet-Portable-*.exe` | Portable‑сборка без установки |

Для иконки установщика нужен `build/icon.png`.

## Сеть и firewall

Если пользователи или комнаты не обнаруживаются:

- Разрешите локальный трафик в Windows Firewall для приложения
- mDNS использует **UDP 5353**; есть UDP‑фолбэк на порт **45454**
- Устройства должны быть в **одной подсети**

## Стек и библиотеки

| Слой | Технологии |
|------|------------|
| Desktop | [Electron](https://www.electronjs.org/) |
| UI | [React](https://react.dev/) · [TypeScript](https://www.typescriptlang.org/) |
| Медиа | WebRTC (встроенный) |
| Сигналинг | [ws](https://github.com/websockets/ws) (WebSocket) |
| Discovery | [bonjour-service](https://github.com/onlxltd/bonjour-service) (mDNS) + UDP‑broadcast |
| i18n | [i18next](https://www.i18next.com/) · [react-i18next](https://react.i18next.com/) |
| Сборка | [Vite](https://vitejs.dev/) · [electron-builder](https://www.electron.build/) |

### Runtime (`dependencies`)

| Пакет | Назначение |
|-------|------------|
| [`react`](https://www.npmjs.com/package/react) / [`react-dom`](https://www.npmjs.com/package/react-dom) | Интерфейс |
| [`i18next`](https://www.npmjs.com/package/i18next) / [`react-i18next`](https://www.npmjs.com/package/react-i18next) | Локализация RU / EN |
| [`ws`](https://www.npmjs.com/package/ws) | Локальный signaling‑сервер |
| [`bonjour-service`](https://www.npmjs.com/package/bonjour-service) | Автообнаружение в LAN (mDNS) |
| [`uuid`](https://www.npmjs.com/package/uuid) | Идентификаторы peer / room |

### Development (`devDependencies`)

| Пакет | Назначение |
|-------|------------|
| [`electron`](https://www.npmjs.com/package/electron) | Оболочка десктоп‑приложения |
| [`typescript`](https://www.npmjs.com/package/typescript) + `@types/*` | Компиляция и типы |
| [`vite`](https://www.npmjs.com/package/vite) / [`@vitejs/plugin-react`](https://www.npmjs.com/package/@vitejs/plugin-react) | Dev‑сервер и сборка renderer |
| [`electron-builder`](https://www.npmjs.com/package/electron-builder) | Установщик / portable |
| [`concurrently`](https://www.npmjs.com/package/concurrently) / [`cross-env`](https://www.npmjs.com/package/cross-env) | Скрипты разработки |

Полный список версий — в [`package.json`](package.json).

## Лицензия

Исходный код распространяется на условиях [LokaMeet License](LICENSE) (на основе MIT) с **обязательной атрибуцией**:

- проект: https://github.com/mistrwest/LokaMeet  
- автор: [mistrwest](https://github.com/mistrwest)  

При использовании, форке или распространении эти ссылки и указание автора удалять нельзя.
