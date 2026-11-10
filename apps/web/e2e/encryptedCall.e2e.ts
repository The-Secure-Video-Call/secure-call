// End-to-end: two (or three) browser contexts with fake cameras call each other through the real
// signaling server, under the production CSP. Every test also fails on a CSP or Trusted Types
// violation and on an uncaught error. See playwright.config.ts for how the servers are started.
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';

const WAITING_TEXT = 'Waiting for the other person to join…';
const CONNECTED_TEXT = 'Connected, not verified yet';
const VERIFIED_TEXT = 'Connected and verified';
const OTHER_PERSON_LEFT_TEXT = 'The other person left the call.';
const ROOM_FULL_TEXT = 'This call already has two people, so you cannot join.';
const VERIFICATION_FAILED_TEXT =
  'The connection could not be verified. Someone may be interfering. Start a new call.';
const PRIVACY_NEEDS_RELAY_TEXT =
  "Privacy mode needs our relay, which isn't available right now. Turn privacy mode off to call directly.";
const SIGNALING_URL_PATTERN = /\/ws\/signal\//;
const CSP_VIOLATION_PREFIX = 'CSP violation:';

type Person = { name: string; context: BrowserContext; page: Page; problems: string[] };

let people: Person[] = [];

test.afterEach(async () => {
  await Promise.all(people.map((person) => person.context.close()));
  people = [];
});

async function newPerson(browser: Browser, browserName: string, name: string): Promise<Person> {
  // Chromium needs the permissions; Firefox gets fake devices without a prompt from its prefs.
  const context = await browser.newContext(
    browserName === 'chromium' ? { permissions: ['camera', 'microphone'] } : {},
  );
  const person: Person = { name, context, page: await context.newPage(), problems: [] };
  await context.addInitScript((prefix) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `${prefix} ${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`,
      );
    });
  }, CSP_VIOLATION_PREFIX);
  context.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith(CSP_VIOLATION_PREFIX)) {
      person.problems.push(`${name}: ${message.text()}`);
    }
  });
  context.on('weberror', (webError) =>
    person.problems.push(`${name}: ${webError.error().message}`),
  );
  people.push(person);
  return person;
}

/** Makes a call link in the lobby, in a page of its own, as a person would. */
async function createCallLink(person: Person, options: { privacyMode?: boolean } = {}) {
  const lobbyPage = await person.context.newPage();
  await lobbyPage.goto('/');
  if (options.privacyMode) await lobbyPage.getByRole('switch', { name: /Privacy mode/ }).check();
  await lobbyPage.getByRole('button', { name: 'New call' }).click();
  const callLink = await lobbyPage.getByLabel('Call link').inputValue();
  await lobbyPage.close();
  return callLink;
}

function callStatus(person: Person) {
  return person.page.locator('p.call-status');
}

async function expectRemoteVideoPlaying(person: Person) {
  const remoteVideo = person.page.locator('video[aria-label="The other person"]');
  await expect
    .poll(
      () =>
        remoteVideo.evaluate(
          (video: HTMLVideoElement) => video.videoWidth > 0 && video.readyState >= 2,
        ),
      { timeout: 25_000, message: `${person.name} sees the other person's video` },
    )
    .toBe(true);
}

async function receivesNoMedia(person: Person) {
  return person.page.evaluate(() =>
    [...document.querySelectorAll('video')].every((video) => video.muted || video.videoWidth === 0),
  );
}

function expectNoProblems() {
  expect(people.flatMap((person) => person.problems)).toEqual([]);
}

/**
 * Passes the signaling WebSocket through, letting `changeServerFrame` rewrite or repeat what the
 * server sends to this person. It returns the frames to deliver instead of the original one.
 */
async function interceptSignaling(
  person: Person,
  changeServerFrame: (frame: string) => string[],
  onPageFrame: (frame: string) => void = () => {},
) {
  await person.context.routeWebSocket(SIGNALING_URL_PATTERN, (pageSide: WebSocketRoute) => {
    const serverSide = pageSide.connectToServer();
    pageSide.onMessage((frame) => {
      onPageFrame(String(frame));
      serverSide.send(frame);
    });
    serverSide.onMessage((frame) => {
      for (const deliveredFrame of changeServerFrame(String(frame))) pageSide.send(deliveredFrame);
    });
  });
}

/** Changes one base64 character in the middle, so the decoded ciphertext differs by one byte. */
function flipOneCharacter(base64Text: string) {
  const position = Math.floor(base64Text.length / 2);
  const replacement = base64Text[position] === 'A' ? 'B' : 'A';
  return base64Text.slice(0, position) + replacement + base64Text.slice(position + 1);
}

