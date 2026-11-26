/**
 * Prove an opened agent answers, by typing into the same box a customer types
 * into and waiting for the answer to show up on screen.
 *
 * Claude Code and Codex open in Hivra's own chat. The other agents open their
 * own web UI inside the agent page's iframe (cross-origin, from the agent's
 * computer). The driver is deliberately generic: find the composer the
 * customer would type into, type the question, press Enter (or Send), and wait
 * for the answer text. An agent whose UI changes so much that a person couldn't
 * find where to type would fail here too, which is the point.
 */
import type { Frame, Locator, Page } from '@playwright/test';

import { sleep } from '../first-run-audit/instances';
import { answerCookieBanner } from './journey';
import { SweepFailure } from './result';
import { SWEEP_CHAT_ANSWER, SWEEP_CHAT_PROMPT, type SweepTarget } from './targets';

const COMPOSER = [
  'textarea:not([readonly]):not([disabled])',
  '[contenteditable="true"]',
  'input[type="text"]:not([readonly]):not([disabled])',
  'input:not([type]):not([readonly]):not([disabled])',
].join(', ');

/** Words in an agent UI that mean it is asking the customer to sign in or set up first. */
const BLOCKING_COPY = /(sign in to|log ?in to|enter (your )?(api )?key|paste (your )?(api )?key|add an api key|no model (is )?(configured|selected)|connect a provider)/i;

export interface ChatProof {
  surface: string;
  replySeconds: number;
}

/** A question with one short, checkable answer. */
export interface SweepQuestion {
  prompt: string;
  answer: string;
}

const DEFAULT_QUESTION: SweepQuestion = { prompt: SWEEP_CHAT_PROMPT, answer: SWEEP_CHAT_ANSWER };

/** The first number in the question: still in the composer means it was not sent. */
function typedMarker(question: SweepQuestion): string {
  return question.prompt.match(/\d+/)?.[0] ?? question.prompt.slice(0, 12);
}

/** Every frame under the agent's dashboard iframe, outermost first. */
async function agentFrames(page: Page): Promise<Frame[]> {
  const iframe = page.locator('iframe[title$="· dashboard"]').first();
  const handle = await iframe.elementHandle({ timeout: 1_000 }).catch(() => null);
  const root = handle ? await handle.contentFrame() : null;
  if (!root) return [];
  const all: Frame[] = [];
  const walk = (frame: Frame) => {
    all.push(frame);
    frame.childFrames().forEach(walk);
  };
  walk(root);
  return all;
}

async function visibleComposer(frame: Frame): Promise<Locator | null> {
  const candidates = frame.locator(COMPOSER);
  const count = await candidates.count().catch(() => 0);
  // Chat composers sit at the bottom of the page; prefer the last visible one.
  for (let index = count - 1; index >= 0; index--) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (box && box.width >= 120) return candidate;
  }
  return null;
}

async function bodyText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

/** OpenHands asks this once before showing its workspace. A customer chooses
 * whether to send anonymous usage data, so the sweep must make the same
 * first-run choice before looking for the composer. */
export function isOpenHandsUsageConsent(text: string): boolean {
  return /help improve openhands/i.test(text) && /anonymous usage data/i.test(text);
}

async function acknowledgeOpenHandsUsageConsent(frame: Frame): Promise<boolean> {
  const text = await bodyText(frame);
  if (!isOpenHandsUsageConsent(text)) return false;
  const confirm = frame.getByRole('button', { name: /^\s*confirm\s*$/i }).first();
  if (!(await confirm.isVisible().catch(() => false))) return false;
  await confirm.click().catch(() => undefined);
  return true;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export interface SweepConsolePasswordState {
  value?: string;
}

/**
 * Some agents ask their owner to set a password for their own console before
 * the chat appears (Nuphos: "Choose the password that protects this console",
 * then Connect). PicoClaw's setup form then redirects to a separate sign-in
 * without creating a session. A customer remembers the password they just
 * chose, so the sweep keeps it and reuses it for that sign-in instead of
 * inventing a new one.
 */
export async function completeConsolePassword(frame: Frame, state: SweepConsolePasswordState): Promise<boolean> {
  const fields = frame.locator('input[type="password"]:not([readonly]):not([disabled])');
  const count = await fields.count().catch(() => 0);
  if (count === 0 || !(await fields.first().isVisible().catch(() => false))) return false;
  if (!/password/i.test(await bodyText(frame))) return false;
  state.value ??= `Sweep-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}!`;
  const password = state.value;
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index);
    if (await field.isVisible().catch(() => false)) await field.fill(password).catch(() => undefined);
  }
  const submit = frame.getByRole('button', { name: /connect|continue|save|set password|sign in|unlock|start/i }).first();
  if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => undefined);
  else await fields.last().press('Enter').catch(() => undefined);
  return true;
}

