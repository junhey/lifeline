import type { CodeBuddyLiveDump } from '../packages/agent/src/drivers/codebuddy/live.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { codebuddySingleOptionClickExpression, dumpCodeBuddyLive } from '../packages/agent/src/drivers/codebuddy/extractor.js';
import { mapCodeBuddyLive } from '../packages/agent/src/drivers/codebuddy/live.js';

/**
 * CodeBuddy questionnaire extraction (`question-floating-module_*`).
 *
 * Structure checked against CodeBuddy's **own bundle source** (question-floating.react.js + CSS Modules class table):
 *   - Root `question-floating-module_questionFloating_<hash>`; collapsed content is not rendered at all → treat as no questionnaire;
 *   - single (one question, not multi-select): optionItem (optionLetter/optionText/`selected_` class) + customInputRow,
 *     **clicking an option submits; there is no footer**;
 *   - multi (several questions, or one multi-select): questionBlock × N (questionNumber / questionText / `multiBadge_`=multi-select)
 *     + footer (skipBtn / continueBtn, continue has a `disabled_` class);
 *   - Paths all use `[class*="..."]` (the hash changes); prefixes keep a trailing underscore so option/optionItem do not collide.
 * ⚠️ Pending live verification (a live probe would collide with a user who has CodeBuddy open); these cases lock the structural contract itself.
 */

