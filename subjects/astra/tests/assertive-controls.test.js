import test from 'node:test';
import { execFileSync } from 'node:child_process';

// Preserve the archived experiment's component checks without requiring its
// rejected behavior in the production driver.
test('archived 63dd5ce component contracts remain reproducible',()=>{
  execFileSync(process.execPath,['--import','./scripts/ablation-loader.mjs','--test','tests/ablation-components.fixture.js'],{
    env:{...process.env,ASTRA_ABLATION:'combined'},stdio:'pipe'});
});
