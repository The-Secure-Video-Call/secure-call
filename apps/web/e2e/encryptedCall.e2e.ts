// End-to-end: two (or three) browser contexts with fake cameras call each other through the real
// signaling server, under the production CSP. See playwright.config.ts for how the servers start.
//
// Every page records what really happened, from before the app's own scripts run: how many peer
// connections were created, whether one ever reached "connected", and whether the other person's
// video ever showed a frame. The happy path asserts all of that happened (so the recorder works);
// the attack tests assert it never did. CSP and Trusted Types violations and uncaught errors are
// reported through a Playwright binding and fail the test in afterEach; a self-test proves the
// reporting works in every browser.
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
const LOCAL_SIGNALING_ORIGIN = 'ws://localhost:8000';

type CallHistory = {
  /** Call connections: the app always gives these ICE servers. */
  peerConnections: number;
  /** Throwaway connections that read the fingerprint of a new certificate (no ICE servers). */
  fingerprintProbes: number;
  /**
   * Every call connection had exactly one certificate, probed (its fingerprint read) before the
   * connection was created, and never used by an earlier call connection.
   */
  certificatesProbedAndFresh: boolean;
  /** A probe set a description, the one step that would make it gather candidates and send. */
  probeSetADescription: boolean;
  remoteTracks: number;
  everConnected: boolean;
  remoteVideoFrames: boolean;
};
type Person = { name: string; context: BrowserContext; page: Page; problems: string[] };

let people: Person[] = [];

test.afterEach(async () => {
  try {
    // A round trip to every open page first, so violations reported just now are counted too.
    for (const person of people) {
      for (const page of person.context.pages()) await page.evaluate(() => 0).catch(() => {});
    }
    expect(people.flatMap((person) => person.problems)).toEqual([]);
  } finally {
    await Promise.all(people.map((person) => person.context.close()));
    people = [];
  }
});

