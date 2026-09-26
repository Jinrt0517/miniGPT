/* Parse math before Markdown consumes TeX escapes, then typeset after sanitizing. */
import './vendor/marked.umd.js';
import './vendor/purify.min.js';
import './vendor/katex/katex.min.js';
import markedCjkFriendly from './vendor/marked-cjk-friendly.js';

(() => {
  'use strict';
  const delimiters = [
    { open: '$$', close: '$$', display: true },
    { open: '\\[', close: '\\]', display: true },
    { open: '\\(', close: '\\)', display: false },
    { open: '$', close: '$', display: false },
  ];

  function readMath(source, block = false) {
    for (const delimiter of delimiters) {
      const { open, close, display } = delimiter;
      if ((block && !display) || !source.startsWith(open)) continue;
      const singleDollar = open === '$';
      if (singleDollar && (source.startsWith('$$') || /\s/.test(source[1] || ''))) continue;
      let braces = 0;
      for (let index = open.length; index < source.length; index++) {
        if (source.startsWith(close, index) && braces <= 0) {
          const end = index + close.length;
          // Avoid interpreting ordinary prices such as "$5 and $10" as math.
          if (singleDollar && (/\s/.test(source[index - 1]) || /[\d$]/.test(source[end] || ''))) return;
          const text = source.slice(open.length, index);
          if (!text.trim() || (singleDollar && text.includes('\n'))) return;
          if (block && !/^(?:[ \t]*(?:\n|$))/.test(source.slice(end))) return;
          return { type: block ? 'blockMath' : 'inlineMath', raw: source.slice(0, end), text, display };
        }
        if (source[index] === '\\') { index++; continue; }
        if (source[index] === '{') braces++;
        else if (source[index] === '}') braces--;
      }
      // An incomplete $$ expression must never be reinterpreted as $...$.
      return;
    }
  }

  function createRenderer() {
    const { marked, DOMPurify, katex } = window;
    if (!marked?.Marked || !DOMPurify?.isSupported || !katex?.render) {
      throw new Error('消息渲染资源缺失，请重新构建应用资源。');
    }
    let expressions = [];
    const placeholder = token => {
      const index = expressions.push(token) - 1;
      return `<${token.type === 'blockMath' ? 'div' : 'span'} data-mini-math="${index}"></${token.type === 'blockMath' ? 'div' : 'span'}>`;
    };
    // Marked 16 already handles GFM strikethrough. The extension's newer `del`
    // tokenizer requires Marked internals that are absent in this pinned major.
    const cjk = { tokenizer: { emStrong: markedCjkFriendly().tokenizer.emStrong } };
    const parser = new marked.Marked({ breaks: true, gfm: true, async: false }, cjk, {
      extensions: [
        { name: 'blockMath', level: 'block',
          start: source => source.match(/(?:^|\n)(?:\$\$|\\\[)/)?.index,
          tokenizer: source => readMath(source, true), renderer: placeholder },
        { name: 'inlineMath', level: 'inline',
          start: source => source.search(/\$|\\[([]/),
          tokenizer: source => readMath(source), renderer: placeholder },
      ],
      renderer: {
        checkbox({ checked }) {
          return `<span class="task-checkbox" role="img" aria-label="${checked ? '已完成' : '未完成'}">${checked ? '☑' : '☐'}</span> `;
        },
      },
    });
    return (element, text) => {
      expressions = [];
      const html = parser.parse(text);
      element.innerHTML = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's',
          'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
          'a', 'span', 'div', 'sup', 'sub', 'kbd', 'input'],
        ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'role', 'type', 'checked', 'disabled'],
        ADD_ATTR: ['data-mini-math'],
        ALLOW_DATA_ATTR: false,
        FORBID_ATTR: ['style', 'id', 'name'],
      });
      // GFM's loose task lists may generate checkbox inputs internally.
      for (const input of element.querySelectorAll('input')) {
        if (input.getAttribute('type') !== 'checkbox') { input.remove(); continue; }
        const checkbox = document.createElement('span');
        checkbox.className = 'task-checkbox';
        checkbox.setAttribute('role', 'img');
        checkbox.setAttribute('aria-label', input.checked ? '已完成' : '未完成');
        checkbox.textContent = input.checked ? '☑' : '☐';
        input.replaceWith(checkbox);
      }
      for (const slot of element.querySelectorAll('[data-mini-math]')) {
        const expression = expressions[Number(slot.getAttribute('data-mini-math'))];
        slot.removeAttribute('data-mini-math');
        if (!expression) continue;
        slot.className = expression.display ? 'math-display' : 'math-inline';
        try {
          // Only KaTeX-generated markup may carry inline layout styles. Raw
          // message HTML was cleaned above; TeX cannot load URLs or HTML.
          katex.render(expression.text, slot, {
            displayMode: expression.display, throwOnError: true, trust: false,
            strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml',
          });
        } catch {
          slot.className += ' math-fallback';
          slot.textContent = expression.raw;
        }
      }
      for (const pre of element.querySelectorAll('pre')) {
        const code = pre.querySelector('code');
        if (!code) continue;
        const block = document.createElement('div'); block.className = 'code-block';
        const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
        const language = document.createElement('span');
        language.textContent = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || '代码';
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'code-copy';
        copy.textContent = '复制代码'; copy.setAttribute('aria-label', '复制代码');
        toolbar.append(language, copy); pre.replaceWith(block); block.append(toolbar, pre);
      }
    };
  }

  let renderer;
  window.renderMessageMarkdown = (element, text) => {
    element.classList.remove('plain-text');
    try {
      renderer ||= createRenderer();
      renderer(element, text || '');
    } catch (error) {
      console.error('Message rendering failed:', error);
      element.classList.add('plain-text');
      element.textContent = text || '';
    }
  };
})();