test('@every-browser two people complete an encrypted call, see the same safety code and hang up', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  const callLink = await createCallLink(alice);

  await alice.page.goto(callLink);
  await expect(callStatus(alice)).toHaveText(WAITING_TEXT);
  await bob.page.goto(callLink);
  for (const person of [alice, bob]) {
    await expect(callStatus(person)).toHaveText(CONNECTED_TEXT);
    await expectRemoteVideoPlaying(person);
  }

  // The same safety code on both sides, as emoji (the default) and as numbers.
  const aliceEmojiCode = (await alice.page.locator('.safety-code-value').innerText()).trim();
  expect(aliceEmojiCode).not.toBe('');
  await expect(bob.page.locator('.safety-code-value')).toHaveText(aliceEmojiCode);
  for (const person of [alice, bob]) await person.page.getByLabel('Show as numbers').check();
  const aliceNumberCode = (
    await alice.page.getByLabel('Safety code as numbers').innerText()
  ).trim();
  expect(aliceNumberCode).toMatch(/^\d+( \d+)+$/);
  await expect(bob.page.getByLabel('Safety code as numbers')).toHaveText(aliceNumberCode);

  // Both confirm the codes match: the call is verified on both sides.
  for (const person of [alice, bob]) {
    await person.page.getByRole('button', { name: 'Yes, the codes match' }).click();
  }
  for (const person of [alice, bob]) {
    await expect(person.page.getByText('✔ Verified')).toBeVisible();
    await expect(callStatus(person)).toHaveText(VERIFIED_TEXT);
  }

  await alice.page.getByRole('button', { name: 'Hang up' }).click();
  await expect(callStatus(bob)).toHaveText(OTHER_PERSON_LEFT_TEXT);
  expectNoProblems();
});

test('a tampered signaling message ends the call before any media flows', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  let tamperedFrames = 0;
  await interceptSignaling(bob, (frame) => {
    const message = JSON.parse(frame) as { type?: string; payload?: string };
    if (tamperedFrames === 0 && message.type === 'signal' && typeof message.payload === 'string') {
      tamperedFrames += 1;
      return [JSON.stringify({ ...message, payload: flipOneCharacter(message.payload) })];
    }
    return [frame];
  });
  const callLink = await createCallLink(alice);

  await alice.page.goto(callLink);
  await expect(callStatus(alice)).toHaveText(WAITING_TEXT);
  await bob.page.goto(callLink);

  await expect(bob.page.getByText(VERIFICATION_FAILED_TEXT)).toBeVisible();
  expect(tamperedFrames).toBe(1);
  expect(await receivesNoMedia(bob)).toBe(true);
  await expect(bob.page.getByText(CONNECTED_TEXT)).toHaveCount(0);
  expectNoProblems();
});

test('a replayed signaling message ends the call', async ({ browser, browserName }) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  let replayedFrames = 0;
  await interceptSignaling(bob, (frame) => {
    const message = JSON.parse(frame) as { type?: string };
    if (replayedFrames === 0 && message.type === 'signal') {
      replayedFrames += 1;
      return [frame, frame];
    }
    return [frame];
  });
  const callLink = await createCallLink(alice);

  await alice.page.goto(callLink);
  await expect(callStatus(alice)).toHaveText(WAITING_TEXT);
  await bob.page.goto(callLink);

  await expect(bob.page.getByText(VERIFICATION_FAILED_TEXT)).toBeVisible();
  expect(replayedFrames).toBe(1);
  expect(await receivesNoMedia(bob)).toBe(true);
  expectNoProblems();
});

test('a third person opening the link is told the call is full', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  const carol = await newPerson(browser, browserName, 'Carol');
  const callLink = await createCallLink(alice);

  await alice.page.goto(callLink);
  await expect(callStatus(alice)).toHaveText(WAITING_TEXT);
  await bob.page.goto(callLink);
  await expect(callStatus(alice)).toHaveText(CONNECTED_TEXT);
  await expect(callStatus(bob)).toHaveText(CONNECTED_TEXT);

  await carol.page.goto(callLink);
  await expect(carol.page.getByText(ROOM_FULL_TEXT)).toBeVisible();
  await expect(callStatus(alice)).toHaveText(CONNECTED_TEXT);
  expectNoProblems();
});

test('privacy mode without a relay fails closed and sends nothing', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  const typesAliceSent: string[] = [];
  await interceptSignaling(
    alice,
    (frame) => [frame],
    (frame) => typesAliceSent.push(String((JSON.parse(frame) as { type?: string }).type)),
  );
  // This backend issues no TURN credentials, so privacy mode (relay only) cannot work. Bob is
  // already waiting, so Alice has someone to send her connection details to, and must not.
  const callLink = await createCallLink(alice, { privacyMode: true });

  await bob.page.goto(callLink);
  await expect(callStatus(bob)).toHaveText(WAITING_TEXT);
  await alice.page.goto(callLink);

  await expect(alice.page.getByText(PRIVACY_NEEDS_RELAY_TEXT)).toBeVisible();
  expect(typesAliceSent).toContain('join');
  expect(typesAliceSent).not.toContain('signal');
  expect(await receivesNoMedia(alice)).toBe(true);
  expectNoProblems();
});