async function newPerson(browser: Browser, browserName: string, name: string): Promise<Person> {
  // Chromium needs the permissions; Firefox gets fake devices without a prompt from its prefs.
  const context = await browser.newContext(
    browserName === 'chromium' ? { permissions: ['camera', 'microphone'] } : {},
  );
  const person: Person = { name, context, page: await context.newPage(), problems: [] };
  await context.exposeBinding('reportProblemToTest', (_source, problem: string) => {
    person.problems.push(`${name}: ${problem}`);
  });
  await context.addInitScript(() => {
    const report = (window as unknown as { reportProblemToTest: (problem: string) => void })
      .reportProblemToTest;
    document.addEventListener('securitypolicyviolation', (event) => {
      report(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`);
    });
    const history: CallHistory = {
      peerConnections: 0,
      fingerprintProbes: 0,
      certificatesProbedAndFresh: true,
      probeSetADescription: false,
      remoteTracks: 0,
      everConnected: false,
      remoteVideoFrames: false,
    };
    (window as unknown as { callHistory: CallHistory }).callHistory = history;
    const NativePeerConnection = window.RTCPeerConnection;
    const probedCertificates = new Set<RTCCertificate>();
    const certificatesUsed = new Set<RTCCertificate>();
    window.RTCPeerConnection = class RecordedPeerConnection extends NativePeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        if (configuration?.iceServers === undefined) {
          history.fingerprintProbes += 1;
          for (const probedCertificate of configuration?.certificates ?? []) {
            probedCertificates.add(probedCertificate);
          }
          const setProbeLocalDescription = this.setLocalDescription.bind(this);
          // One signature only (the method has overloads): the app never passes callbacks.
          this.setLocalDescription = ((description?: RTCLocalSessionDescriptionInit) => {
            history.probeSetADescription = true;
            return setProbeLocalDescription(description);
          }) as RTCPeerConnection['setLocalDescription'];
          return;
        }
        history.peerConnections += 1;
        const [certificate, ...otherCertificates] = configuration.certificates ?? [];
        if (
          certificate === undefined ||
          otherCertificates.length > 0 ||
          !probedCertificates.has(certificate) ||
          certificatesUsed.has(certificate)
        ) {
          history.certificatesProbedAndFresh = false;
        }
        if (certificate !== undefined) certificatesUsed.add(certificate);
        this.addEventListener('track', () => {
          history.remoteTracks += 1;
        });
        this.addEventListener('connectionstatechange', () => {
          if (this.connectionState === 'connected') history.everConnected = true;
        });
      }
    };
    // "resize" fires on a video when its first frame gives it a size; capture sees it here.
    document.addEventListener(
      'resize',
      (event) => {
        const video = event.target;
        if (
          video instanceof HTMLVideoElement &&
          video.getAttribute('aria-label') === 'The other person' &&
          video.videoWidth > 0
        ) {
          history.remoteVideoFrames = true;
        }
      },
      true,
    );
  });
  person.context.on('weberror', (webError) =>
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

/** Opens the call and checks the page really got the production CSP (not some other server). */
async function openCall(person: Person, callLink: string) {
  const response = await person.page.goto(callLink);
  const contentSecurityPolicy = response?.headers()['content-security-policy'] ?? '';
  expect(contentSecurityPolicy).toContain("require-trusted-types-for 'script'");
  expect(contentSecurityPolicy).toContain(`connect-src 'self' ${LOCAL_SIGNALING_ORIGIN}`);
}

function callStatus(person: Person) {
  return person.page.locator('p.call-status');
}

async function readCallHistory(person: Person): Promise<CallHistory> {
  return person.page.evaluate(
    () => (window as unknown as { callHistory: CallHistory }).callHistory,
  );
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

/** No call was ever established for this person: never connected, never a frame of video. */
async function expectNoMediaEverFlowed(person: Person) {
  const history = await readCallHistory(person);
  expect(history.everConnected, `${person.name} never connected`).toBe(false);
  expect(history.remoteVideoFrames, `${person.name} never saw the other person`).toBe(false);
}

/**
 * Passes the signaling WebSocket through, letting `changeServerFrame` rewrite or repeat what the
 * server sends to this person (it returns the frames to deliver instead of the original one).
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

/** Calls `change` on the n-th `signal` frame (0 = the hello) the server sends to this person. */
async function changeNthSignalFrame(
  person: Person,
  signalIndex: number,
  change: (frame: string) => string[],
) {
  let signalFramesSeen = 0;
  const changed = { count: 0 };
  await interceptSignaling(person, (frame) => {
    if ((JSON.parse(frame) as { type?: string }).type !== 'signal') return [frame];
    signalFramesSeen += 1;
    if (signalFramesSeen - 1 !== signalIndex) return [frame];
    changed.count += 1;
    return change(frame);
  });
  return changed;
}

/** Replaces one base64 character, so the decoded bytes differ in exactly that place. */
function replaceCharacterAt(base64Text: string, position: number) {
  const replacement = base64Text[position] === 'A' ? 'B' : 'A';
  return base64Text.slice(0, position) + replacement + base64Text.slice(position + 1);
}

/** The payload is base64(AES-GCM ciphertext + 16-byte tag): flip in the middle, or in the tag. */
function tamperPayload(frame: string, where: 'middle' | 'tag') {
  const message = JSON.parse(frame) as { payload: string };
  const unpaddedLength = message.payload.replace(/=+$/, '').length;
  const position = where === 'middle' ? Math.floor(unpaddedLength / 2) : unpaddedLength - 3;
  return JSON.stringify({ ...message, payload: replaceCharacterAt(message.payload, position) });
}

async function startCall(alice: Person, bob: Person) {
  const callLink = await createCallLink(alice);
  await openCall(alice, callLink);
  await expect(callStatus(alice)).toHaveText(WAITING_TEXT);
  await openCall(bob, callLink);
  return callLink;
}

test('@every-browser the violation check catches CSP and Trusted Types violations', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  await alice.page.goto('/');
  const supportsTrustedTypes = await alice.page.evaluate(() => {
    // connect-src allows only this site and the signaling server: this must be refused.
    fetch('https://blocked.example/').catch(() => {});
    if (!('trustedTypes' in window)) return false;
    try {
      document.createElement('div').innerHTML = '<b>probe</b>';
    } catch {
      // Refused by Trusted Types, as it must be.
    }
    return true;
  });
  test
    .info()
    .annotations.push({ type: 'Trusted Types', description: String(supportsTrustedTypes) });
  await expect.poll(() => alice.problems.join('\n')).toContain('CSP violation: connect-src');
  if (supportsTrustedTypes) {
    await expect.poll(() => alice.problems.join('\n')).toContain('require-trusted-types-for');
  }
  alice.problems.length = 0; // caught as intended: do not fail afterEach
});

test('@every-browser two people complete an encrypted call, verify it and hang up', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  await startCall(alice, bob);
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
    // The recorder saw the call happen (so its "never" in the tests below means something).
    const history = await readCallHistory(person);
    expect(history.peerConnections).toBe(1);
    // Its certificate was made for it alone and probed first; the probe sent nothing.
    expect(history.fingerprintProbes).toBe(1);
    expect(history.certificatesProbedAndFresh).toBe(true);
    expect(history.probeSetADescription).toBe(false);
    expect(history.everConnected).toBe(true);
    expect(history.remoteVideoFrames).toBe(true);
  }

  // Bob reloads: Alice's side makes a new connection, which must get a new certificate (a man in
  // the middle forcing a reconnect must not learn the next fingerprint from this one).
  await bob.page.reload();
  for (const person of [alice, bob]) await expect(callStatus(person)).toHaveText(CONNECTED_TEXT);
  const aliceAfterRejoin = await readCallHistory(alice);
  expect(aliceAfterRejoin.peerConnections).toBe(2);
  expect(aliceAfterRejoin.fingerprintProbes).toBe(2);
  expect(aliceAfterRejoin.certificatesProbedAndFresh).toBe(true);
  expect(aliceAfterRejoin.probeSetADescription).toBe(false);

  await alice.page.getByRole('button', { name: 'Hang up' }).click();
  await expect(callStatus(bob)).toHaveText(OTHER_PERSON_LEFT_TEXT);
});

for (const tampering of [
  { message: 'the hello', signalIndex: 0, where: 'middle' as const },
  { message: 'a later message', signalIndex: 1, where: 'tag' as const },
]) {
  test(`tampering with ${tampering.message} (${tampering.where === 'tag' ? 'its authentication tag' : 'its ciphertext'}) ends the call before any media flows`, async ({
    browser,
    browserName,
  }) => {
    const alice = await newPerson(browser, browserName, 'Alice');
    const bob = await newPerson(browser, browserName, 'Bob');
    const tampered = await changeNthSignalFrame(bob, tampering.signalIndex, (frame) => [
      tamperPayload(frame, tampering.where),
    ]);
    await startCall(alice, bob);

    await expect(bob.page.getByText(VERIFICATION_FAILED_TEXT)).toBeVisible();
    expect(tampered.count).toBe(1);
    await expectNoMediaEverFlowed(bob);
  });
}

test('a replayed signaling message (after the hello) ends the call before any media flows', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  // Index 1 is the first message after the hello (sequence number 1), delivered twice: only
  // replay protection (the sequence number, authenticated) can refuse the second copy.
  const replayed = await changeNthSignalFrame(bob, 1, (frame) => [frame, frame]);
  await startCall(alice, bob);

  await expect(bob.page.getByText(VERIFICATION_FAILED_TEXT)).toBeVisible();
  expect(replayed.count).toBe(1);
  await expectNoMediaEverFlowed(bob);
});

test('a third person opening the link is told the call is full', async ({
  browser,
  browserName,
}) => {
  const alice = await newPerson(browser, browserName, 'Alice');
  const bob = await newPerson(browser, browserName, 'Bob');
  const carol = await newPerson(browser, browserName, 'Carol');
  const callLink = await startCall(alice, bob);
  await expect(callStatus(alice)).toHaveText(CONNECTED_TEXT);
  await expect(callStatus(bob)).toHaveText(CONNECTED_TEXT);

  await openCall(carol, callLink);
  await expect(carol.page.getByText(ROOM_FULL_TEXT)).toBeVisible();
  await expect(callStatus(alice)).toHaveText(CONNECTED_TEXT);
  expect((await readCallHistory(carol)).peerConnections).toBe(0);
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
  await openCall(bob, callLink);
  await expect(callStatus(bob)).toHaveText(WAITING_TEXT);
  await openCall(alice, callLink);

  await expect(alice.page.getByText(PRIVACY_NEEDS_RELAY_TEXT)).toBeVisible();
  // "leave" is the last thing Alice sends on that socket, so everything she sent is counted.
  await expect.poll(() => typesAliceSent).toContain('leave');
  expect(typesAliceSent).toContain('join');
  expect(typesAliceSent).not.toContain('signal');
  expect((await readCallHistory(alice)).peerConnections).toBe(0);
});
