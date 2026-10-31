#!/usr/bin/env node
/* Cross-app permit contract — this repo is the PRODUCER side.
 *
 * The canonical test lives in greencross-command-center/tests/permit_contract_test.js, because the
 * contract spans two repos and neither owns it. It runs GX Core's real publish/verify code over fake
 * services AND reads Crew's real metrcPermitKey_ out of this repo's Code.gs, so it goes red if a
 * change here makes Crew's normalizer disagree with Core's. This wrapper runs it so THIS repo's
 * pre-push hook is gated by it too: it is Crew's changes that would break it.
 * (tests/permit_publish_test.js is the other half: Crew's publisher sends exactly the contract shape.)
 *
 * Skips cleanly when the hub is not a sibling checkout, or is a checkout from before that test
 * existed. A wrapper that fails because one repo was cloned alone teaches people to bypass the gate,
 * which costs more than the coverage is worth. Same shape as greencross-sales' cross_app_contract_test.js.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const CANON = path.join(__dirname, '..', '..', 'greencross-command-center',
                        'tests', 'permit_contract_test.js');
if (!fs.existsSync(CANON)) {
  console.log('SKIP cross-app permit contract — greencross-command-center is not a sibling checkout with tests/permit_contract_test.js.');
  process.exit(0);
}
try {
  console.log(execFileSync(process.execPath, [CANON], { encoding: 'utf8' }).trim());
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  process.stderr.write(String(e.stderr || ''));
  console.log('\n^ CROSS-APP PERMIT CONTRACT BROKEN. This repo is the PRODUCER.');
  process.exit(1);
}
