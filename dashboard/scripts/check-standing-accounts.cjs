const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repair = 'dashboard/scripts/lib/repair-canary-qa-account.ts';
const repairCallers = new Set([
  'dashboard/scripts/ensure-canary-qa-account.ts',
  'dashboard/__tests__/canary-qa-account.test.ts',
]);
const policyFiles = new Set([
  'dashboard/scripts/check-standing-accounts.cjs',
  'dashboard/scripts/check-standing-accounts.test.cjs',
]);
const source = /\.(?:[cm]?[jt]sx?|py|rb|php|sh|bash|ya?ml|go|rs|swift|java|kt|ps1)$/i;
const member = String.raw`(?:\s*\??\.\s*|\s*(?:\?\.)?\[\s*['"])`;
const sdkCreation = new RegExp(String.raw`\b(?:createUser|createInvitation|createInvitationBulk|createBulkInvitations|createOrganizationInvitation)\b|\b(?:signUp|sign_up|invitations)${member}(?:create|bulk_create|prepareVerification|attemptVerification|prepareEmailAddressVerification|attemptEmailAddressVerification|verifications)\b`);
const clerkUsersCreation = new RegExp(String.raw`\busers${member}create\b`);
const signupRequest = /\/client\/sign_ups\b/;
const clerkResource = /\/v1\/(?:users|invitations|organizations\/[^\s'"`]+\/invitations)(?=[\s'"`?]|$)/;
const relativeResource = /\/(?:users|invitations)(?=[\s'"`?]|$)/;
const clerkBackend = /api\.clerk\.com|@clerk\/backend|clerkFetch\b|CLERK_API\b|\bclerk\b/i;
const writeRequest = /\bmethod\s*[:=]\s*['"]POST['"]|\bpost\s*\(|(?:-X\s*|--request[=\s]+)['"]?POST|(?:\s-d|--data(?:-raw|-binary|-urlencode)?)[=\s]/i;
const signUpRoute = /\/(?:sign-up|sign_up)(?![\w-])|\b(?:venice-promo-claim|cl-signUp|cl-signUp-start|clerk-sign-up)\b/i;
const browserFormInput = /\.\s*(?:fill|type|press|send_keys|sendKeys|fillForm|submit)\s*\(|\b(?:form\.submit|requestSubmit)\b/;
const submitClick = /(?:type\s*=\s*['"]?submit|\bcreate account\b)[^\n;]{0,120}\.\s*click\s*\(/i;
const browserDriver = /playwright|puppeteer|selenium|webdriver|\.\s*(?:goto|getByRole|locator|fill|send_keys|sendKeys)\s*\(/i;

function violations(file, text) {
  if (policyFiles.has(file)) return [];
  const findings = [];
  const clerk = clerkBackend.test(text);
  const resource = clerkResource.test(text) || (clerk && relativeResource.test(text));
  if (sdkCreation.test(text) || (clerk && clerkUsersCreation.test(text)) || signupRequest.test(text) || (
    writeRequest.test(text) && resource && (file !== repair || /\/invitations\b/.test(text))
  )) {
    findings.push('Clerk account or invitation creation');
  }
  if (file !== repair && !repairCallers.has(file) &&
      /\bensureCanaryQaAccount\b|\brepair-canary-qa-account\b|\bqa:canary-account\b|\bensure-canary-qa-account\.ts\b/.test(text)) {
    findings.push('standing-account repair invoked outside its operator entry point');
  }
  if (browserDriver.test(text) && signUpRoute.test(text) && (browserFormInput.test(text) || submitClick.test(text))) {
    findings.push('browser automation fills or submits a sign-up form');
  }
  return findings;
}

function scan(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    .toString().split('\0');
  return [...new Set(files)].filter((file) => source.test(file) || path.basename(file) === 'package.json').flatMap((file) => {
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (path.basename(file) === 'package.json') {
      const scripts = JSON.parse(text).scripts ?? {};
      if (file === 'dashboard/package.json') delete scripts['qa:canary-account'];
      text = Object.values(scripts).join('\n');
    }
    return violations(file, text).map((reason) => `${file}: ${reason}`);
  });
}

if (require.main === module) {
  const findings = scan(path.resolve(__dirname, '../..'));
  if (findings.length) {
    console.error(findings.join('\n'));
    console.error('Tests never create accounts. Sign in as an existing standing Canary test account.');
    process.exitCode = 1;
  }
}

module.exports = { scan, violations };
