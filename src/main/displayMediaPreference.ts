/** Хранит выбранный источник до следующего запроса getDisplayMedia, чтобы системный picker открыл нужный экран или окно. */
let preferredDisplayMediaSourceId: string | null = null;

export function setPreferredDisplayMediaSourceId(id: string | null) {
  preferredDisplayMediaSourceId = id;
}

export function getPreferredDisplayMediaSourceId() {
  return preferredDisplayMediaSourceId;
}
