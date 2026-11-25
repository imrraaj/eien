import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "props" in node) {
        return textOf((node as { props: { children?: ReactNode } }).props.children);
    }
    return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
    const [copied, setCopied] = useState(false);
    const code = children as { props?: { className?: string; children?: ReactNode } } | undefined;
    const language = /language-([\w-]+)/.exec(code?.props?.className ?? "")?.[1];
    const copy = async () => {
        await navigator.clipboard.writeText(textOf(code?.props?.children).replace(/\n$/, ""));
        setCopied(true);
        setTimeout(() => setCopied(false), 1_200);
    };
    return (
        <div className="codeblock">
            <div className="codeblock-bar">
                <span>{language ?? "text"}</span>
                <button type="button" onClick={copy} aria-label="Copy code">
                    {copied ? "copied" : "copy"}
                </button>
            </div>
            <pre>{children}</pre>
        </div>
    );
}

const components: Components = {
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
        </a>
    ),
    table: ({ children }) => (
        <div className="table-scroll">
            <table>{children}</table>
        </div>
    ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
    return (
        <div className="prose">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: false }]]}
                components={components}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
});
