import type { StoredFile } from "@eien/web/protocol";
import { useEffect, useState } from "react";
import { api, fileUrl } from "../api.ts";

export function FilesPanel({ onClose }: { onClose: () => void }) {
    const [files, setFiles] = useState<StoredFile[]>();

    useEffect(() => {
        void api.files().then(setFiles, () => setFiles([]));
        const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
        window.addEventListener("keydown", escape);
        return () => window.removeEventListener("keydown", escape);
    }, [onClose]);

    return (
        <aside className="files-panel" aria-label="Files from the agent">
            <header>
                <h2>Files</h2>
                <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
                    ×
                </button>
            </header>
            {files === undefined && <p className="muted">loading</p>}
            {files?.length === 0 && <p className="muted">Nothing yet. Files the agent sends land here.</p>}
            <ul>
                {files?.map((file) => (
                    <li key={file.id}>
                        <a href={fileUrl(file)} download>
                            {file.name}
                        </a>
                        <span>{new Date(file.at).toLocaleString()}</span>
                    </li>
                ))}
            </ul>
        </aside>
    );
}
