import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeAssistantMarkdown } from '../../lib/assistantMarkdown';

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-result-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
        }}
      >
        {normalizeAssistantMarkdown(children)}
      </Markdown>
    </div>
  );
}
