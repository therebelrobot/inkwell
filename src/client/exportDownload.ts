/**
 * Downloads an export. On iPad (especially as a Home Screen app, where plain
 * attachment downloads are unreliable) it hands the file to the share sheet,
 * which offers "Save to Files"; elsewhere it uses a normal download.
 */
export async function downloadExport(exportUrl: string, fallbackFileName: string): Promise<void> {
  const response = await fetch(exportUrl, { credentials: "same-origin" });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error ?? `Export failed (${response.status})`);
  }
  const dispositionFileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1];
  const exportFileName = dispositionFileName ?? fallbackFileName;
  const exportBlob = await response.blob();
  const exportFile = new File([exportBlob], exportFileName, { type: exportBlob.type });

  const prefersShareSheet = navigator.maxTouchPoints > 1 && typeof navigator.canShare === "function" && navigator.canShare({ files: [exportFile] });
  if (prefersShareSheet) {
    try {
      await navigator.share({ files: [exportFile], title: exportFileName });
      return;
    } catch (shareFailure) {
      if (shareFailure instanceof DOMException && shareFailure.name === "AbortError") return; // closed the sheet
    }
  }

  const objectUrl = URL.createObjectURL(exportBlob);
  const temporaryLink = document.createElement("a");
  temporaryLink.href = objectUrl;
  temporaryLink.download = exportFileName;
  document.body.append(temporaryLink);
  temporaryLink.click();
  temporaryLink.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
