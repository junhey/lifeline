import MarkdownIt from 'markdown-it';

/**
 * Assistant message rendering: markdown-it, html:false (same as production; inline HTML is off to block injection).
 * Custom fence: language tag + copy-button placeholder (copy is taken over after MarkdownView mounts).
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

type RenderRule = NonNullable<typeof md.renderer.rules.fence>;

const defaultFence: RenderRule | undefined = md.renderer.rules.fence;

const fenceWithToolbar: RenderRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim().split(/\s+/)[0] || '';
  const inner = defaultFence
    ? defaultFence(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return (
    `<div class="md-codeblock">`
    + `<div class="md-codeblock-bar">`
    + `<span class="md-codeblock-lang">${lang || 'text'}</span>`
    + `<span class="md-codeblock-actions">`
    + `<button type="button" class="md-codeblock-expand">全屏</button>`
    + `<button type="button" class="md-codeblock-copy">复制</button>`
    + `</span>`
    + `</div>${
      inner
    }</div>`
  );
};

md.renderer.rules.fence = fenceWithToolbar;

/**
 * Table gets a scroll box of its own (`.md-table-wrap` in tokens.css): a table wider than the column must scroll
 * inside itself — left on its own it widens the transcript's scrollable width, which on the phone turns the session
 * into a two-axis scroller (hold and drag pans it sideways).
 */
const tableWrapOpen: RenderRule = (tokens, idx, options, _env, self) =>
  `<div class="md-table-wrap">${self.renderToken(tokens, idx, options)}`;

const tableWrapClose: RenderRule = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

md.renderer.rules.table_open = tableWrapOpen;
md.renderer.rules.table_close = tableWrapClose;

export function renderMarkdown(text: string): string {
  return md.render(text ?? '');
}
