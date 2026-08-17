"use client";
export function BackupControls() {
  return (
    <div className="flex gap-3">
      <a href="/api/backup/export" className="btn-secondary text-sm">
        Download complete backup (v2)
      </a>
      <label className="btn-secondary text-sm cursor-pointer">
        Import complete backup
        <input
          type="file"
          accept=".json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            const csrf =
              document.cookie.match(/valmont_csrf=([^;]+)/)?.[1] || "";
            await fetch("/api/backup/import", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-valmont-csrf": csrf,
              },
              body: text,
            });
            alert("Import finished");
          }}
        />
      </label>
    </div>
  );
}
