'use strict';

const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const testRoot = path.join(root, '.test-data', 'rendering');
  fs.mkdirSync(testRoot, { recursive: true });
  const testDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
  const env = { ...process.env, MINIGPT_DATA_DIR: testDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'tests/fixtures/rendering.cjs')], env });
  const errors = [];
  try {
    const page = await electron.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#model-select').value === 'test-model');
    const content = page.locator('.message-assistant .message-content');
    async function show(text, user = '请解释 **Markdown** 与 $x^2$。', status = 'complete') {
      await electron.evaluate((_electron, { text, user, status }) => {
        const check = globalThis.__renderCheck;
        check.conversation = { id: 'render-conversation', title: '渲染检查', status, model: 'test-model', effort: 'low', updatedAt: new Date().toISOString(),
          messages: [{ id: 'user', role: 'user', content: user, status: 'complete' }, { id: 'assistant', role: 'assistant', content: text, status }] };
        check.emit({ type: status === 'complete' ? 'complete' : 'conversation', conversation: check.conversation });
      }, { text, user, status });
      await content.waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    const markdown = '# 渲染检查\n\n## 基本格式\n\n**加粗**、*斜体*、~~删除线~~、[链接](https://example.com)。\n换行。\n\n> 引用\n\n1. 第一项\n2. 第二项\n   - 嵌套项\n\n- [x] 完成\n- [ ] 待办\n\n| 名称 | 数值 |\n| --- | --- |\n| 测试 | $x_1$ |\n\n`$not_math$`\n\n```latex\n\\[x^2\\]\n$literal$\n```';
    await show(markdown);
    assert.equal(await content.locator('h1').textContent(), '渲染检查');
    assert.equal(await content.locator('h2').textContent(), '基本格式');
    for (const selector of ['strong', 'em', 'del', 'a[href="https://example.com"]', 'blockquote', 'ol > li', 'ol ul > li', 'table td .katex', 'br']) {
      assert.ok(await content.locator(selector).count(), `Markdown should render ${selector}`);
    }
    assert.equal(await content.locator('.task-checkbox').count(), 2);
    assert.equal(await content.locator('input').count(), 0);
    assert.equal(await content.locator('pre .katex, code .katex').count(), 0);
    assert.equal(await content.locator('pre code').textContent(), '\\[x^2\\]\n$literal$\n');
    assert.equal(await page.locator('.message-user strong').textContent(), 'Markdown');
    assert.equal(await page.locator('.message-user .katex').count(), 1);
    await content.locator('.code-copy').click();
    assert.equal(await electron.evaluate(() => globalThis.__renderCheck.copied), '\\[x^2\\]\n$literal$\n');
    await page.locator('.message-actions button').click();
    assert.equal(await electron.evaluate(() => globalThis.__renderCheck.copied), markdown, 'Copy answer keeps original Markdown and TeX');
    await show('这是**“重点”**，以及**（结论）**继续。\n\n**结论：**中文和*“斜体”*紧邻；~~“删除”~~继续。\n\n**bold $x_i$ text**\n\n`**“代码”**`');
    assert.equal(await content.locator('strong').count(), 4);
    assert.deepEqual((await content.locator('strong').allTextContents()).slice(0, 3), ['“重点”', '（结论）', '结论：']);
    assert.equal(await content.locator('strong .katex').count(), 1);
    assert.equal(await content.locator('em').textContent(), '“斜体”');
    assert.equal(await content.locator('del').textContent(), '“删除”');
    assert.equal(await content.locator('code').textContent(), '**“代码”**');

    const math = String.raw`# 数学公式

行内 $E=mc^2$，以及 \(a_i^2+b_i^2=c_i^2\)。

$$
\frac{-b\pm\sqrt{b^2-4ac}}{2a}
$$

\[
\begin{aligned}
f(x)&=\sum_{i=1}^{n}x_i^2\\
F(x)&=\int_0^x f(t)\,dt
\end{aligned}
\]

\[\begin{pmatrix}1 & 2\\3 & 4\end{pmatrix}\]

**结论：**中文紧邻$x+y$也应正常显示。
`;
    await show(math);
    assert.equal(await content.locator('.katex').count(), 6);
    assert.equal(await content.locator('.katex-display').count(), 3);
    assert.equal(await content.locator('math').count(), 6, 'Accessible MathML is retained');
    assert.equal(await content.locator('.math-fallback').count(), 0);
    assert.equal(await content.locator('strong').textContent(), '结论：');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true);
    const mathLayout = await content.locator('.katex-html').first().evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    assert.ok(mathLayout.width > 15 && mathLayout.height > 8, 'Math must have visible layout');

    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.mini.invoke('settings:update', { theme }), theme);
      await page.evaluate(() => { document.querySelector('#conversation-area').scrollTop = 0; document.querySelector('#toast').hidden = true; });
      await electron.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const png = await electron.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      fs.writeFileSync(path.join(testDir, `${theme}.png`), Buffer.from(png, 'base64'));
    }

    // The parser sees all content accumulated so far on every streaming update.
    await show('**流式**公式 \\[\\frac{1}{', '流式检查', 'streaming');
    assert.equal(await content.locator('strong').textContent(), '流式');
    assert.equal(await content.locator('.katex').count(), 0);
    assert.ok((await content.textContent()).includes('frac'));
    await electron.evaluate(() => {
      const check = globalThis.__renderCheck, delta = '2}\\]';
      check.conversation.messages[1].content += delta;
      check.emit({ type: 'delta', conversationId: check.conversation.id, messageId: 'assistant', delta });
    });
    await content.locator('.katex').waitFor();
    await electron.evaluate(() => {
      const check = globalThis.__renderCheck;
      check.conversation.status = check.conversation.messages[1].status = 'complete';
      check.emit({ type: 'complete', conversation: check.conversation });
    });
    await page.reload();
    await page.locator('#history-toggle').click();
    await page.locator('.history-open').click();
    await content.locator('.katex').waitFor();

    await show(String.raw`价格 $5 和 $10；转义 \$20；代码 \(x\) 的写法：` + '`\\(x\\)`' + '\n\n' + String.raw`错误 $\frac{$，正常 $y^2$。`);
    assert.ok((await content.textContent()).includes('$5 和 $10'));
    assert.ok((await content.textContent()).includes('$20'));
    assert.equal(await content.locator('code .katex').count(), 0);
    await show(String.raw`错误 $\unknowncommand{x}$，正常 $y^2$。`);
    assert.equal(await content.locator('.math-fallback').count(), 1);
    assert.equal(await content.locator('.katex').count(), 1);

    assert.deepEqual(errors, [], 'Valid messages must not log errors or CSP violations');
    await show(String.raw`<script>window.__unsafe = true</script><img src=x onerror="window.__unsafe = true"><style>body{display:none}</style><iframe src="https://example.com"></iframe><svg onload="window.__unsafe = true"></svg><span style="position:fixed" onclick="window.__unsafe=true">文本</span><input type="text"><a href="javascript:alert(1)">危险链接</a>

$\href{javascript:alert(1)}{bad}$ $\includegraphics{https://example.com/image.png}$`);
    assert.equal(await content.locator('script, img, style, iframe, svg, input, [onclick], [onerror], a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false);
    assert.equal(await content.locator('span[style="position:fixed"]').count(), 0);
    // Chromium can report blocking the hostile <style> while DOMPurify parses
    // it in a detached document. All other renderer errors still fail the test.
    for (const error of errors.splice(0)) assert.match(error, /Applying inline style violates.*style-src 'self'/);

    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 500));
    await show('$$' + 'x_1+x_2+'.repeat(45) + 'x_n$$\n\n```text\n' + 'wide-code-'.repeat(60) + '\n```\n\n| A | B |\n| --- | --- |\n| ' + 'wide-table-'.repeat(40) + ' | value |');
    const bounds = await page.evaluate(() => {
      const area = document.querySelector('#conversation-area'), formula = document.querySelector('.math-display');
      return { viewport: area.clientWidth, width: area.scrollWidth, formulaWidth: formula.clientWidth, formulaScroll: formula.scrollWidth };
    });
    assert.ok(bounds.width <= bounds.viewport + 1, `Content must not widen the window: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.formulaScroll > bounds.formulaWidth, 'Long equations scroll inside their own container');
    assert.deepEqual(errors, [], 'Renderer must not log errors or CSP violations');
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    console.log(`Rendering passed: Markdown, TeX, streaming, history, copying, safety, fonts, themes, and narrow-window layout. Screenshots: ${testDir}`);
  } catch (error) {
    if (errors.length) console.error('Renderer errors:', errors);
    throw error;
  } finally {
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    await electron.close().catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