/**
 * A notice an agent shows over its own UI on first open (DeepSeek Harness:
 * "Internal Testing Notice … Continue"). A customer reads it and presses the
 * button that lets them carry on; so does the sweep.
 */
async function acknowledgeNotice(frame: Frame): Promise<boolean> {
  const dialog = frame.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').first();
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const proceed = dialog.getByRole('button', { name: /^\s*(continue|got it|i understand|accept|ok|okay|start|get started)\s*$/i }).first();
  if (!(await proceed.isVisible().catch(() => false))) return false;
  await proceed.click().catch(() => undefined);
  return true;
}

/**
 * Some agent UIs keep the composer greyed out until a workspace is chosen
 * (DeepSeek Harness: "Choose a workspace to start" with a "Choose workspace"
 * picker). A customer opens the picker and takes the first workspace offered,
 * or makes a new one; so does the sweep.
 */
async function chooseWorkspace(frame: Frame): Promise<boolean> {
  // The picker can open a folder chooser ("Select Workspace Directory",
  // starting at Home, with New folder / Cancel / Open). A customer presses
  // Open to use the folder it is showing.
  const chooser = frame.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: /workspace (directory|folder)|select (a )?(directory|folder)/i }).first();
  if (await chooser.isVisible().catch(() => false)) {
    const open = chooser.getByRole('button', { name: /^\s*(open|select|choose|use this folder)\s*$/i }).last();
    if (await open.isVisible().catch(() => false)) {
      await open.click().catch(() => undefined);
      return true;
    }
  }
  if (/select workspace directory/i.test(await bodyText(frame))) {
    const open = frame.getByRole('button', { name: /^\s*open\s*$/i });
    const count = await open.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      if (await open.nth(index).isVisible().catch(() => false)) {
        await open.nth(index).click().catch(() => undefined);
        return true;
      }
    }
  }
  if (!/choose a workspace|select a workspace|no workspace/i.test(await bodyText(frame))) return false;
  const picker = frame.getByRole('button', { name: /(choose|select|open) (a )?workspace/i })
    .or(frame.getByRole('combobox', { name: /workspace/i }))
    .or(frame.getByText(/^\s*choose workspace\s*$/i))
    .first();
  if (!(await picker.isVisible().catch(() => false))) return false;
  await picker.click().catch(() => undefined);
  await sleep(1_500);
  const offered = frame.getByRole('option')
    .or(frame.getByRole('menuitem'))
    .or(frame.getByRole('menuitemradio'))
    .first();
  if (await offered.isVisible().catch(() => false)) {
    await offered.click().catch(() => undefined);
    return true;
  }
  const create = frame.getByRole('button', { name: /(new|create|add) workspace|^\s*(new|create)\s*$/i }).first();
  if (await create.isVisible().catch(() => false)) {
    await create.click().catch(() => undefined);
    await sleep(1_500);
    const name = frame.locator('[role="dialog"] input:not([type="hidden"]), input[placeholder*="orkspace" i]').first();
    if (await name.isVisible().catch(() => false)) {
      await name.fill(`sweep-${Date.now().toString(36)}`).catch(() => undefined);
      const confirm = frame.getByRole('button', { name: /^\s*(create|save|ok|done|continue)\s*$/i }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
      else await name.press('Enter').catch(() => undefined);
    }
    return true;
  }
  return false;
}

