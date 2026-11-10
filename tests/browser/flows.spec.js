import { expect, test } from '@playwright/test';

async function openHome(page, baseURL) {
  await page.goto(baseURL);
  await expect(page.locator('#home-screen')).toBeVisible();
}

async function sendMessage(page, text) {
  await page.locator('#msgInput').fill(text);
  await page.locator('#msgInput').press('Enter');
  await expect(page.locator('#chatMessages')).toContainText(text);
}

async function expectConcurrentConnectionSetup(page) {
  const timings = await page.evaluate(() => window.__GHOSTCHAT_TIMINGS || []);
  const peerStart = timings.find((item) => item.name === 'peerjs.initialization.start');
  const sessionAck = timings.find((item) => item.name === 'coordinator.session.ack');
  expect(peerStart).toBeTruthy();
  expect(sessionAck).toBeTruthy();
  expect(peerStart.at).toBeLessThan(sessionAck.at);
  expect(timings.some((item) => item.name === 'coordinator.peer.register')).toBe(false);
}

test('private room: create, approve, chat both ways, and close', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const hostSockets = [];
  host.on('websocket', (socket) => hostSockets.push(socket.url()));

  try {
    await openHome(host, baseURL);
    await openHome(guest, baseURL);
    await expect.poll(() => hostSockets.length).toBe(0);

    await host.locator('#createRoomBtn').click();
    await expect(host.locator('#waiting-screen')).toBeVisible();
    await expectConcurrentConnectionSetup(host);
    const roomCode = (await host.locator('#roomCodeValue').textContent()).trim();
    expect(roomCode).toMatch(/^[A-Z]{4}$/);

    await guest.locator('#joinCodeInput').fill(roomCode);
    await guest.locator('#joinBtn').click();
    await expect(guest.locator('#joining-screen')).toBeVisible();
    await expectConcurrentConnectionSetup(guest);
    await expect(host.locator('#approvalModal')).toBeVisible();
    await expect(host.locator('#approvalMessage')).toHaveText('Another Ghost entered your room code.');
    await host.locator('#acceptJoinBtn').click();

    await expect(host.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(guest.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await sendMessage(host, 'private host message');
    await expect(guest.locator('#chatMessages')).toContainText('private host message');
    await sendMessage(guest, 'private guest reply');
    await expect(host.locator('#chatMessages')).toContainText('private guest reply');

    await host.locator('#endChatBtn').click();
    await expect(host.locator('#ended-screen')).toBeVisible();
    await expect(guest.locator('#lost-screen')).toBeVisible();
    await expect(guest.locator('#chatMessages')).toBeEmpty();
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('secure invitation link joins the active room without manual approval', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  try {
    await openHome(host, baseURL);
    await host.locator('#createRoomBtn').click();
    await expect(host.locator('#waiting-screen')).toBeVisible();
    await host.locator('#copyLinkBtn').click();
    const invitationUrl = await host.evaluate(() => navigator.clipboard.readText());
    expect(invitationUrl).toContain('#join=');
    expect(invitationUrl).toMatch(/&t=[A-Za-z0-9_-]{32}$/);

    await guest.goto(invitationUrl);
    await expect(guest.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(host.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(host.locator('#approvalModal')).toBeHidden();
    await sendMessage(guest, 'invitation link message');
    await expect(host.locator('#chatMessages')).toContainText('invitation link message');
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('matchmaking: pair two users, Next Ghost finds a third, End and Cancel clean up', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [first, second, third] = await Promise.all(contexts.map((context) => context.newPage()));

  try {
    await Promise.all([openHome(first, baseURL), openHome(second, baseURL), openHome(third, baseURL)]);
    await first.locator('#findGhostBtn').click();
    await expect(first.locator('#search-screen')).toBeVisible();
    await second.locator('#findGhostBtn').click();
    await expect(first.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(second.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(first.locator('#nextGhostBtn')).toBeVisible();
    await expect(second.locator('#nextGhostBtn')).toBeVisible();
    await expectConcurrentConnectionSetup(first);
    await expectConcurrentConnectionSetup(second);
    await expect(first.locator('#reportBtn')).toBeVisible();

    await first.locator('#msgInput').fill('typing now');
    await expect(second.locator('#typingIndicator')).toBeVisible();
    await first.locator('#msgInput').fill('');
    await expect(second.locator('#typingIndicator')).toBeHidden();

    await first.locator('#reportBtn').click();
    await first.locator('#reportReason').selectOption('spam');
    await first.locator('#submitReportBtn').click();
    await expect(first.locator('#reportError')).toHaveText('Reporting is not configured for this service.');
    await first.locator('#cancelReportBtn').click();

    await sendMessage(first, 'first match message');
    await expect(second.locator('#chatMessages')).toContainText('first match message');
    await sendMessage(second, 'first match reply');
    await expect(first.locator('#chatMessages')).toContainText('first match reply');

    await first.locator('#nextGhostBtn').click();
    await expect(first.locator('#search-screen')).toBeVisible();
    await expect(second.locator('#lost-screen')).toBeVisible();
    await expect(second.locator('#lostMessage')).toContainText('The other Ghost has left.');
    await expect(first.locator('#chatMessages')).toBeEmpty();

    await third.locator('#findGhostBtn').click();
    await expect(first.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await expect(third.locator('#chat-screen')).toBeVisible({ timeout: 45_000 });
    await sendMessage(third, 'third participant message');
    await expect(first.locator('#chatMessages')).toContainText('third participant message');

    await third.locator('#endChatBtn').click();
    await expect(third.locator('#ended-screen')).toBeVisible();
    await expect(first.locator('#lost-screen')).toBeVisible();

    await second.locator('#homeFromLostBtn').click();
    await second.locator('#findGhostBtn').click();
    await expect(second.locator('#search-screen')).toBeVisible();
    await second.locator('#cancelSearchBtn').click();
    await expect(second.locator('#home-screen')).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});