export async function readBoundedJson(request: Request, limitBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > limitBytes) throw new Error("Request body too large");
    return JSON.parse(text || "null");
  }
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const text = buf.toString("utf8");
  return JSON.parse(text || "null");
}
