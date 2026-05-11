// Upload a single file (or Blob with a filename) to the notes app's attachment
// store. Returns the URL the server assigns. Optional `name` makes the server
// use that as the filename stem instead of a random UUID — used by the
// handwrite flow to share a UUID across PNG + SVG sidecars.

export async function uploadFile(
  file: File | Blob,
  ext: string,
  name?: string,
): Promise<string> {
  const params = new URLSearchParams({ ext });
  if (name) params.set("name", name);
  const res = await fetch(`/api/upload?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type":
        file.type || (ext === "svg" ? "image/svg+xml" : "application/octet-stream"),
    },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const data = (await res.json()) as { url: string };
  return data.url;
}

// Convenience wrapper for File objects (e.g. BlockNote drag-drop uploads):
// pulls the extension from the file's name.
export async function uploadBlockNoteFile(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
  return uploadFile(file, ext);
}