/** Wait for the place to type, in Hivra's chat or inside the agent's own UI. */
async function findComposer(
  page: Page,
  target: SweepTarget,
  timeoutMs: number,
): Promise<{ frame: Frame; composer: Locator; surface: string }> {
  const end = Date.now() + timeoutMs;
  const navigateAt = Date.now() + 45_000;
  let navigated = false;
  let passwordAttempts = 0;
  let noticeAttempts = 0;
  let workspaceAttempts = 0;
  const consolePassword: SweepConsolePasswordState = {};
  let lastSeen = '';
  while (Date.now() < end) {
    // Opening can land on another tab (Codex opened on Settings). A customer
    // then presses the agent's Chat (or, for a dashboard agent, Dashboard).
    if (!navigated && Date.now() > navigateAt) {
      navigated = true;
      const names = target.proof === 'hivra-chat' ? ['Chat'] : ['Dashboard', 'Chat'];
      for (const name of names) {
        const item = page.getByRole('link', { name, exact: true })
          .or(page.getByRole('button', { name, exact: true }))
          .or(page.getByRole('tab', { name, exact: true }))
          .first();
        if (await item.isVisible().catch(() => false)) {
          await item.click().catch(() => undefined);
          break;
        }
      }
    }
    if (target.proof === 'hivra-chat') {
      const region = page.getByRole('region', { name: 'Conversation' });
      if (await region.isVisible().catch(() => false)) {
        const composer = await visibleComposer(page.mainFrame());
        if (composer) return { frame: page.mainFrame(), composer, surface: 'Hivra chat' };
      }
    } else {
      for (const frame of await agentFrames(page)) {
        if (await acknowledgeOpenHandsUsageConsent(frame)) {
          await sleep(2_000);
          continue;
        }
        if (noticeAttempts < 3 && await acknowledgeNotice(frame)) {
          noticeAttempts++;
          await sleep(2_000);
          continue;
        }
        if (passwordAttempts < 3 && await completeConsolePassword(frame, consolePassword)) {
          passwordAttempts++;
          await sleep(5_000);
          continue;
        }
        if (workspaceAttempts < 3 && await chooseWorkspace(frame)) {
          workspaceAttempts++;
          await sleep(3_000);
          continue;
        }
        const composer = await visibleComposer(frame);
        if (composer) return { frame, composer, surface: `${target.tile} web UI` };
        lastSeen = (await bodyText(frame)).replace(/\s+/g, ' ').trim().slice(0, 300) || lastSeen;
      }
    }
    await sleep(3_000);
  }
  const pageNote = (await page.locator('[role="status"], [role="alert"]').allInnerTexts().catch(() => []))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  throw new SweepFailure(
    'open',
    'product',
    `No place to type a message after ${Math.round(timeoutMs / 60_000)} min.` +
      (lastSeen ? ` Agent UI showed: "${lastSeen}".` : '') +
      (pageNote ? ` Page said: "${pageNote}".` : ''),
  );
}

export async function proveChat(
  page: Page,
  target: SweepTarget,
  options: { composerTimeoutMs: number; replyTimeoutMs: number; question?: SweepQuestion },
): Promise<ChatProof> {
  const question = options.question ?? DEFAULT_QUESTION;
  const marker = typedMarker(question);
  const { frame, composer, surface } = await findComposer(page, target, options.composerTimeoutMs);

  const before = occurrences(await bodyText(frame), question.answer);
  // An agent UI that loaded but can't reach its own backend can't be typed to.
  const offline = (await bodyText(frame)).match(/Backend offline|Reconnecting to [^\n.]+|Disconnected from [^\n.]+/i);
  if (offline) {
    await sleep(60_000);
    const still = (await bodyText(frame)).match(/Backend offline|Reconnecting to [^\n.]+|Disconnected from [^\n.]+/i);
    if (still) throw new SweepFailure('chat', 'product', `${surface} loaded but says "${still[0]}", so nothing can be sent.`);
  }
  // Hivra's agent menu can be left open over the page after Open; close it.
  // The cookie banner, once answered, stays away for the rest of the run.
  await page.keyboard.press('Escape').catch(() => undefined);
  await answerCookieBanner(page);

  // An agent that has only just booted can take the first message without
  // passing it on (Hermes while "Waking up"). A customer who sees their
  // question never appear sends it again; so does the sweep, up to 3 times.
  const asked = question.prompt.slice(0, 24);
  const askedBefore = occurrences(await bodyText(frame), asked);
  let sentAt = Date.now();
  let shown = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    sentAt = await sendQuestion(page, frame, composer, question);
    const shownBy = Date.now() + 20_000;
    while (Date.now() < shownBy) {
      const text = await bodyText(frame);
      // A contenteditable composer shows the typed question itself; it only
      // counts once the composer has been emptied by sending.
      const inComposer = ((await composer.innerText().catch(() => '')) || (await composer.inputValue().catch(() => '')) || '').includes(marker);
      if ((!inComposer && occurrences(text, asked) > askedBefore) || occurrences(text, question.answer) > before) {
        shown = true;
        break;
      }
      await sleep(2_000);
    }
    if (shown) break;
    if (attempt < 3) await sleep(15_000);
  }

  const end = sentAt + options.replyTimeoutMs;
  let text = '';
  while (Date.now() < end) {
    text = await bodyText(frame);
    if (occurrences(text, question.answer) > before) {
      return { surface, replySeconds: Math.round((Date.now() - sentAt) / 1000) };
    }
    await sleep(2_000);
  }

  const tail = text.replace(/\s+/g, ' ').trim().slice(-400);
  const blocked = BLOCKING_COPY.test(tail);
  throw new SweepFailure(
    'chat',
    'product',
    `${surface}: no answer within ${Math.round(options.replyTimeoutMs / 60_000)} min` +
      (blocked ? ' (it is asking for a sign-in or key)' : '') +
      (shown ? '' : ' (the question never appeared in the chat after 3 tries)') +
      `. End of screen: "${tail}"`,
  );
}

