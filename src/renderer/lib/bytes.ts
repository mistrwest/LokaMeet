/** ArrayBuffer/Uint8Array → base64, без spread всего буфера (иначе падает на больших кусках). */
export function bufferToBase64(data: ArrayBuffer | Uint8Array): string {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}
