import test from 'node:test';
import assert from 'node:assert/strict';
import { toMrkdwn } from '../src/chat/slack/mrkdwn.mjs';
import { outgoing } from '../src/chat/slack/adapter.mjs';

test('markdown -> mrkdwn', () => {
  const md = `There is 1 open PR.

| PR | Author | CI |
|---|---|---|
| [#127](https://github.com/x/y/pull/127) "title" | faraj | Passing |

- **Method:** ran \`gh pr list\`
* **Changed:** nothing
## Notes
__maybe__ ~~gone~~
\`\`\`
**keep** [this](http://x)
\`\`\``;
  const want = `There is 1 open PR.

*PR · Author · CI*
- <https://github.com/x/y/pull/127|#127> "title" · faraj · Passing

- *Method:* ran \`gh pr list\`
- *Changed:* nothing
*Notes*
_maybe_ ~gone~
\`\`\`
**keep** [this](http://x)
\`\`\``;
  assert.equal(toMrkdwn(md), want);
  assert.equal(toMrkdwn('already *bold* and <https://a|b>'), 'already *bold* and <https://a|b>');
  assert.equal(toMrkdwn(''), '');
});

test('outgoing converts strings and section text, leaves buttons alone', () => {
  assert.deepEqual(outgoing('**hi**'), { text: '*hi*' });
  const m = outgoing({ text: 'x', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '**b** [l](https://u)' } }, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '**raw**' } }] }] });
  assert.equal(m.blocks[0].text.text, '*b* <https://u|l>');
  assert.equal(m.blocks[1].elements[0].text.text, '**raw**');
});