function withDom<T>(html: string, fn: () => T): T {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    return fn();
  }
  finally {
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

const SINGLE = `
<div class="question-floating-module_questionFloating_ip9de question-floating-module_singleMode_PtBEC">
  <div class="question-floating-module_singleQuestion_tIxHk">
    <div class="question-floating-module_content_MqYOp">
      <div class="question-floating-module_questionText_j9J2O">这次重构选哪种？</div>
      <div class="question-floating-module_optionsWrapper_wRohQ">
        <div class="question-floating-module_optionItem_rOhKt">
          <span class="question-floating-module_optionLetter_BMGsI">A</span>
          <span class="question-floating-module_optionText_lbhpC">保守收边界</span>
        </div>
        <div class="question-floating-module_optionItem_rOhKt question-floating-module_selected_TgHBt">
          <span class="question-floating-module_optionLetter_BMGsI">B</span>
          <span class="question-floating-module_optionText_lbhpC">给小团队用</span>
        </div>
        <div class="question-floating-module_customInputRow_IERoA">
          <span class="question-floating-module_optionLetter_BMGsI">C</span>
          <input class="question-floating-module_customInput_SMif3" type="text"/>
        </div>
      </div>
    </div>
  </div>
</div>`;

const MULTI = `
<div class="question-floating-module_questionFloating_ip9de">
  <div class="question-floating-module_multiQuestion_LrcW0">
    <div class="question-floating-module_content_MqYOp">
      <div class="question-floating-module_questionBlock_lw8Kd">
        <div class="question-floating-module_questionHeader_eADex">
          <span class="question-floating-module_questionNumber_VkRFH">1.</span>
          <span class="question-floating-module_questionText_j9J2O">第一题？</span>
        </div>
        <div class="question-floating-module_options_SWrJh">
          <div class="question-floating-module_option_rUDHS question-floating-module_selected_TgHBt">
            <span class="question-floating-module_optionLetter_BMGsI">A</span>
            <span class="question-floating-module_optionText_lbhpC">甲</span>
          </div>
        </div>
      </div>
      <div class="question-floating-module_questionBlock_lw8Kd">
        <div class="question-floating-module_questionHeader_eADex">
          <span class="question-floating-module_questionNumber_VkRFH">2.</span>
          <span class="question-floating-module_questionText_j9J2O">第二题？</span>
          <span class="question-floating-module_multiBadge_GvWHf">多选</span>
        </div>
        <div class="question-floating-module_options_SWrJh">
          <div class="question-floating-module_option_rUDHS"><span class="question-floating-module_optionLetter_BMGsI">A</span><span class="question-floating-module_optionText_lbhpC">乙</span></div>
          <div class="question-floating-module_option_rUDHS"><span class="question-floating-module_optionLetter_BMGsI">B</span><span class="question-floating-module_optionText_lbhpC">丙</span></div>
        </div>
      </div>
    </div>
    <div class="question-floating-module_footer__U8uV">
      <button class="question-floating-module_skipBtn_teNYJ">跳过</button>
      <button class="question-floating-module_continueBtn_Q0lqS question-floating-module_disabled_iU4_a">完成</button>
    </div>
  </div>
</div>`;

describe('dumpCodeBuddyLive 的问卷抽取', () => {
  it('single 形态：题干 / 选项（含 Other）/ selected / 无 footer', () => {
    const dump = withDom(SINGLE, () => dumpCodeBuddyLive());
    assert.ok(dump);
    const q = dump.questionnaire;
    assert.ok(q, 'questionnaire 应为非 null');
    assert.equal(q.questions.length, 1);
    assert.equal(q.questions[0].text, '这次重构选哪种？');
    assert.equal(q.questions[0].multiSelect, false);
    assert.deepEqual(
      q.questions[0].options.map(o => [o.letter, o.label, o.isFreeform, o.selected]),
      [
        ['A', '保守收边界', false, false],
        ['B', '给小团队用', false, true],
        ['C', 'Other', true, false],
      ],
    );
    assert.equal(
      q.questions[0].options[0].selectorPath,
      '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_optionItem_"]:nth-of-type(1)',
    );
    assert.equal(
      q.questions[0].options[2].selectorPath,
      '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_customInputRow_"]',
    );
    // single mode has no Skip / Continue (clicking an option submits)
    assert.equal(q.skipSelectorPath, '');
    assert.equal(q.continueSelectorPath, '');
    assert.equal(q.continueDisabled, false);
    assert.equal(q.skipLabel, '');
    assert.equal(q.continueLabel, '');
  });

  it('multi 形态：多题 / multiBadge=多选 / footer 与 disabled', () => {
    const dump = withDom(MULTI, () => dumpCodeBuddyLive());
    const q = dump?.questionnaire;
    assert.ok(q);
    assert.equal(q.questions.length, 2);
    assert.deepEqual(q.questions.map(x => x.number), ['1', '2']);
    assert.deepEqual(q.questions.map(x => x.multiSelect), [false, true]);
    assert.equal(q.questions[0].options[0].selected, true);
    assert.equal(
      q.questions[1].options[1].selectorPath,
      '[class*="question-floating-module_questionBlock_"]:nth-of-type(2) [class*="question-floating-module_option_"]:nth-of-type(2)',
    );
    assert.equal(q.skipSelectorPath, '[class*="question-floating-module_skipBtn_"]');
    assert.equal(q.continueSelectorPath, '[class*="question-floating-module_continueBtn_"]');
    assert.equal(q.continueDisabled, true);
    // Button copy follows the IDE: CodeBuddy is Skip / Complete (English UI); the web client must not invent Continue
    assert.equal(q.skipLabel, '跳过');
    assert.equal(q.continueLabel, '完成');
  });

  it('问卷带归属会话：当前会话 tab 的 id', () => {
    const dom = `<div class="session-tab session-tab-active" data-session-tab-id="s-own-1">`
      + `<span class="session-tab-name">会话一</span></div>${SINGLE}`;
    const dump = withDom(dom, () => dumpCodeBuddyLive());
    assert.equal(dump?.questionnaire?.composerId, 's-own-1');
  });

  it('折叠态（内容不渲染）与无问卷 → null', () => {
    const collapsed = `<div class="question-floating-module_questionFloating_ip9de question-floating-module_collapsed_LyCcQ"></div>`;
    assert.equal(withDom(collapsed, () => dumpCodeBuddyLive())?.questionnaire, null);
    assert.equal(withDom('<div></div>', () => dumpCodeBuddyLive())?.questionnaire, null);
  });
});

/**
 * Single-question option click (`codebuddySingleOptionClickExpression`).
 *
 * The IDE's own component (measured live 2026-10-05, CodeBuddy CN 1.106.1) does
 * `onOptionSelect(v); setTimeout(() => onSubmit(), 0)`, and that `onSubmit` closes over the
 * **previous** `selectedAnswer`: the first click only paints `selected_`, the next click submits
 * the option selected *before* it (click A then B → B is painted, A goes on the wire).
 * The expression must therefore click, wait for the paint, then click the same row again.
 */
const SINGLE_OPTIONS = `
<div class="question-floating-module_questionFloating_ip9de question-floating-module_singleMode_PtBEC">
  <div class="question-floating-module_singleQuestion_tIxHk">
    <div class="question-floating-module_optionsWrapper_wRohQ">
      <div class="question-floating-module_optionItem_rOhKt" data-opt="A">A</div>
      <div class="question-floating-module_optionItem_rOhKt" data-opt="B">B</div>
      <div class="question-floating-module_customInputRow_IERoA" data-opt="Other">Other</div>
    </div>
  </div>
</div>`;

interface SingleWindow {
  __answer: string | null;
  __clicks: string[];
  eval: (code: string) => unknown;
}

const OPTION_B_SELECTED = SINGLE_OPTIONS.replace(
  'class="question-floating-module_optionItem_rOhKt" data-opt="B"',
  'class="question-floating-module_optionItem_rOhKt question-floating-module_selected_TgHBt" data-opt="B"',
);

/**
 * Replay the IDE component: a click that finds an answer already held submits **that** answer
 * (the stale closure) and unmounts the overlay; otherwise it only paints `selected_`.
 * `heldBefore` = the answer the IDE already had (e.g. a previous click that never submitted).
 */
function singleDom(html: string, heldBefore: string | null = null): SingleWindow {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window as unknown as SingleWindow;
  win.eval(`
    window.__answer = null;
    window.__clicks = [];
    let held = ${JSON.stringify(heldBefore)};
    for (const el of document.querySelectorAll('[class*="question-floating-module_optionItem_"]')) {
      el.addEventListener('click', () => {
        window.__clicks.push(el.dataset.opt);
        if (held !== null) {
          window.__answer = held;                       // ← the stale-closure submit
          const root = document.querySelector('[class*="question-floating-module_questionFloating_"]');
          if (root) root.remove();
        }
        held = el.dataset.opt;
        for (const other of document.querySelectorAll('[class*="question-floating-module_optionItem_"]'))
          other.className = 'question-floating-module_optionItem_rOhKt';
        el.className = 'question-floating-module_optionItem_rOhKt question-floating-module_selected_TgHBt';
      });
    }
  `);
  return win;
}

const OPTION_B_PATH = '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_optionItem_"]:nth-of-type(2)';

describe('单选问卷的选项点击（select → confirm）', () => {
  it('一次点击＝选中并提交这个选项（不是上一次选中的那个）', async () => {
    const win = singleDom(SINGLE_OPTIONS);
    const result = await win.eval(codebuddySingleOptionClickExpression(OPTION_B_PATH)) as { ok?: boolean; via?: string };
    assert.equal(result.ok, true);
    assert.equal(result.via, 'single-confirm');
    assert.deepEqual(Array.from(win.__clicks), ['B', 'B'], 'B 需要被点两次：第一次选中、第二次提交');
    assert.equal(win.__answer, 'B', '提交的必须是用户点的 B');
  });

  it('选项已经是选中态时只点一次（那一下就是提交，不能重复提交）', async () => {
    const win = singleDom(OPTION_B_SELECTED, 'B');
    const result = await win.eval(codebuddySingleOptionClickExpression(OPTION_B_PATH)) as { ok?: boolean; via?: string };
    assert.equal(result.ok, true);
    assert.equal(result.via, 'single-submit');
    assert.deepEqual(Array.from(win.__clicks), ['B'], '已选中态只允许一次点击');
    assert.equal(win.__answer, 'B');
  });

  it('选项不存在但问卷还开着 → Element not found（真的对不上）', async () => {
    const win = singleDom(
      '<div class="question-floating-module_questionFloating_ip9de">'
      + '<div class="question-floating-module_singleQuestion_tIxHk"></div></div>',
    );
    const result = await win.eval(codebuddySingleOptionClickExpression(
      '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_optionItem_"]:nth-of-type(1)',
    )) as { ok?: boolean; error?: string; via?: string };
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Element not found');
  });

  it('问卷已经被答掉/收起 → ok，不弹报错（点第二次的那 1s 窗口）', async () => {
    const gone = singleDom('<div id="chat"></div>');
    const goneRes = await gone.eval(codebuddySingleOptionClickExpression(OPTION_B_PATH)) as { ok?: boolean; via?: string };
    assert.equal(goneRes.ok, true);
    assert.equal(goneRes.via, 'questionnaire-gone');
    assert.deepEqual(Array.from(gone.__clicks), []);

    const collapsed = singleDom(
      '<div class="question-floating-module_questionFloating_ip9de question-floating-module_collapsed_LyCcQ"></div>',
    );
    const collapsedRes = await collapsed.eval(codebuddySingleOptionClickExpression(OPTION_B_PATH)) as { ok?: boolean; via?: string };
    assert.equal(collapsedRes.ok, true);
    assert.equal(collapsedRes.via, 'questionnaire-collapsed');
    assert.deepEqual(Array.from(collapsed.__clicks), []);
  });

  it('点了但界面没动：如实返回未确认，不假装成功提交', async () => {
    const win = singleDom(SINGLE_OPTIONS);
    // Strip the IDE behavior: clicks do nothing at all.
    win.eval(`
      for (const el of document.querySelectorAll('[class*="question-floating-module_optionItem_"]'))
        el.replaceWith(el.cloneNode(true));
    `);
    const path = '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_optionItem_"]:nth-of-type(1)';
    const result = await win.eval(codebuddySingleOptionClickExpression(path)) as { ok?: boolean; via?: string };
    assert.equal(result.ok, true);
    assert.equal(result.via, 'single-select-unconfirmed');
  });
});

describe('mapCodeBuddyLive 的问卷', () => {
  const base: CodeBuddyLiveDump = {
    inputAvailable: true,
    agentStatus: 'idle',
    agentActivityText: null,
    chatTabs: [],
    activeComposerId: 's1',
    pendingApprovals: [],
    liveActions: {},
    mode: { current: 'Craft', available: [] },
    model: { current: 'Auto', currentId: 'Auto' },
    questionnaire: {
      composerId: 's1',
      questions: [{ number: '1', text: 'X?', options: [], isActive: true }],
      activeIndex: 0,
      totalLabel: '',
      skipSelectorPath: '',
      continueSelectorPath: '',
      continueDisabled: false,
    },
  };

  it('透传进 live state', () => {
    const mapped = mapCodeBuddyLive(base);
    assert.equal(mapped.questionnaire?.questions[0].text, 'X?');
  });

  it('补抽取前的老 dump（没带字段）→ null，不炸', () => {
    const legacy = { ...base } as Partial<CodeBuddyLiveDump>;
    delete legacy.questionnaire;
    const mapped = mapCodeBuddyLive(legacy as CodeBuddyLiveDump);
    assert.equal(mapped.questionnaire, null);
  });
});
