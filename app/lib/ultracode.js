// UltraCode: the strongest model at max effort, and one review pass after each turn the person started.

export const REVIEW_PASS =
  'UltraCode review pass: check the change you just made against my request, run the tests, and fix what is wrong, test first. If everything holds, reply "Nothing found." and stop.';

// The Claude models the picker offers, as Claude Code's --model aliases.
const PICKER_MODELS = new Set(['opus', 'sonnet', 'haiku']);

// Claude Code's --model and --effort for the picker's choice. Undefined for Gemini and Auto: they
// answer in the window, so the Claude session keeps whatever it runs.
export function sessionModelArgs({ model, effort, ultraModel }) {
  if (model === 'gemini' || model === 'auto') return undefined;
  if (model === 'ultracode') return ['--model', ultraModel, '--effort', 'max'];
  return [...(PICKER_MODELS.has(model) ? ['--model', model] : []), ...(effort !== 'default' ? ['--effort', effort] : [])];
}

// `fromUser`: the turn that ended answered the person, not a review pass. `edited`: it changed
// files; a question or a slash command has nothing to review.
export const reviewDue = ({ model, fromUser, marathon, edited }, event) =>
  event.kind === 'result' && event.ok && model === 'ultracode' && fromUser && edited && !marathon && !/\?\s*$/.test(event.text);
