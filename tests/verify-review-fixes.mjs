import { chromium } from 'playwright';

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ PASS: ${msg}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`);
  });

  console.log('=== 1. Testing Issue #1: Automatic Modal Yielding on Guest Login Modal ===');
  await page.goto('http://localhost:3000/?speak=0', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.VoiceLayer && window.VoiceLayer.__loaded);
  await page.waitForTimeout(900); // allow Behavior.updateViewport interval to detect open login modal

  const modalYieldState = await page.evaluate(() => {
    const host = document.querySelector('#voicelayer-root');
    const root = host?.shadowRoot?.querySelector('.vl-root');
    const hasPwdForm = !!document.querySelector('input[type="password"]');
    return {
      hasLoginScreen: hasPwdForm,
      dataOpen: root ? root.getAttribute('data-open') : null
    };
  });
  assert(modalYieldState.hasLoginScreen && modalYieldState.dataOpen === 'false', `VoiceLayer automatically yields (data-open="${modalYieldState.dataOpen}") while host login screen is open`);

  // Enter the dashboard as guest tester
  const skipBtn = page.locator('button:has-text("Skip")').first();
  if (await skipBtn.isVisible()) {
    await skipBtn.click();
  } else {
    const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').first();
    if (await signInBtn.isVisible()) await signInBtn.click();
  }
  await page.waitForTimeout(500);

  // If FirstRunConsent dialog is open, verify VoiceLayer ALSO stays yielded (data-open="false") over the consent dialog, then sign & close it
  const consentDialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  if (await consentDialog.isVisible()) {
    const duringConsentOpen = await page.evaluate(() => {
      const host = document.querySelector('#voicelayer-root');
      const root = host?.shadowRoot?.querySelector('.vl-root');
      return root ? root.getAttribute('data-open') : null;
    });
    assert(duringConsentOpen === 'false', `VoiceLayer stays yielded (data-open="${duringConsentOpen}") while FirstRunConsent dialog is open`);

    const checkboxes = consentDialog.locator('input[type="checkbox"]');
    const cbCount = await checkboxes.count();
    for (let i = 0; i < cbCount; i++) {
      await checkboxes.nth(i).check();
    }
    const sigInput = consentDialog.locator('#firstrun-signature, input[type="text"]').first();
    if (await sigInput.isVisible()) await sigInput.fill('Alex Rivera');
    const submitConsentBtn = consentDialog.locator('button[type="submit"]').first();
    if (await submitConsentBtn.isVisible()) await submitConsentBtn.click();
  }
  await page.waitForTimeout(900);

  // Verify VoiceLayer automatically un-yielded once login + consent modals closed
  const afterLoginState = await page.evaluate(() => {
    const host = document.querySelector('#voicelayer-root');
    const root = host?.shadowRoot?.querySelector('.vl-root');
    return {
      dataOpen: root ? root.getAttribute('data-open') : null
    };
  });
  assert(afterLoginState.dataOpen === 'true', `VoiceLayer automatically restores HUD (data-open="${afterLoginState.dataOpen}") after login & consent modals close`);

  // Wake VoiceLayer
  await page.evaluate(async () => {
    await window.VoiceLayer.wake();
  });
  await page.waitForFunction(() => window.VoiceLayer.state === 'idle' || window.VoiceLayer.state === 'listening', { timeout: 8000 });

  const runCmd = async (text) => {
    await page.evaluate(async (q) => {
      await window.VoiceLayer.run(q);
    }, text);
    await page.waitForFunction(() => window.VoiceLayer.state === 'idle' || window.VoiceLayer.state === 'listening', { timeout: 8000 });
    return page.evaluate(() => {
      const host = document.querySelector('#voicelayer-root');
      const gLine = host?.shadowRoot?.querySelector('#vl-g-line');
      return gLine ? gLine.textContent.trim() : '';
    });
  };

  console.log('\n=== 2. Testing Issue #2: "what does CuasarX do?" (Site Overview vs Catalog Price Hijack) ===');
  let reply = await runCmd('what does CuasarX do?');
  assert(!/couldn’t find “cuasarx” in the catalog/i.test(reply) && /CuasarX|wellness|longevity|protocols|marketplace/i.test(reply), `"what does CuasarX do?" answers from site overview instead of catalog price miss: "${reply}"`);

  console.log('\n=== 3. Testing Issue #3: Weather Wording ("overcast" + raining=true) ===');
  await page.evaluate(() => {
    window.VoiceLayer.setWeather({ city: 'Miami', tempF: 78, tempC: 26, raining: true, dry: false, condition: { en: 'overcast', es: 'nublado' } });
  });
  reply = await runCmd('how is the weather today?');
  assert(/overcast/i.test(reply) && /chance of rain/i.test(reply) && !/raining right now/i.test(reply), `"how is the weather today?" with overcast + raining=true says "with a chance of rain today": "${reply}"`);

  console.log('\n=== 4. Testing Issue #4: SPA Navigation Scan & Unambiguous "go to profile" / "go to trends" ===');
  const navScan = await page.evaluate(() => window.VoiceLayer.scan().nav);
  assert(navScan.length >= 5 && navScan.some(n => /Organ Longevity|Profile/i.test(n.text)) && navScan.some(n => /Featured Curation|Curate|Marketplace/i.test(n.text)), `Scanner.json().nav captures SPA top-bar buttons (${navScan.slice(0, 10).map(n => n.text).join(', ')}...)`);

  reply = await runCmd('go to profile');
  assert(!/I found \d+ places/i.test(reply) && /Going to (?:Organ Longevity \(AOSM\)|(?:Manage Biomarker )?Profile)/i.test(reply), `"go to profile" navigates directly to Profile tab without disambiguation prompt: "${reply}"`);

  reply = await runCmd('go to trends');
  assert(!/I found \d+ places/i.test(reply) && /Going to (?:Lab Telemetry|Labs|Trends)/i.test(reply), `"go to trends" navigates directly to Lab Telemetry / Trends tab without disambiguation prompt: "${reply}"`);

  reply = await runCmd('go to marketplace');
  assert(!/I found \d+ places/i.test(reply) && /Going to (?:Featured Curation|Curate|Marketplace)/i.test(reply), `"go to marketplace" navigates to Featured Curation / Marketplace tab: "${reply}"`);
  await page.waitForTimeout(300);

  console.log('\n=== 5. Testing Issue #5: Verified Cart Read-Back on SPA Cart + Multi-Quantity Briefing ===');
  const cartBefore = await page.evaluate(() => window.VoiceLayer.inventory.cart.count);
  reply = await runCmd('add Creatine Monohydrate to cart');
  const lastReceipt = await page.evaluate(() => window.VoiceLayer.receipts.slice(-1)[0]);
  const cartAfter = await page.evaluate(() => window.VoiceLayer.inventory.cart.count);
  assert(/cart( count)? went from 3 to 4/i.test(reply) && lastReceipt?.verified === true && cartAfter === cartBefore + 1, `"add Creatine Monohydrate to cart" verifies cart count ${cartBefore} -> ${cartAfter} with read_back receipt: "${reply}"`);

  await runCmd('add Magnesium Glycinate to cart');
  reply = await runCmd('what do I have pending to buy?');
  assert(/\d+× Magnesium Glycinate/i.test(reply), `"what do I have pending to buy?" includes multi-quantity prefix "N× Magnesium Glycinate": "${reply}"`);

  console.log('\n=== 6. Testing Issue #7: Automatic Spanish Response for Spanish Questions in Default Mode ===');
  reply = await runCmd('¿Qué tengo pendiente hoy?');
  assert(/Pendiente por tomar|En tu calendario|Tiempo hoy/i.test(reply), `Spanish question "¿Qué tengo pendiente hoy?" receives full Spanish briefing response: "${reply}"`);

  reply = await runCmd('¿Cómo dormí anoche?');
  assert(/dormiste|horas|sueño|puntuación/i.test(reply), `Spanish question "¿Cómo dormí anoche?" receives Spanish sleep telemetry response: "${reply}"`);

  console.log('\n=== 7. Testing Issue #6: Multi-User Isolation When Switching Users ===');
  await page.evaluate(() => {
    window.VoiceLayer.setUser('user-sarah-2', {
      name: 'Sarah Jenkins',
      goal: 'Ironman Prep',
      details: {
        appointments: [{ title: 'VO2 Max Lab Test', time: '11:00 AM', provider: 'Coach Miller', location: 'Performance Lab' }],
        trainingPlan: { todayWorkout: 'Swim 3000m + Bike 45min', duration: '90 min', intensity: 'Zone 3' },
        activeRegimen: [{ name: 'Electrolyte Pro', dosage: '1 scoop', timing: 'Pre-workout', takenToday: false, daysRemaining: 3 }]
      }
    });
  });

  reply = await runCmd('what is on my calendar today?');
  assert(/VO2 Max Lab Test/i.test(reply) && /Swim 3000m/i.test(reply) && !/Dr\. Chen/i.test(reply), `After switching to Sarah Jenkins, calendar reports Sarah's events and NOT John's Dr. Chen appointment: "${reply}"`);

  reply = await runCmd('what do I have pending to take?');
  assert(/Electrolyte Pro/i.test(reply) && !/Whey Protein/i.test(reply), `After switching to Sarah Jenkins, pending to take reports Sarah's Electrolyte Pro and NOT John's Whey Protein: "${reply}"`);

  reply = await runCmd('what do I have pending to buy?');
  assert(/Electrolyte Pro \(3 days left\)/i.test(reply) && !/BPC-157/i.test(reply), `After switching to Sarah Jenkins, pending to buy reports Sarah's Electrolyte Pro refill and NOT John's BPC-157: "${reply}"`);

  console.log('\n=== 8. Testing Issue #8: Cross-Origin Demand Beacon & Zero Console/Network Errors ===');
  await runCmd('is quantum hyperbaric pod in stock?'); // triggers unmatched_product beacon
  await page.waitForTimeout(400);

  const corsOr502Errors = consoleErrors.filter(e => /CORS|502|beacon|token/i.test(e));
  const beaconFailures = failedRequests.filter(r => /beacon|token/i.test(r));
  assert(corsOr502Errors.length === 0 && beaconFailures.length === 0, `Zero CORS or 502 errors on /api/voice/beacon and /api/voice/token (consoleErrors=${JSON.stringify(corsOr502Errors)}, failedRequests=${JSON.stringify(beaconFailures)})`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