/** Type the question into the composer and send it, the way a customer would. */
async function sendQuestion(page: Page, frame: Frame, composer: Locator, question: SweepQuestion): Promise<number> {
  const marker = typedMarker(question);
  await composer.click({ timeout: 15_000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => undefined);
    await answerCookieBanner(page);
    await composer.click({ force: true });
  });
  const editable = await composer.evaluate((el) => (el as HTMLElement).isContentEditable).catch(() => false);
  if (editable) await page.keyboard.type(question.prompt, { delay: 5 });
  else await composer.fill(question.prompt);
  const sentAt = Date.now();
  await composer.press('Enter');

  // Some UIs send on Ctrl/Cmd+Enter or only from a button. If the question is
  // still sitting in the composer a few seconds later, press Send.
  await sleep(4_000);
  const stillTyped = editable
    ? ((await composer.innerText().catch(() => '')) || '').includes(marker)
    : ((await composer.inputValue().catch(() => '')) || '').includes(marker);
  if (stillTyped) {
    const send = frame.getByRole('button', { name: /^(send|submit|send message)$/i }).last();
    if (await send.isVisible().catch(() => false)) await send.click().catch(() => undefined);
    else await composer.press('Control+Enter').catch(() => undefined);
  }
  return sentAt;
}

/** Press the first match that is on screen; false when none is. */
async function clickFirstVisible(matches: Locator): Promise<boolean> {
  const count = await matches.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    // An overlay (the cookie banner) can sit over the control; press it
    // anyway rather than waiting the whole run on a click that never lands.
    await match.click({ timeout: 10_000 }).catch(() => match.click({ force: true, timeout: 5_000 }).catch(() => undefined));
    return true;
  }
  return false;
}

/**
 * A computer is proven when its own page shows it running with its working
 * surface: the desktop or terminal iframe, with no error panel.
 */
export async function proveComputerOpen(page: Page, timeoutMs: number): Promise<ChatProof> {
  const start = Date.now();
  const end = start + timeoutMs;
  let nextNavigation = start + 30_000;
  while (Date.now() < end) {
    // A computer can open on its settings page; a customer then presses
    // Desktop (or Terminal for one without a desktop). A Linux computer has no
    // Desktop and lists Terminal / Files / Settings in its controls menu, so
    // menu items count too, and the sweep tries again if the first press
    // landed nowhere.
    // A computer can take minutes to finish setting up before its Terminal
    // tile does anything, so keep pressing every 20 s until a surface shows,
    // not only during the first minute or two.
    if (Date.now() > nextNavigation) {
      nextNavigation = Date.now() + 20_000;
      await answerCookieBanner(page);
      for (const name of [/^\s*desktop\s*$/i, /^\s*terminal\s*$/i]) {
        // The same name can also sit on a hidden copy (a collapsed rail or
        // menu), so press the first one that is actually on screen.
        const byRole = page.getByRole('link', { name })
          .or(page.getByRole('button', { name }))
          .or(page.getByRole('tab', { name }))
          .or(page.getByRole('menuitem', { name }))
          .or(page.getByRole('menuitemradio', { name }));
        const byText = page.locator('a, button, [role="menuitem"], [role="option"], [role="tab"]').filter({ hasText: name });
        if (await clickFirstVisible(byRole) || await clickFirstVisible(byText)) break;
      }
    }
    const failed = page.getByText(/Provisioning failed|Computer isn.t ready|Couldn.t verify secure access/).first();
    if (await failed.isVisible().catch(() => false)) {
      const why = await page.locator('main').innerText().catch(() => '');
      throw new SweepFailure('open', 'product', `Computer page shows an error: "${why.replace(/\s+/g, ' ').slice(0, 300)}"`);
    }
    const frames = page.locator('iframe');
    const count = await frames.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const frame = frames.nth(index);
      if (!(await frame.isVisible().catch(() => false))) continue;
      const handle = await frame.elementHandle().catch(() => null);
      const content = handle ? await handle.contentFrame() : null;
      const url = content?.url() ?? '';
      if (url && url !== 'about:blank' && !url.startsWith('about:')) {
        const title = (await frame.getAttribute('title').catch(() => '')) || 'computer';
        return { surface: title, replySeconds: Math.round((Date.now() - start) / 1000) };
      }
    }
    await sleep(5_000);
  }
  throw new SweepFailure('open', 'product', `Computer page never showed its desktop or terminal within ${Math.round(timeoutMs / 60_000)} min.`);
}
