// Minimal multipart/form-data parser: one file part plus optional text fields.
// Archive uploads are the only multipart traffic comb accepts, so pulling in a
// parser dependency for it would be more code than this.

export interface ParsedUpload {
  fields: Record<string, string>;
  file: { filename: string; data: Buffer } | null;
}

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

function boundaryOf(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) throw new Error('multipart boundary missing');
  return boundary;
}

export function parseMultipart(body: Buffer, contentType: string): ParsedUpload {
  const boundary = boundaryOf(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  const result: ParsedUpload = { fields: {}, file: null };

  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new Error('multipart body has no boundary');
  cursor += delimiter.length;

  while (cursor < body.length) {
    // Closing delimiter is followed by "--".
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    if (body.subarray(cursor, cursor + 2).equals(CRLF)) cursor += 2;

    const headerEnd = body.indexOf(HEADER_END, cursor);
    if (headerEnd < 0) break;
    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const contentStart = headerEnd + HEADER_END.length;
    const next = body.indexOf(delimiter, contentStart);
    if (next < 0) break;
    // The CRLF before the next delimiter belongs to the delimiter.
    const contentEnd = next >= 2 && body.subarray(next - 2, next).equals(CRLF) ? next - 2 : next;
    const content = body.subarray(contentStart, contentEnd);

    const disposition = /content-disposition:([^\r\n]+)/i.exec(headers)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    if (filename) {
      result.file = { filename: filename || 'archive.zip', data: Buffer.from(content) };
    } else if (name) {
      result.fields[name] = content.toString('utf8');
    }

    cursor = next + delimiter.length;
  }
  return result;
}
