import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function Composer({ onSend, busy }: { onSend: (text: string, files: File[]) => Promise<void>; busy: boolean }) {
    const [text, setText] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    const [error, setError] = useState<string>();
    const [dragging, setDragging] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);

    // Grow with the text up to a third of the screen.
    useEffect(() => {
        const element = area.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, window.innerHeight / 3)}px`;
    }, [text]);

    const add = (incoming: Iterable<File>) => {
        const next = [...files, ...incoming];
        const tooBig = next.find((file) => file.size > MAX_FILE_BYTES);
        if (tooBig) return setError(`${tooBig.name} is over 25 MB`);
        if (next.length > MAX_FILES) return setError(`at most ${MAX_FILES} files per message`);
        setError(undefined);
        setFiles(next);
    };

    // Files dropped anywhere on the page attach to the next message.
    useEffect(() => {
        const over = (event: DragEvent) => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
        };
        const leave = (event: DragEvent) => {
            if (event.relatedTarget === null) setDragging(false);
        };
        const drop = (event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer?.files.length) add(event.dataTransfer.files);
        };
        window.addEventListener("dragover", over);
        window.addEventListener("dragleave", leave);
        window.addEventListener("drop", drop);
        return () => {
            window.removeEventListener("dragover", over);
            window.removeEventListener("dragleave", leave);
            window.removeEventListener("drop", drop);
        };
    });

    const submit = async () => {
        const message = text.trim();
        if (!message && files.length === 0) return;
        setText("");
        setFiles([]);
        await onSend(message, files);
        area.current?.focus();
    };

    const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
        }
    };

    return (
        <form
            className={`composer${dragging ? " composer-drop" : ""}`}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            {(files.length > 0 || error) && (
                <div className="composer-files">
                    {files.map((file, index) => (
                        <span key={`${file.name}${index}`} className="chip chip-removable">
                            {file.name}
                            <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                onClick={() => setFiles(files.filter((_, at) => at !== index))}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                    {error && <span className="composer-error">{error}</span>}
                </div>
            )}
            <div className="composer-row">
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Attach files"
                    onClick={() => picker.current?.click()}
                >
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M13.5 6.5 7.8 12.2a1.6 1.6 0 0 0 2.3 2.3l6-6a3.2 3.2 0 0 0-4.6-4.6l-6 6a4.8 4.8 0 0 0 6.8 6.8l5.2-5.2" />
                    </svg>
                </button>
                <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                        if (event.target.files) add(event.target.files);
                        event.target.value = "";
                    }}
                />
                <textarea
                    ref={area}
                    rows={1}
                    value={text}
                    placeholder={
                        busy
                            ? "Steer the run, it reads this after the current step"
                            : "Give it a task. /reset, /schedules, /help"
                    }
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={onKey}
                    onPaste={(event) => {
                        if (event.clipboardData.files.length > 0) {
                            event.preventDefault();
                            add(event.clipboardData.files);
                        }
                    }}
                    aria-label="Message"
                />
                <button type="submit" className="send" disabled={!text.trim() && files.length === 0}>
                    {busy ? "steer" : "send"}
                </button>
            </div>
        </form>
    );
}
